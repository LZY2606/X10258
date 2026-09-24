import type {
  InstanceLine, ModelDef, ParamDef, SubcktDef,
} from '../shared/types';
import type { ModuleSet, SubcktVersion } from '../spice/loader';
import { parseExpression, tryEval } from '../spice/expression';
import { stableId } from '../spice/ident';
import { parseSpiceNumber } from '../spice/number';
import { deviceMeta } from '../spice/devices';

/** 一个被展开的作用域帧：保存局部参数的原始表达式与来源（默认值/实参覆盖）。 */
export interface ScopeFrame {
  id: string;
  /** 子电路定义版本内容 id；根为 '__top__' */
  subDefId: string;
  subName: string; // 解析到的子电路大写名（根为 TOP）
  path: string; // 层次路径，例如 'TOP/X1/X2'
  /** 参数名 -> 绑定（原始表达式 + 来源类型 + 来源实例/定义） */
  params: Map<string, ParamBinding>;
  parent?: ScopeFrame;
  depth: number;
}

export type ParamSourceKind = 'default' | 'override' | 'top-param';

export interface ParamBinding {
  name: string;
  rawName: string;
  rawExpr: string; // 原样表达式（含单位后缀），不改写
  source: ParamSourceKind;
  /** 来源坐标：默认值来自 .subckt/.param；覆盖来自实例 name=value */
  sourceInstanceId?: string;
  sourceOrigin?: { fileId: string; line: number };
  freeDeps: string[];
  value?: number;
  unresolvedReason?: string;
  unitSuffix?: string;
  basis?: string;
}

export interface HierarchyNode {
  id: string; // 路径派生的稳定身份
  path: string;
  instanceRawName: string;
  subDefId: string;
  subName: string;
  parentId: string | null;
  depth: number;
  /** 该实例实际绑定的子电路版本（重名时记录选择与候选） */
  resolvedVersionOrdinal: number;
  versionCandidates: number[];
  ambiguity: 'unique' | 'shadow-name' | 'unresolved';
}

export interface FlatDevice {
  id: string; // path + rawName 派生
  path: string; // 所属作用域路径
  rawName: string;
  fullName: string; // path/NAME
  letter: string;
  opaque: boolean;
  /** pin 序号 -> 外部展平网络全名 */
  pins: { pin: number; net: string; symmetricGroup?: number[] }[];
  modelRef?: { rawName: string; resolvedVersionKey?: string; ambiguous?: boolean };
  params: { rawName: string; rawValue: string; value?: number; unresolvedReason?: string }[];
  restRaw: string[];
  origin: { fileId: string; line: number };
}

export interface FlatNet {
  id: string;
  name: string; // 全名 path/LOCAL 或顶层名
  localName: string;
  path: string;
  isTop: boolean;
  isGlobal: boolean;
}

export interface FlattenResult {
  rootPath: string;
  tree: HierarchyNode[];
  devices: FlatDevice[];
  nets: FlatNet[];
  scopes: ScopeFrame[];
  diagnostics: FlattenDiagnostic[];
  /** 未解析为子电路的 X 实例（缺少定义） */
  unresolvedX: { instance: string; path: string; reason: string }[];
}

export interface FlattenDiagnostic {
  code: string;
  message: string;
  severity: 'error' | 'warning' | 'info';
  path?: string;
  fileId?: string;
  line?: number;
}

interface ExpandArgs {
  mod: ModuleSet;
  tree: HierarchyNode[];
  devices: FlatDevice[];
  nets: Map<string, FlatNet>;
  scopes: ScopeFrame[];
  diagnostics: FlattenDiagnostic[];
  unresolvedX: FlattenResult['unresolvedX'];
  globals: Set<string>;
}

/**
 * 展平入口。
 * - 参数作用域/默认值/表达式依赖保留为独立绑定，绝不能压平成单一数值；
 * - 节点与实例名通过层次路径 alpha-rename；
 * - 未知元件 opaque 保留连接，不删除。
 */
