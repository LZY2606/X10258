// 展平层：在不压平参数作用域的前提下，展开层次为 FlatNetwork。
// - 节点/实例的展平 uid 是稳定的层次坐标（后续允许 alpha-rename）。
// - 每个实例持有独立参数帧：实例覆盖 -> 子电路默认 -> 上层参数（默认值不被覆盖冲掉）。
// - 表达式依赖保留原始引用链；无法求值保留 unresolved。
// - 未知元件保留 opaque 连接，绝不删除。
import { flatUid, nodeUid } from './ids.js';
import { parseExpr, exprDeps, evalExpr } from './expr.js';
import { parseQuantity } from './quantity.js';
import type {
  Diagnostic, FlatDevice, FlatNetwork, HierarchyNode,
  ParamOrigin, ParamValue, Quantity, RawDevice, RawSubckt,
  ScopeChain, SourceBundle, UnitTag, DeviceKind
} from './types.js';
import { buildRegistry } from './parser.js';

export interface FlattenOptions {
  /** 决策层：对重名子电路/模型选择特定定义 id；未给出取最后加载。 */
  subcktChoice?: Record<string, string>;
  modelChoice?: Record<string, string>;
}

interface Frame {
  path: string;
  params: Map<string, ParamValue>;
  parent: string | null;
}

const VALUE_CONTEXT: Partial<Record<DeviceKind, UnitTag['context']>> = {
  R: 'resistance', C: 'capacitance', L: 'inductance',
  V: 'voltage', I: 'current'
};

