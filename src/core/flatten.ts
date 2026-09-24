// 层次展平：
//  - 节点/实例通过层次路径形成稳定身份（可 alpha-rename 的基础）
//  - 参数按 实例覆盖 → 子电路默认 → 全局 的作用域链求值；默认值与表达式依赖不被压平
//  - 重名子电路：同 catalog 多版本，按 include/定义顺序后者激活，冲突留痕
//  - unknown 元件保留 opaque 连接（terminal 不删除）
import { shortId } from './hash.js';
import { parseFile } from './parser.js';
import { buildResolvedParam, type ScopeFrame } from './expressions.js';
import type {
  Diagnostic, FileSource, FlatComponent, FlatNode, FlattenedNetlist,
  ModelVersion, ParsedFile, RawElement, RawSubckt, ResolvedParam, TextSpan,
} from '../shared/types.js';
import { resolveIncludes } from './include.js';

export interface FlattenInput {
  root: FileSource;
  files: FileSource[]; // 含 root 与全部 include/library
}

export function makeFileId(path: string, rawText: string): string {
  return shortId('file', path + '|' + rawText.length + '|' + rawText.slice(0, 64));
}

interface SubcktEntry {
  def: RawSubckt;
  fileId: string;
  order: number;
}

export function flatten(input: FlattenInput): FlattenedNetlist {
  const parsed: ParsedFile[] = input.files.map((f) => parseFile(f));
  const byId = new Map(parsed.map((p) => ({ p, id: p.source.fileId })).map((x) => [x.id, x.p]));
  const roots = [byId.get(input.root.fileId)!].filter(Boolean) as ParsedFile[];
  const pathMap = new Map(parsed.map((p) => [p.source.path, p]));
  const includeResolution = resolveIncludes(roots, pathMap);

  const diagnostics: Diagnostic[] = parsed.flatMap((p) => p.diagnostics);

  // include 顺序中的模型目录
  const modelCatalog = new Map<string, { versions: ModelVersion[]; activeVersionId: string }>();
  let modelOrder = 0;
  for (const fid of includeResolution.order) {
    const pf = byId.get(fid)!;
    for (const m of pf.models) {
      const mv: ModelVersion = {
        id: m.id,
        name: m.name,
        type: m.type,
        paramsRaw: m.paramTokens,
        span: m.span,
        order: modelOrder++,
      };
      const entry = modelCatalog.get(m.name) ?? { versions: [], activeVersionId: '' };
      entry.versions.push(mv);
      entry.activeVersionId = mv.id; // 后定义激活，旧版本保留
      modelCatalog.set(m.name, entry);
    }
  }

  // 子电路目录（重名留痕）
  const subByName = new Map<string, SubcktEntry[]>();
  let subOrder = 0;
  for (const fid of includeResolution.order) {
    const pf = byId.get(fid)!;
    for (const s of pf.subckts) {
      const arr = subByName.get(s.name) ?? [];
      arr.push({ def: s, fileId: fid, order: subOrder++ });
      subByName.set(s.name, arr);
    }
  }
  for (const [, arr] of subByName) {
    if (arr.length > 1) {
      diagnostics.push({
        code: 'SUBCKT_COLLISION',
        severity: 'warning',
        message: `子电路重名 ${arr[0]!.def.nameRaw}：${arr.length} 个定义，按顺序后者激活，旧定义保留可追溯`,
      });
    }
  }

  // 全局参数（顶层 .param，按文件顺序；保留表达式依赖，按全局帧求值）
  const globalFrame: ScopeFrame = [];
  const globalParams: ResolvedParam[] = [];
  for (const fid of includeResolution.order) {
    const pf = byId.get(fid)!;
    for (const ctl of pf.controls) {
      if (ctl.kind !== 'param') continue;
      for (const tok of ctl.tokens) {
        const eq = tok.indexOf('=');
        const keyRaw = tok.slice(0, eq);
        const raw = tok.slice(eq + 1);
        const rp = buildResolvedParam(keyRaw.toUpperCase(), keyRaw, raw, ctl.span, [globalFrame],
          { key: keyRaw, valueRaw: raw, kind: 'global', span: ctl.span });
        globalParams.push(rp);
        upsertFrame(globalFrame, keyRaw.toUpperCase(), keyRaw, raw, 'global');
      }
    }
  }

  const nodes: FlatNode[] = [];
  const components: FlatComponent[] = [];
  const nodeIndex = new Map<string, FlatNode>();
  const node0 = '0';
  ensureGlobalNode(node0);

  function ensureGlobalNode(name: string): FlatNode {
    const id = `n::${name}`;
    let n = nodeIndex.get(id);
    if (!n) {
      n = { id, path: '', name, isPort: false };
      nodeIndex.set(id, n);
      nodes.push(n);
    }
    return n;
  }

  function resolveNode(name: string, path: string[], portBindings?: Map<string, FlatNode>): FlatNode {
    if (name === '0' || name.toUpperCase() === 'GND') return ensureGlobalNode(name);
    if (portBindings?.has(name)) return portBindings.get(name)!;
    const id = `n::${path.join('/')}::${name}`;
    let n = nodeIndex.get(id);
    if (!n) {
      n = { id, path: path.join('/'), name, isPort: false };
      nodeIndex.set(id, n);
      nodes.push(n);
    }
    return n;
  }

  function activeSub(name: string): SubcktEntry | undefined {
    const arr = subByName.get(name.toUpperCase());
    if (!arr || arr.length === 0) return undefined;
    return arr[arr.length - 1];
  }

  function expandInstance(
    el: RawElement,
    filePath: string[],
    parentPath: string[],
    portBindings: Map<string, FlatNode>,
    parentFrames: ScopeFrame[],
  ): void {
    const instPath = [...parentPath, el.name];
    const subName = el.modelToken!;
    const entry = activeSub(subName);
    if (!entry) {
      diagnostics.push({
        code: 'MISSING_SUBCKT',
        severity: 'error',
        message: `实例 ${el.name} 引用的子电路 ${subName} 无定义，连接按原文保留为 opaque`,
        span: el.span,
      });
      // 连接仍保留
      const comp = buildComponent(el, filePath, instPath, portBindings, parentFrames, true);
      components.push(comp);
      return;
    }
    const sub = entry.def;

    // 实例参数帧（覆盖）；键的规范大写，作用域链顺序不可压平
    const instanceFrame: ScopeFrame = el.rawParamTokens.map((tok) => {
      const eq = tok.indexOf('=');
      return { key: tok.slice(0, eq).toUpperCase(), raw: tok.slice(eq + 1), source: 'instance-override' as const };
    });

    // 默认值帧（表达式可引用 实例参数/其它默认/全局；依赖记录）
    const defaultFrame: ScopeFrame = sub.params.map((p) => ({
      key: p.key, raw: p.valueRaw, source: 'default' as const,
    }));

    const frames: ScopeFrame[] = [instanceFrame, defaultFrame, ...parentFrames, globalFrame];

    // 端口绑定
    const childBindings = new Map<string, FlatNode>();
    sub.ports.forEach((port, i) => {
      const wire = el.nodeTokens[i];
      if (wire === undefined) {
        diagnostics.push({
          code: 'PORT_ARITY',
          severity: 'error',
          message: `实例 ${el.name} 缺少端口 ${port} 的连接`,
          span: el.span,
        });
        return;
      }
      childBindings.set(port, resolveNode(wire, parentPath, portBindings));
    });

    const subParsed = byId.get(entry.fileId)!;
    for (const bodyId of sub.bodyElementIds) {
      const bodyEl = subParsed.elements.find((e) => e.id === bodyId);
      if (!bodyEl) continue;
      if (bodyEl.kind === 'X') {
        expandInstance(bodyEl, [...filePath, entry.fileId], instPath, childBindings, frames);
      } else {
        const comp = buildComponent(bodyEl, [...filePath, entry.fileId], instPath, childBindings, frames, false);
        components.push(comp);
      }
    }
  }

  function buildComponent(
    el: RawElement,
    filePath: string[],
    instPath: string[],
    bindings: Map<string, FlatNode>,
    frames: ScopeFrame[],
    missingSub: boolean,
  ): FlatComponent {
    const id = `c::${instPath.join('/')}::${el.name}`;
    const terminals = el.nodeTokens.map((raw) => ({
      nodeId: resolveNode(raw, instPath, bindings).id,
      raw,
    }));

    const params: ResolvedParam[] = el.rawParamTokens.map((tok) => {
      const eq = tok.indexOf('=');
      const keyRaw = tok.slice(0, eq);
      const raw = tok.slice(eq + 1);
      return buildResolvedParam(keyRaw.toUpperCase(), keyRaw, raw, el.span, frames,
        { key: keyRaw, valueRaw: raw, kind: 'instance-override', span: el.span, instancePath: instPath.join('/') });
    });
    if (el.valueToken) {
      params.push(buildResolvedParam('VALUE', el.valueToken, el.valueToken, el.span, frames,
        { key: 'VALUE', valueRaw: el.valueToken, kind: 'literal', span: el.span, instancePath: instPath.join('/') }));
    }

    let model: FlatComponent['model'];
    if (el.modelToken && el.kind !== 'X' && !missingSub) {
      const cat = modelCatalog.get(el.modelToken.toUpperCase());
      model = {
        name: el.modelToken,
        activeVersionId: cat?.activeVersionId,
        versions: cat?.versions.map((v) => v.id) ?? [],
      };
    }

    return {
      id,
      path: instPath,
      localElementId: el.id,
      name: el.name,
      kind: el.kind,
      terminals,
      model,
      params,
      opaqueSignature: el.opaqueSignature,
      unknown: el.kind === 'unknown' || missingSub,
    };
  }

  // 顶层元件
  const rootParsed = byId.get(input.root.fileId)!;
  for (const el of rootParsed.elements) {
    if (el.kind === 'X') {
      expandInstance(el, [input.root.fileId], [], new Map(), []);
    } else {
      components.push(buildComponent(el, [input.root.fileId], [], new Map(), [globalFrame], false));
    }
  }

  // 循环/missing include 诊断
  for (const cyc of includeResolution.cycles) {
    diagnostics.push({
      code: 'CIRCULAR_INCLUDE',
      severity: 'error',
      message: `检测到循环 include：${cyc.join(' -> ')}，已在重复处停止展开`,
    });
  }
  for (const miss of includeResolution.missing) {
    diagnostics.push({
      code: 'MISSING_INCLUDE',
      severity: 'error',
      message: `include 无法解析：${miss.path}（来源行 ${miss.atLine}）`,
    });
  }

  return {
    rootFileId: input.root.fileId,
    includeResolution,
    nodes: nodes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    components: components.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    subcktDefs: [...subByName.entries()].map(([, arr]) => ({
      id: arr[arr.length - 1]!.def.id,
      name: arr[arr.length - 1]!.def.name,
      portCount: arr[arr.length - 1]!.def.ports.length,
    })),
    modelCatalog: [...modelCatalog.entries()].map(([name, v]) => ({ name, ...v })),
    globalParams,
    diagnostics,
  };
}

function upsertFrame(frame: ScopeFrame, key: string, _keyRaw: string, raw: string, source: 'global') {
  const idx = frame.findIndex((p) => p.key === key);
  const entry = { key, raw, source };
  if (idx >= 0) frame[idx] = entry;
  else frame.push(entry);
}