export function flatten(mod: ModuleSet, rootPath = mod.rootPath): FlattenResult {
  const args: ExpandArgs = {
    mod, tree: [], devices: [], nets: new Map(), scopes: [],
    diagnostics: mod.diagnostics.map((d) => ({ code: d.code, message: d.message, severity: d.severity, fileId: d.origin?.fileId, line: d.origin?.start.line })),
    unresolvedX: [],
    globals: new Set(['0', 'GND']),
  };

  // 顶层 .global / .param
  for (const line of mod.topLines) {
    if (line.kind === 'globals') for (const t of line.tokens) args.globals.add(t.text.toUpperCase());
  }
  const topBindings = new Map<string, ParamBinding>();
  for (const line of mod.topLines) {
    if (line.kind === 'param') {
      for (const pd of line.params) addBinding(topBindings, pd, 'top-param', undefined, pd.origin);
    }
  }
  evaluateBindings(topBindings, () => undefined);

  const root: ScopeFrame = {
    id: stableId('scope', 'TOP', rootPath),
    subDefId: '__top__', subName: 'TOP', path: 'TOP', params: topBindings, depth: 0,
  };
  args.scopes.push(root);

  // 顶层网络登记
  const registerNet = (local: string, path: string, isTop: boolean): string => {
    const global = args.globals.has(local.toUpperCase());
    const full = isTop || global ? local.toUpperCase() : `${path}/${local.toUpperCase()}`;
    if (!args.nets.has(full)) {
      args.nets.set(full, { id: stableId('net', full), name: full, localName: local.toUpperCase(), path, isTop, isGlobal: global });
    }
    return full;
  };

  for (const line of mod.topLines) {
    if (line.kind === 'instance') expandInstance(args, line, root, registerNet);
  }

  return {
    rootPath,
    tree: args.tree,
    devices: args.devices,
    nets: [...args.nets.values()].sort((a, b) => a.name.localeCompare(b.name)),
    scopes: args.scopes,
    diagnostics: args.diagnostics,
    unresolvedX: args.unresolvedX,
  };
}

function addBinding(
  map: Map<string, ParamBinding>,
  pd: ParamDef,
  source: ParamSourceKind,
  sourceInstanceId: string | undefined,
  origin: ParamBinding['sourceOrigin'] | { fileId: string; start: { line: number } },
): void {
  const rawExpr = pd.defaultExpr?.raw ?? '';
  const pe = parseExpression(rawExpr);
  const num = parseSpiceNumber(rawExpr);
  map.set(pd.name, {
    name: pd.name,
    rawName: pd.rawName,
    rawExpr,
    source,
    sourceInstanceId,
    sourceOrigin: 'start' in (origin ?? {}) ? { fileId: (origin as { fileId: string }).fileId, line: (origin as { start: { line: number } }).start.line } : origin as { fileId: string; line: number },
    freeDeps: pe.freeVars,
    value: undefined,
    unitSuffix: num.ok ? num.unitSuffix : undefined,
    basis: num.ok ? num.basis : undefined,
  });
}

/** 按依赖顺序在单个作用域内求值；跨作用域依赖通过 parentLookup 解析，但不压平定义。 */
function evaluateBindings(map: Map<string, ParamBinding>, parentLookup: (n: string) => number | undefined): void {
  const state = new Map<string, 0 | 1 | 2>(); // 1=visiting 2=done
  const valueOf = (name: string): number | undefined => {
    const b = map.get(name);
    if (b) {
      if (b.value !== undefined) return b.value;
      return undefined; // 由 resolveOne 控制
    }
    return parentLookup(name);
  };
  const resolveOne = (name: string, stack: Set<string>): void => {
    const st = state.get(name);
    if (st === 2) return;
    if (st === 1 || stack.has(name)) {
      const b0 = map.get(name);
      if (b0) b0.unresolvedReason = `cyclic-reference:${name}`;
      state.set(name, 2);
      return;
    }
    state.set(name, 1);
    stack.add(name);
    const b = map.get(name)!;
    for (const dep of b.freeDeps) {
      if (map.has(dep)) resolveOne(dep, stack);
    }
    const r = tryEval(b.rawExpr, (n) => {
      const local = map.get(n);
      if (local) return local.value ?? (local.unresolvedReason ? undefined : undefined);
      return parentLookup(n);
    });
    if (r.error === undefined && r.value !== undefined) {
      b.value = r.value;
      const num = parseSpiceNumber(b.rawExpr);
      b.unitSuffix = num.ok ? num.unitSuffix : undefined;
      b.basis = num.ok ? num.basis : undefined;
    } else {
      b.unresolvedReason = r.error ?? 'unresolved';
    }
    stack.delete(name);
    state.set(name, 2);
  };
  for (const name of map.keys()) resolveOne(name, new Set());
  void valueOf;
}

