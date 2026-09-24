import type {
  Diagnostic, FlatDevice, FlatNetlist, FlatParam, HierNode,
  NormalizedValue, ParamProvenance, RawParam, RawStatement, SourceFile,
} from './types';
import { parseSource, type ParsedSource } from './parser';
import { normalizeNumber, unitFor } from './units';
import { evalExpr, type Scope } from './expr';

export interface SubcktDef {
  name: string;
  ports: string[];
  defaults: RawParam[];
  body: RawStatement[];
  sourceId: string;
  line: number;
  shadowed?: boolean; // 重名被遮蔽（仍保留，不删除）
}

export interface Registry {
  subckts: Map<string, SubcktDef[]>; // 重名全部保留
  models: Map<string, { type: string; params: RawParam[]; sourceId: string; line: number }>;
  globals: RawParam[];
  diagnostics: Diagnostic[];
  includeEdges: { from: string; to: string; cyclic: boolean }[];
}

let diagSeq = 0;
function diag(severity: Diagnostic['severity'], kind: string, message: string, at: Diagnostic['at']): Diagnostic {
  return { id: `diag:${kind}:${++diagSeq}`, severity, kind, message, at };
}

// 构建 include 图并解析全部来源；循环 include 保留为诊断，不递归展开。
export function buildRegistry(
  sources: SourceFile[],
  tops: string[],
): { registry: Registry; parsed: Map<string, ParsedSource> } {
  diagSeq = 0;
  const byPath = new Map(sources.map(s => [s.path, s]));
  const parsed = new Map<string, ParsedSource>();
  const diagnostics: Diagnostic[] = [];
  const includeEdges: Registry['includeEdges'] = [];

  const visit = (src: SourceFile, stack: string[]) => {
    if (parsed.has(src.id)) return;
    const p = parseSource(src);
    parsed.set(src.id, p);
    for (const st of p.statements) {
      if (st.kind === 'include' && st.includeTarget) {
        const target = byPath.get(st.includeTarget);
        if (!target) {
          diagnostics.push(diag('warn', 'include-missing',
            `include 目标缺失: ${st.includeTarget}`, { sourceId: src.id, line: st.lineStart }));
          continue;
        }
        const cyclic = stack.includes(target.id) || target.id === src.id;
        includeEdges.push({ from: src.id, to: target.id, cyclic });
        if (cyclic) {
          diagnostics.push(diag('warn', 'include-cycle',
            `循环 include: ${[...stack, src.id, target.id].join(' -> ')}`, { sourceId: src.id, line: st.lineStart }));
          continue; // 不递归展开，来源关系保留
        }
        visit(target, [...stack, src.id]);
      }
    }
  };
  for (const t of tops) {
    const src = byPath.get(t) ?? sources.find(s => s.id === t);
    if (src) visit(src, []);
  }

  const registry: Registry = {
    subckts: new Map(), models: new Map(), globals: [], diagnostics, includeEdges,
  };

  // 按解析顺序注册；重名保留全部，首个生效，其余标记 shadowed
  for (const [, p] of parsed) {
    let cur: SubcktDef | null = null;
    for (const st of p.statements) {
      if (st.kind === 'subckt' && st.name) {
        cur = {
          name: st.name, ports: st.ports ?? [], defaults: st.params ?? [],
          body: [], sourceId: p.source.id, line: st.lineStart,
        };
        const list = registry.subckts.get(st.name) ?? [];
        if (list.length > 0) {
          cur.shadowed = true;
          diagnostics.push(diag('warn', 'subckt-collision',
            `子电路重名 "${st.name}": ${list[0].sourceId}:${list[0].line} 生效，` +
            `${cur.sourceId}:${cur.line} 被遮蔽（保留不删除）`,
            { sourceId: cur.sourceId, line: cur.line }));
        }
        list.push(cur);
        registry.subckts.set(st.name, list);
      } else if (st.kind === 'ends') {
        cur = null;
      } else if (cur) {
        cur.body.push(st);
      } else if (st.kind === 'param') {
        registry.globals.push(...(st.params ?? []));
      } else if (st.kind === 'model' && st.name) {
        if (!registry.models.has(st.name)) {
          registry.models.set(st.name, {
            type: st.modelType ?? '', params: st.params ?? [],
            sourceId: p.source.id, line: st.lineStart,
          });
        } else {
          diagnostics.push(diag('info', 'model-duplicate',
            `model "${st.name}" 重复定义，保留首版（model 版本不改写）`,
            { sourceId: p.source.id, line: st.lineStart }));
        }
      }
    }
  }
  return { registry, parsed };
}