export function flatten(bundle: SourceBundle, opts: FlattenOptions = {}): FlatNetwork {
  const registry = buildRegistry(bundle.statements);
  const diagnostics: Diagnostic[] = [];
  const devices: FlatDevice[] = [];
  const hierarchy: HierarchyNode[] = [];
  const scopes: Record<string, ScopeChain> = {};
  const nodeTokens: Record<string, string> = {};

  const chooseSubckt = (name: string): RawSubckt => {
    const list = registry.subckts.get(name.toUpperCase()) ?? [];
    const picked = list.find((s) => s.id === opts.subcktChoice?.[name.toUpperCase()]) ?? list[list.length - 1];
    return picked;
  };

  // 收集顶层 .PARAM
  const topParams = new Map<string, ParamValue>();
  for (const st of bundle.statements) {
    if (st.type === 'control' && /^\.param/i.test(st.raw)) {
      absorbParamLine(st.raw, st.lineId, 'src:' + bundle.id, topParams, 'top-params', null);
    }
  }

  const frames: Map<string, Frame> = new Map();
  const rootFrame: Frame = { path: '', params: new Map(topParams), parent: null };
  frames.set('', rootFrame);

  const rememberNode = (uid: string, token: string) => {
    if (!(uid in nodeTokens)) nodeTokens[uid] = token;
  };

  const instantiate = (
    sub: RawSubckt, instancePath: string, portBind: Map<string, string>,
    parentFrame: Frame, overrides: Map<string, ParamValue>, originFile: string, originLine: string,
    instanceRaw: string, ambiguous: boolean
  ): HierarchyNode => {
    // 该实例的参数帧：默认值 + 实例覆盖（覆盖仅作用本帧）
    const frameParams = new Map<string, ParamValue>();
    for (const p of sub.params) {
      frameParams.set(p.name.toUpperCase(), toParamValue(p, 'subckt-default', instancePath));
    }
    for (const [k, v] of overrides) frameParams.set(k, v);
    const frame: Frame = { path: instancePath, params: frameParams, parent: parentFrame.path };
    frames.set(instancePath, frame);

    const node: HierarchyNode = {
      id: `inst:${instancePath}`,
      instanceRaw, subcktName: sub.name, subcktDefId: sub.id,
      parentId: instancePath.includes('/') ? `inst:${instancePath.split('/').slice(0, -1).join('/')}` : null,
      children: [], originFileId: originFile, originLineId: originLine,
      localParamFrame: Object.fromEntries(frameParams), ambiguousSubckt: ambiguous
    };
    hierarchy.push(node);

    const resolveLocalNode = (token: string): string => {
      if (token === '0') return 'net::0';
      if (portBind.has(token)) return portBind.get(token)!;
      const uid = nodeUid(instancePath, token);
      rememberNode(uid, token);
      return uid;
    };

    // 先处理子电路内部 .PARAM（其默认依赖本帧参数）
    for (const lineId of sub.bodyLineIds) {
      const raw = lineRaw(bundle, lineId);
      if (/^\.param/i.test(raw)) absorbParamLine(raw, lineId, sub.sourceFileId, frameParams, 'subckt-default', instancePath);
    }

    for (const dev of sub.body) {
      emitDevice(dev, instancePath, frame, resolveLocalNode, sub, node, diagnostics, devices, bundle, opts, registry, frames);
    }
    return node;
  };

  const topSub = {
    id: `inst::root:${bundle.id}`, name: '$ROOT', externalNodes: [] as string[],
    params: [], body: [] as RawDevice[], bodyLineIds: [] as string[],
    lineStart: '', lineEndsId: '', sourceFileId: bundle.files[0]?.id ?? ''
  } satisfies RawSubckt;

  // 顶层器件（不属于任何 .SUBCKT 体的实例）
  for (const st of bundle.statements) {
    if (st.type !== 'device') continue;
    if (insideAnySubckt(bundle, st.dev)) continue;
    emitDevice(st.dev, '', rootFrame, (token: string) => {
      if (token === '0') return 'net::0';
      const uid = nodeUid('', token);
      rememberNode(uid, token);
      return uid;
    }, topSub, null, diagnostics, devices, bundle, opts, registry, frames, instantiate);
  }

  // 汇总作用域链
  for (const [path, frame] of frames) {
    scopes[path === '' ? '$root' : `inst:${path}`] = {
      frame: path === '' ? '$root' : `inst:${path}`,
      params: Object.fromEntries(frame.params),
      parent: frame.parent === null ? null : (frame.parent === '' ? '$root' : `inst:${frame.parent}`)
    };
  }

  const rootExternalNodes = devices.length > 0
    ? collectExternal(devices)
    : [];

  const network: FlatNetwork = { rootExternalNodes, devices, nodeTokens, hierarchy, scopes, diagnostics };
  resolveAllFrames(network, frames);
  return network;
}

function insideAnySubckt(bundle: SourceBundle, dev: RawDevice): boolean {
  for (const st of bundle.statements) {
    if (st.type === 'subckt' && st.sub.body.some((d) => d.id === dev.id)) return true;
  }
  return false;
}

function collectExternal(devices: FlatDevice[]): string[] {
  // 顶层（无 inst 路径）节点且非地
  const set = new Set<string>();
  for (const d of devices) {
    if (d.path !== '') continue;
    for (const n of d.nodeUids) if (!n.includes('::')) set.add(n);
  }
  return [...set];
}

export function lineRaw(bundle: SourceBundle, lineId: string): string {
  for (const f of bundle.files) {
    const l = f.logicalLines.find((x) => x.id === lineId);
    if (l) return l.joined;
  }
  return '';
}

function toParamValue(
  p: { name: string; exprRaw: string; lineId: string; raw: string },
  kind: ParamOrigin['kind'], instancePath: string | null,
  sourceFileId = '', physicalLine = 0
): ParamValue {
  const exprSrc = p.exprRaw.trim();
  const { expr } = parseExpr(exprSrc);
  const deps = expr ? exprDeps(expr) : [];
  return {
    name: p.name.toUpperCase(), nameRaw: p.name, exprRaw: exprSrc, expr,
    value: expr?.t === 'num' ? expr.value : (expr ? null : exprSrc),
    resolved: expr?.t === 'num' ?? false,
    origin: {
      sourceFileId: sourceFileId || p.lineId.split('#')[0],
      lineId: p.lineId, physicalLine, kind, instancePath, rawText: p.raw
    },
    depRefs: deps, depResolutions: []
  };
}