function chooseSubcktVersion(mod: ModuleSet, subName: string, portCount: number, instId: string): { picked?: SubcktVersion; candidates: SubcktVersion[]; ambiguity: HierarchyNode['ambiguity'] } {
  const versions = mod.subckts.get(subName.toUpperCase()) ?? [];
  const portMatch = versions.filter((v) => v.def.ports.length === portCount);
  const pool = portMatch.length ? portMatch : versions;
  if (pool.length === 0) return { candidates: [], ambiguity: 'unresolved' };
  if (pool.length === 1 && versions.length === 1) return { picked: pool[0], candidates: pool, ambiguity: 'unique' };
  // 重名：端口数相同的多个版本在静态下都合法 -> 保留全部候选，默认选首个并标记多解。
  return { picked: pool[0], candidates: pool, ambiguity: pool.length > 1 ? 'shadow-name' : 'unique' };
}

function expandInstance(
  args: ExpandArgs,
  inst: InstanceLine,
  parent: ScopeFrame,
  registerNet: (local: string, path: string, isTop: boolean) => string,
): void {
  const childPath = `${parent.path}/${inst.rawName}`;

  if (inst.letter !== 'X') {
    addDevice(args, inst, parent, registerNet);
    return;
  }

  // X 子电路实例
  const portCount = inst.nodes.length;
  const choice = chooseSubcktVersion(args.mod, inst.subName ?? '', portCount, inst.id);
  if (!choice.picked) {
    args.unresolvedX.push({ instance: inst.rawName, path: childPath, reason: `no .subckt definition for ${inst.subName ?? '?'} with ${portCount} ports` });
    args.diagnostics.push({ code: 'X_UNRESOLVED', message: `${childPath}: unresolved subckt ${inst.subName ?? '?'}`, severity: 'error', path: childPath, fileId: inst.origin.fileId, line: inst.origin.start.line });
    return;
  }
  const def: SubcktDef = choice.picked.def;

  // 建立子作用域参数：默认值先放，实例覆盖后放（保留各自来源，不丢默认候选）
  const bindings = new Map<string, ParamBinding>();
  for (const pd of def.params) addBinding(bindings, pd, 'default', inst.id, pd.origin);
  for (const p of inst.params) {
    const name = p.rawName.toUpperCase();
    const existing = bindings.get(name);
    const raw = stripBraces(p.rawValue);
    const pe = parseExpression(raw);
    const num = parseSpiceNumber(raw);
    bindings.set(name, {
      name,
      rawName: p.rawName,
      rawExpr: raw,
      source: 'override',
      sourceInstanceId: inst.id,
      sourceOrigin: { fileId: inst.origin.fileId, line: p.start.line },
      freeDeps: pe.freeVars,
      unitSuffix: num.ok ? num.unitSuffix : undefined,
      basis: num.ok ? num.basis : undefined,
    });
    if (existing) (bindings.get(name) as ParamBinding & { shadowedDefault?: ParamBinding }).shadowedDefault = existing;
  }
  evaluateBindings(bindings, (n) => lookupParent(parent, n));

  const scope: ScopeFrame = {
    id: stableId('scope', childPath, def.id),
    subDefId: def.id, subName: def.name, path: childPath, params: bindings, parent, depth: parent.depth + 1,
  };
  args.scopes.push(scope);

  const node: HierarchyNode = {
    id: stableId('h', childPath, def.id),
    path: childPath,
    instanceRawName: inst.rawName,
    subDefId: def.id,
    subName: def.name,
    parentId: parent.subDefId === '__top__' ? null : stableId('h', parent.path, parent.subDefId),
    depth: parent.depth + 1,
    resolvedVersionOrdinal: choice.candidates.indexOf(choice.picked),
    versionCandidates: choice.candidates.map((c) => c.ordinal),
    ambiguity: choice.ambiguity,
  };
  args.tree.push(node);

  // 端口映射：子电路内部端口名 -> 父作用域实参网络（alpha-rename 的锚点）
  const portMap = new Map<string, string>();
  def.ports.forEach((port, idx) => {
    const actual = inst.nodes[idx];
    const parentNet = registerNet(actual, parent.path, parent.depth === 0);
    portMap.set(port.toUpperCase(), parentNet);
  });

  for (const bodyLine of def.body) {
    if (bodyLine.kind === 'instance') {
      if (bodyLine.letter === 'X') {
        expandInstance(args, bodyLine, scope, (local, p, isTop) => mapNet(args, local, p, isTop, portMap, scope, registerNet));
      } else {
        addDevice(args, bodyLine, scope, (local) => mapNet(args, local, scope.path, false, portMap, scope, registerNet));
      }
    }
  }
}