interface Ctx {
  registry: Registry;
  diagnostics: Diagnostic[];
  devices: FlatDevice[];
  scopeChain: Scope[];           // 全局 -> 外层 -> 内层
  provChain: ParamProvenance['scopePath'];
  instancePath: string[];
  netMap: Map<string, string>;   // 局部网 -> 展平网
  expanding: string[];           // 子电路递归栈（防循环实例化）
}

function resolveParam(
  name: string, rawExpr: string, deps: string[],
  ctx: Ctx, origin: ParamProvenance['origin'],
  definedAt: ParamProvenance['definedAt'],
  overridden: ParamProvenance | undefined,
  deviceKind: string,
): FlatParam {
  // 先尝试直接数值
  let norm: NormalizedValue = normalizeNumber(rawExpr);
  if (norm.unconvertible) {
    // 表达式：沿作用域链求值
    const v = evalExpr(rawExpr, ctx.scopeChain);
    if (v !== undefined) {
      norm = { raw: rawExpr, value: v };
    } else {
      // 无法转换：留在原位置并附诊断
      norm = { raw: rawExpr, unconvertible: true };
      ctx.diagnostics.push(diag('warn', 'param-unresolvable',
        `参数 ${name}=${rawExpr} 无法求值（依赖未定义或不可转换），保留原始表示`,
        { sourceId: definedAt?.sourceId, line: definedAt?.line }));
    }
  }
  if (norm.value !== undefined) norm.unit = unitFor(deviceKind, name);
  const provenance: ParamProvenance = {
    scopePath: [...ctx.provChain],
    definedAt, origin, overridden,
  };
  return { name, raw: rawExpr, norm, deps, provenance };
}

function flattenBody(
  def: SubcktDef | null, // null = 顶层
  topStatements: RawStatement[] | null,
  ctx: Ctx,
  hier: HierNode,
): void {
  const body = def ? def.body : (topStatements ?? []);
  for (const st of body) {
    if (st.kind === 'instance' && st.subckt) {
      const defs = ctx.registry.subckts.get(st.subckt);
      const active = defs?.find(d => !d.shadowed);
      if (!active) {
        ctx.diagnostics.push(diag('error', 'subckt-undefined',
          `实例 ${st.name} 引用未定义子电路 ${st.subckt}，保留 opaque 连接`,
          { sourceId: st.sourceId, line: st.lineStart }));
        ctx.devices.push({
          id: [...ctx.instancePath, st.name ?? '?'].join('/'),
          kind: 'opaque:X', model: st.subckt,
          pins: (st.nodes ?? []).map(n => mapNet(n, ctx)),
          params: [], opaque: true,
          rawRef: { sourceId: st.sourceId, stmtId: st.id, line: st.lineStart },
          instancePath: [...ctx.instancePath],
        });
        continue;
      }
      if (ctx.expanding.includes(active.name)) {
        ctx.diagnostics.push(diag('error', 'subckt-recursion',
          `子电路递归实例化 ${active.name}，保留 opaque 连接`,
          { sourceId: st.sourceId, line: st.lineStart }));
        continue;
      }
      // 端口映射：实例节点 -> 子电路端口
      const instPath = [...ctx.instancePath, st.name ?? '?'];
      const childCtx: Ctx = {
        ...ctx,
        instancePath: instPath,
        provChain: [...ctx.provChain, `${st.name}(${active.name})`],
        netMap: new Map(),
        expanding: [...ctx.expanding, active.name],
        scopeChain: [...ctx.scopeChain],
      };
      // 子电路默认值进入作用域（低优先级），实例覆盖（高优先级）
      const defaultScope: Scope = new Map();
      const overrideScope: Scope = new Map();
      const childParams: FlatParam[] = [];
      for (const d of active.defaults) {
        const v = evalExpr(d.rawExpr, ctx.scopeChain);
        if (v !== undefined) defaultScope.set(d.name, v);
        childParams.push(resolveParam(d.name, d.rawExpr, d.deps, ctx, 'subckt-default',
          { sourceId: active.sourceId, line: active.line }, undefined, 'X'));
      }
      for (const o of st.params ?? []) {
        const v = evalExpr(o.rawExpr, ctx.scopeChain);
        if (v !== undefined) overrideScope.set(o.name, v);
        const defProv = active.defaults.find(d => d.name === o.name);
        childParams.push(resolveParam(o.name, o.rawExpr, o.deps, ctx, 'instance-override',
          { sourceId: st.sourceId, line: st.lineStart },
          defProv ? {
            scopePath: [...ctx.provChain, `${st.name}(${active.name})`],
            definedAt: { sourceId: active.sourceId, line: active.line },
            origin: 'subckt-default',
          } : undefined, 'X'));
      }
      childCtx.scopeChain = [...ctx.scopeChain, defaultScope, overrideScope];
      // 端口 -> 实例节点映射
      active.ports.forEach((port, i) => {
        const outer = st.nodes?.[i];
        if (outer !== undefined) childCtx.netMap.set(port, mapNet(outer, ctx));
      });
      const childHier: HierNode = {
        name: active.name, instanceId: instPath.join('/'),
        children: [], sourceId: active.sourceId, line: active.line,
      };
      hier.children.push(childHier);
      // 实例参数作为器件级记录（参数来源可追溯）
      if (childParams.length > 0) {
        ctx.devices.push({
          id: instPath.join('/'), kind: 'X', model: active.name,
          pins: (st.nodes ?? []).map(n => mapNet(n, ctx)),
          params: childParams, opaque: false,
          rawRef: { sourceId: st.sourceId, stmtId: st.id, line: st.lineStart },
          instancePath: [...ctx.instancePath],
        });
      }
      // childCtx 与 ctx 共享 devices/diagnostics 数组，子层直接写入
      flattenBody(active, null, childCtx, childHier);
    } else if (st.kind === 'element' && st.name) {
      const letter = st.head ?? '?';
      const known = 'RCLVGIFEHBKQTUDMSAYJZ'.includes(letter);
      const params: FlatParam[] = [];
      // 无名字的裸值（如 R1 a b 1k）作为 value 参数
      const rawToks = st.raw.split('\n').join(' ').trim().split(/\s+/);
      const valueToks = rawToks.slice(1 + (st.nodes?.length ?? 0))
        .filter(t => !t.includes('=') && t.toLowerCase() !== (st.model ?? ''));
      if (valueToks.length > 0 && !st.unknown) {
        const rawExpr = valueToks[0];
        params.push(resolveParam('value', rawExpr, [], ctx, 'builtin-default',
          { sourceId: st.sourceId, line: st.lineStart }, undefined, letter));
      }
      for (const p of st.params ?? []) {
        params.push(resolveParam(p.name, p.rawExpr, p.deps, ctx, 'instance-override',
          { sourceId: st.sourceId, line: st.lineStart }, undefined, letter));
      }
      ctx.devices.push({
        id: [...ctx.instancePath, st.name].join('/'),
        kind: known ? letter : `opaque:${letter}`,
        model: st.model,
        pins: (st.nodes ?? []).map(n => mapNet(n, ctx)),
        params, opaque: !known,
        rawRef: { sourceId: st.sourceId, stmtId: st.id, line: st.lineStart },
        instancePath: [...ctx.instancePath],
      });
    } else if (st.kind === 'param' && !def) {
      // 顶层 .param 已在 registry.globals
    }
  }
}