function absorbParamLine(
  raw: string, lineId: string, fileId: string,
  into: Map<string, ParamValue>, kind: ParamOrigin['kind'], instancePath: string | null
) {
  const toks = raw.replace(/^\.\w+/, '').match(/\S+/g) ?? [];
  let i = 0;
  while (i < toks.length) {
    const tk = toks[i];
    const eq = tk.indexOf('=');
    if (eq > 0) {
      const name = tk.slice(0, eq);
      let rest = tk.slice(eq + 1).replace(/^\{|\}$/g, '');
      if (rest === '' && i + 1 < toks.length) { i++; rest = toks[i].replace(/^\{|\}$/g, ''); }
      into.set(name.toUpperCase(), toParamValue(
        { name, exprRaw: rest, lineId, raw: tk }, kind, instancePath, fileId
      ));
    }
    i++;
  }
}

type InstantiateFn = (
  sub: RawSubckt, instancePath: string, portBind: Map<string, string>,
  parentFrame: Frame, overrides: Map<string, ParamValue>, originFile: string, originLine: string,
  instanceRaw: string, ambiguous: boolean
) => HierarchyNode;

function emitDevice(
  dev: RawDevice, parentPath: string, parentFrame: Frame,
  resolveNode: (token: string) => string,
  sub: RawSubckt, parentHierarchy: HierarchyNode | null,
  diagnostics: Diagnostic[], devices: FlatDevice[],
  bundle: SourceBundle, opts: FlattenOptions,
  registry: ReturnType<typeof buildRegistry>, frames: Map<string, Frame>,
  instantiate?: InstantiateFn
) {
  const path = flatUid(parentPath, dev.instanceName);

  if (dev.kind === 'X') {
    const list = registry.subckts.get((dev.modelRef ?? '').toUpperCase()) ?? [];
    if (list.length === 0) {
      diagnostics.push({
        level: 'error', code: 'subckt-undefined',
        message: `实例 ${dev.instanceName} 引用未定义子电路 ${dev.modelRef}；保留为 opaque 实例`,
        sourceFileId: dev.id.split('#')[0]
      });
      emitOpaque(dev, path, parentPath, resolveNode, devices, true);
      return;
    }
    const chosen = list.find((s) => s.id === opts.subcktChoice?.[(dev.modelRef ?? '').toUpperCase()]) ?? list[list.length - 1];
    const overrides = new Map<string, ParamValue>();
    for (const p of dev.params) {
      overrides.set(p.name.toUpperCase(), toParamValue(p, 'instance-override', path));
    }
    // 覆盖表达式先按父帧求值为数值参数（SPICE 实参在调用处求值）
    const parentRefs = collectRefs(parentFrame, frames);
    for (const [, pv] of overrides) {
      if (pv.expr) pv.value = evalExpr(pv.expr, parentRefs) ?? pv.exprRaw;
      pv.resolved = typeof pv.value === 'number';
    }
    const portBind = new Map<string, string>();
    chosen.externalNodes.forEach((port, i) => {
      const actual = dev.nodeTokens[i];
      if (actual === undefined) {
        diagnostics.push({
          level: 'warning', code: 'subckt-port-arity',
          message: `实例 ${dev.instanceName} 缺少端口实参 ${port}`,
          sourceFileId: dev.id.split('#')[0]
        });
        const uid = nodeUid(path, `__open_${port}`);
        portBind.set(port, uid);
      } else {
        portBind.set(port, resolveNode(actual));
      }
    });
    if (!instantiate) return;
    const node = instantiate(chosen, path, portBind, parentFrame, overrides,
      dev.id.split('#')[0], dev.lineId, dev.instanceName, list.length > 1);
    if (parentHierarchy) parentHierarchy.children.push(node.id);
    return;
  }

  // 原始器件
  const nodeUids = dev.nodeTokens.map(resolveNode);
  const nodeTokenByUid: Record<string, string> = {};
  dev.nodeTokens.forEach((t, i) => { nodeTokenByUid[nodeUids[i]] = t; });

  const frameRefs = collectRefs(parentFrame, frames);
  const params: Record<string, ParamValue> = {};
  const quantities: Record<string, Quantity> = {};

  for (const p of dev.params) {
    const pv = toParamValue(p, 'instance-override', parentPath);
    if (pv.expr) {
      pv.value = evalExpr(pv.expr, frameRefs) ?? pv.exprRaw;
      pv.resolved = typeof pv.value === 'number';
      annotateDeps(pv, parentFrame, frames);
    }
    params[p.name.toUpperCase()] = pv;
  }
  if (dev.rawValueToken !== null) {
    const ctx = VALUE_CONTEXT[dev.kind] ?? 'generic';
    const tok = dev.rawValueToken;
    let q: Quantity;
    if (tok.startsWith('{') || /[A-Za-z_]/.test(tok.replace(/[eE][+-]?\d+$/, '')) && /[A-Za-z_]/.test(tok.replace(/^[0-9.eE+-]+/, ''))) {
      // 表达式值
      const inner = tok.replace(/^\{|\}$/g, '');
      const { expr } = parseExpr(inner);
      const num = expr ? evalExpr(expr, frameRefs) : null;
      q = {
        rawToken: tok, number: num,
        unit: { context: ctx, scaleFactor: null, unitWord: null },
        suffixRaw: null, ok: num !== null,
        diagnostics: num === null
          ? [{ level: 'error', code: 'value-unresolved', message: `值表达式 "${tok}" 无法在当前作用域求值，保留原文` }]
          : []
      };
    } else {
      q = parseQuantity(tok, ctx);
    }
    quantities['VALUE'] = q;
    q.diagnostics.forEach((d) => diagnostics.push({ ...d, objectId: dev.id, sourceFileId: dev.id.split('#')[0] }));
  }

  const modelKey = dev.modelRef ? `${dev.modelRef.toUpperCase()}|${modelTypeFor(registry, dev.modelRef, opts)}` : null;
  const modelDef = dev.modelRef
    ? (registry.models.get(modelKey ?? '') ?? []).find((m) => m.id === opts.modelChoice?.[modelKey ?? ''])
      ?? (registry.models.get(modelKey ?? '') ?? [])[(registry.models.get(modelKey ?? '') ?? []).length - 1]
    : null;

  const opaque = dev.kind === 'unknown';
  if (opaque) diagnostics.push({
    level: 'warning', code: 'opaque-device',
    message: `未知元件 ${dev.instanceName} 保留 opaque 连接（不删除、不猜测内部语义）`,
    sourceFileId: dev.id.split('#')[0], objectId: dev.id
  });

  devices.push({
    uid: path, path: parentPath, instanceRaw: dev.instanceName, kind: dev.kind,
    nodeUids, nodeTokenByUid, modelRef: dev.modelRef, modelDefId: modelDef?.id ?? null,
    quantities, params, opaque,
    originFileId: dev.id.split('#')[0], originLineId: dev.lineId
  });
}