function lookupParent(frame: ScopeFrame, name: string): number | undefined {
  let cur: ScopeFrame | undefined = frame;
  while (cur) {
    const b = cur.params.get(name);
    if (b) return b.value;
    cur = cur.parent;
  }
  return undefined;
}

function mapNet(
  args: ExpandArgs,
  local: string,
  path: string,
  isTop: boolean,
  portMap: Map<string, string>,
  scope: ScopeFrame,
  registerNet: (local: string, path: string, isTop: boolean) => string,
): string {
  const up = local.toUpperCase();
  if (args.globals.has(up)) return up;
  if (portMap.has(up)) return portMap.get(up)!;
  void scope;
  return registerNet(local, path, isTop);
}

function stripBraces(s: string): string {
  const t = s.trim();
  return t.startsWith('{') && t.endsWith('}') ? t.slice(1, -1) : t;
}

function addDevice(
  args: ExpandArgs,
  inst: InstanceLine,
  scope: ScopeFrame,
  netOf: (local: string) => string,
): void {
  const meta = deviceMeta(inst.letter);
  const pins = inst.nodes.map((n, idx) => ({
    pin: idx,
    net: netOf(n),
    symmetricGroup: (meta.symmetricPins?.find((g) => g.includes(idx))),
  }));
  // model 引用：D/Q/M/J 等的第一个裸 token
  let modelRef: FlatDevice['modelRef'];
  if (inst.rest.length && ['D', 'Q', 'M', 'J', 'B', 'S', 'W'].includes(inst.letter)) {
    const rawName = inst.rest[0].text.toUpperCase();
    const versions = args.mod.models.get(rawName) ?? [];
    modelRef = {
      rawName: inst.rest[0].text,
      resolvedVersionKey: versions[0]?.model.versionKey,
      ambiguous: versions.length > 1,
    };
    if (versions.length > 1) {
      args.diagnostics.push({ code: 'MODEL_SHADOW', message: `${scope.path}/${inst.rawName}: model ${rawName} has ${versions.length} versions`, severity: 'warning', path: scope.path, fileId: inst.origin.fileId, line: inst.origin.start.line });
    }
  }
  const devParams = inst.params.map((p) => {
    const raw = stripBraces(p.rawValue);
    const r = tryEval(raw, (n) => lookupParent(scope, n));
    return { rawName: p.rawName, rawValue: raw, value: r.value, unresolvedReason: r.error };
  });
  if (inst.opaque) {
    args.diagnostics.push({ code: 'OPAQUE_ELEMENT', message: `${scope.path}/${inst.rawName}: unknown element kept opaque with ${pins.length} pin(s)`, severity: 'warning', path: scope.path, fileId: inst.origin.fileId, line: inst.origin.start.line });
  }
  args.devices.push({
    id: stableId('dev', scope.path, inst.rawName),
    path: scope.path,
    rawName: inst.rawName,
    fullName: `${scope.path}/${inst.rawName}`,
    letter: inst.letter,
    opaque: inst.opaque,
    pins,
    modelRef,
    params: devParams,
    restRaw: inst.rest.map((t) => t.text),
    origin: { fileId: inst.origin.fileId, line: inst.origin.start.line },
  });
}