function mapNet(local: string, ctx: Ctx): string {
  const mapped = ctx.netMap.get(local);
  if (mapped) return mapped;
  if (ctx.instancePath.length === 0) return local;
  // 局部网：层次路径
  return [...ctx.instancePath, local].join('/');
}

export function flattenNetlist(
  topPath: string,
  sources: SourceFile[],
  registry: Registry,
  parsed: Map<string, ParsedSource>,
): FlatNetlist {
  const diagnostics: Diagnostic[] = [];
  const src = sources.find(s => s.path === topPath || s.id === topPath);
  if (!src) throw new Error(`top not found: ${topPath}`);
  const p = parsed.get(src.id) ?? parseSource(src);
  const globalScope: Scope = new Map();
  for (const g of registry.globals) {
    const v = evalExpr(g.rawExpr, [globalScope]);
    if (v !== undefined) globalScope.set(g.name, v);
    else diagnostics.push(diag('warn', 'param-unresolvable',
      `全局参数 ${g.name}=${g.rawExpr} 无法求值，保留原始表示`,
      { sourceId: src.id }));
  }
  const hier: HierNode = { name: 'top', instanceId: 'top', children: [], sourceId: src.id };
  const ctx: Ctx = {
    registry, diagnostics, devices: [],
    scopeChain: [globalScope], provChain: ['top'],
    instancePath: [], netMap: new Map(), expanding: [],
  };
  flattenBody(null, p.statements.filter(s => s.kind !== 'include'), ctx, hier);
  const nets = [...new Set(ctx.devices.flatMap(d => d.pins))];
  return {
    top: src.id, devices: ctx.devices, nets, hierarchy: hier,
    diagnostics: [...registry.diagnostics, ...diagnostics],
  };
}