function emitOpaque(dev: RawDevice, path: string, parentPath: string,
  resolveNode: (t: string) => string, devices: FlatDevice[], undefinedSubckt: boolean) {
  const nodeUids = dev.nodeTokens.map(resolveNode);
  const nodeTokenByUid: Record<string, string> = {};
  dev.nodeTokens.forEach((t, i) => { nodeTokenByUid[nodeUids[i]] = t; });
  devices.push({
    uid: path, path: parentPath, instanceRaw: dev.instanceName, kind: 'unknown',
    nodeUids, nodeTokenByUid, modelRef: dev.modelRef, modelDefId: null,
    quantities: {}, params: {}, opaque: true,
    originFileId: dev.id.split('#')[0], originLineId: dev.lineId
  });
  if (undefinedSubckt) { /* 诊断已在调用处记录 */ }
}

function modelTypeFor(
  registry: ReturnType<typeof buildRegistry>, ref: string, opts: FlattenOptions
): string {
  for (const key of registry.models.keys()) {
    if (key.startsWith(ref.toUpperCase() + '|')) {
      const list = registry.models.get(key)!;
      const picked = list.find((m) => m.id === opts.modelChoice?.[key]) ?? list[list.length - 1];
      return picked.modelType.toUpperCase();
    }
  }
  return '';
}

function frameChain(frame: Frame, frames: Map<string, Frame>): Frame[] {
  const chain: Frame[] = [];
  let cur: Frame | null = frame;
  while (cur) { chain.unshift(cur); cur = cur.parent === null ? null : frames.get(cur.parent)!; }
  return chain;
}

/**
 * 沿层次作用域链解析数值引用：根帧 -> ... -> 当前帧；内层覆盖外层。
 * 同一帧内参数互相依赖时做不动点迭代；解析失败的引用保持缺失（不编造）。
 */
export function collectRefs(frame: Frame, frames: Map<string, Frame>): Record<string, number | null> {
  const chain = frameChain(frame, frames);
  const refs: Record<string, number | null> = {};
  for (const fr of chain) {
    // 已知数值（覆盖实参/已解析常量）先放入
    const local: Record<string, number | null> = {};
    for (const [k, pv] of fr.params) {
      if (typeof pv.value === 'number') local[k] = pv.value;
    }
    // 不动点：解析本帧表达式（可引用兄弟默认参数）
    let changed = true;
    let guard = 0;
    while (changed && guard++ < 64) {
      changed = false;
      for (const [k, pv] of fr.params) {
        if (k in local) continue;
        if (!pv.expr) continue;
        const v = evalExpr(pv.expr, { ...refs, ...local });
        if (v !== null) { local[k] = v; changed = true; }
      }
    }
    // 回填 ParamValue 的数值/解析状态
    for (const [k, pv] of fr.params) {
      if (k in local && typeof pv.value !== 'number') {
        pv.value = local[k]; pv.resolved = true;
      }
    }
    Object.assign(refs, local);
  }
  return refs;
}

/** 为一个参数值记录其每个引用在哪个作用域帧被解析（参数作用域不压平的溯源）。 */
function annotateDeps(pv: ParamValue, frame: Frame, frames: Map<string, Frame>) {
  const chain = frameChain(frame, frames);
  for (const dep of pv.depRefs) {
    for (let i = chain.length - 1; i >= 0; i--) {
      const owner = chain[i];
      const found = owner.params.get(dep);
      if (found) {
        pv.depResolutions.push({ name: dep, frame: owner.path === '' ? '$root' : `inst:${owner.path}`, origin: found.origin });
        break;
      }
    }
  }
}

/** 展平结束后统一再解一遍所有帧，保证帧内交叉依赖与 depResolutions 完整。 */
export function resolveAllFrames(network: FlatNetwork, frames: Map<string, Frame>) {
  for (const [, frame] of frames) {
    collectRefs(frame, frames);
    for (const pv of frame.params.values()) annotateDeps(pv, frame, frames);
  }
  // 重建 scopes 快照
  for (const [path, frame] of frames) {
    network.scopes[path === '' ? '$root' : `inst:${path}`] = {
      frame: path === '' ? '$root' : `inst:${path}`,
      params: Object.fromEntries(frame.params),
      parent: frame.parent === null ? null : (frame.parent === '' ? '$root' : `inst:${frame.parent}`)
    };
  }
}
