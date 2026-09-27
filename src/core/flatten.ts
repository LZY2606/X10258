import { analyzeExpression, evaluate } from './expr';
import { parseSpiceNumber } from './units';
import { stableId } from './ids';
import type {
  NetlistUnit,
  ParamOrigin,
  ParamValue,
  ScopedParam,
  SubcktDef,
  ID,
} from './types';
import type {
  DeviceFamily,
  FlatCircuit,
  FlatDevice,
  FlatNet,
  FlatParam,
  HierarchyNode,
} from './flattenTypes';

const FAMILY: Record<string, DeviceFamily> = {
  R: 'resistor', C: 'capacitor', L: 'inductor', D: 'diode',
  Q: 'bjt', M: 'mosfet', J: 'jfet', V: 'vsource', I: 'isource',
};

const SYMMETRIES: Record<string, string[][]> = {
  resistor: [['p', 'n']], capacitor: [['p', 'n']], inductor: [['p', 'n']],
  diode: [], bjt: [], mosfet: [['d', 's']], jfet: [['d', 's']],
  vsource: [], isource: [],
};

const PIN_NAMES: Record<string, string[]> = {
  R: ['p', 'n'], C: ['p', 'n'], L: ['p', 'n'], D: ['p', 'n'],
  J: ['d', 'g', 's'], Q: ['c', 'b', 'e', 's'], M: ['d', 'g', 's', 'b', 't'],
  V: ['p', 'n'], I: ['p', 'n'],
};

interface InstanceArgs {
  positional: string[];
  named: Map<string, string>;
  argSource: { sourceId: ID; lineId: ID; cardId: ID };
}

export function flatten(unit: NetlistUnit): FlatCircuit {
  const state: State = {
    devices: [], nets: new Map(), hierarchy: [], scoped: new Map(),
    diagnostics: [], unit,
  };
  const rootProvenance = { sourceId: unit.sources[0].id, lineId: '', cardId: '' };
  state.hierarchy.push(node('ROOT', 'ROOT', null, null, [], rootProvenance));
  instantiateScope(state, 'ROOT', null, [], [], [], []);
  return {
    side: unit.side,
    devices: state.devices,
    nets: [...state.nets.values()].sort((a, b) => a.canonical.localeCompare(b.canonical)),
    hierarchy: state.hierarchy,
    scopedParams: [...state.scoped.values()].map(toScopedOut),
    diagnostics: state.diagnostics,
  };
}

interface State {
  devices: FlatDevice[];
  nets: Map<string, FlatNet>;
  hierarchy: HierarchyNode[];
  scoped: Map<string, ScopedParam>;
  diagnostics: FlatCircuit['diagnostics'];
  unit: NetlistUnit;
}

function node(
  path: string, localName: string, parent: ID | null, identity: ID | null,
  args: HierarchyNode['args'], provenance: HierarchyNode['provenance'],
): HierarchyNode {
  return {
    id: `h_${path}`, path, localName, subcktIdentity: identity,
    parent, children: [], args, provenance,
  };
}

function toScopedOut(p: ScopedParam): FlatCircuit['scopedParams'][number] {
  return {
    key: p.key, name: p.name,
    path: p.origin.scopePath.join('/'),
    effective: p.value,
    defaultValue: p.overrides.find((o) => o.origin.kind === 'subckt-default')?.value ?? null,
    overrideValue: p.overrides.find((o) => o.origin.kind === 'instance-override')?.value ?? null,
    origin: p.origin,
  };
}

/**
 * 实例化一个作用域。
 * @param path 当前层次路径（ROOT 或 ROOT.X1...）
 * @param def 当前作用域对应的子电路定义；ROOT 为 null（体内卡 = 所有未被 subckt 包围的顶层卡）
 * @param scopeIds 外层到当前层的 scope id 栈（参数查找路径）
 * @param portNet 当前作用域每个形参端口绑定到的“已存在”外部网络（canonical key）
 * @param argList 调用处实参（positional 按端口序是节点；named 是参数覆盖）
 * @param provChain 来源链（各级 X 实例卡）
 */
function instantiateScope(
  s: State,
  path: string,
  def: SubcktDef | null,
  portNets: string[],
  argPositional: string[],
  argNamed: Map<string, string>,
  provChain: HierarchyNode['provenance'][],
): void {
  const scopeKey = path;
  const ownParamNames = new Set<string>();

  // 1) 形参默认值（作用域内参数，最低优先）
  if (def) {
    for (const fd of def.formalDefaults) {
      registerParam(s, scopeKey, fd.name, fd.raw, 'subckt-default', def.cardId, [], provChain);
      ownParamNames.add(fd.name.toUpperCase());
    }
  }
  // 2) 调用处实例覆盖（最高优先，针对形参名；未声明的实参也保留为作用域参数并诊断）
  for (const [name, raw] of argNamed) {
    registerParam(s, scopeKey, name, raw, 'instance-override', provChain[provChain.length - 1]?.cardId ?? '', [], provChain);
    ownParamNames.add(name.toUpperCase());
  }
  // 3) 体内 .PARAM（作用域内赋值；顺序敏感，可引用先前参数）
  const bodyCards = def
    ? def.bodyCardIds.map((id) => s.unit.cards.find((c) => c.id === id)!)
    : topLevelCards(s);
  for (const card of bodyCards) {
    if (card.kind !== 'param') continue;
    const elem = paramAssignments(card);
    for (const a of elem) {
      registerParam(s, scopeKey, a.name, a.raw, 'dot-param', card.id, [], provChain);
      ownParamNames.add(a.name.toUpperCase());
    }
  }

  // 4) 遍历体内元件/实例
  for (const card of bodyCards) {
    if (card.kind !== 'element') continue;
    const el = s.unit.elements[card.id];
    if (!el) continue;
    if (el.typePrefix === 'X') {
      expandInstance(s, path, el, card, portNets, def, provChain, scopeKey);
      continue;
    }
    expandDevice(s, path, el, card, portNets, def, provChain, scopeKey);
  }
}

function topLevelCards(s: State) {
  // 顶层卡：不在任何 .SUBCKT 体内的卡。解析器只给 subckt body 记录了卡，
  // 顶层即所有未被任何 def.bodyCardIds 引用的 element/param/control 卡。
  const inside = new Set<string>();
  for (const defs of Object.values(s.unit.subckts)) {
    for (const d of defs) for (const id of d.bodyCardIds) inside.add(id);
  }
  return s.unit.cards.filter((c) => !inside.has(c.id) && (c.kind === 'element' || c.kind === 'param'));
}

function paramAssignments(card: { tokens: { text: string; start: number; end: number }[] }) {
  const out: { name: string; raw: string }[] = [];
  const tk = card.tokens;
  for (let i = 1; i < tk.length; i++) {
    if (tk[i].text === '=' && i - 1 >= 1 && i + 1 < tk.length) {
      out.push({ name: tk[i - 1].text, raw: tk[i + 1].text });
    }
  }
  return out;
}

function originFor(
  kind: ParamOrigin['kind'], cardId: ID, s: State, scopeKey: string,
  provChain: HierarchyNode['provenance'][], dependsOn: string[],
): ParamOrigin {
  const card = s.unit.cards.find((c) => c.id === cardId);
  const prov = kind === 'instance-override'
    ? provChain[provChain.length - 1]
    : card
      ? { sourceId: card.sourceId, lineId: card.lineId, cardId: card.id }
      : { sourceId: s.unit.sources[0].id, lineId: '', cardId: '' };
  return {
    kind, sourceId: prov.sourceId, lineId: prov.lineId,
    scopePath: [prov.sourceId, scopeKey], dependsOn,
  };
}

function registerParam(
  s: State, scopeKey: string, name: string, raw: string,
  kind: ParamOrigin['kind'], cardId: ID, _dep: string[],
  provChain: HierarchyNode['provenance'][],
): void {
  const key = `${scopeKey}::${name.toUpperCase()}`;
  const isExpr = raw.startsWith('{') && raw.endsWith('}');
  const analysis = isExpr ? analyzeExpression(raw) : { body: raw, dependencies: [] as { name: string; raw: string }[], diagnostic: null as string | null };
  const parsed = isExpr ? nullNumeric(raw, true) : parseSpiceNumber(raw);
  const value: ParamValue = {
    raw, isExpression: isExpr,
    numeric: parsed.numeric,
    unit: parsed.unit,
    diagnostic: parsed.diagnostic ?? analysis.diagnostic,
  };
  const origin = originFor(kind, cardId, s, scopeKey, provChain, analysis.dependencies.map((d) => d.name));
  const existing = s.scoped.get(key);
  if (!existing) {
    s.scoped.set(key, { key, name, value: kind === 'subckt-default' ? value : value, origin, overrides: [{ value, origin }] });
  } else {
    existing.overrides.push({ value, origin });
    // 实例覆盖 > .PARAM 后写 > 默认；默认永不顶掉覆盖
    const rank: Record<ParamOrigin['kind'], number> = {
      'instance-override': 3, 'dot-param': 2, 'subckt-default': 1,
      'model-param': 0, builtin: 0,
    };
    if (rank[kind] >= rank[existing.origin.kind]) {
      existing.value = value;
      existing.origin = origin;
    }
  }
  if (!isExpr && parsed.diagnostic && parsed.numeric === null) {
    s.diagnostics.push({ code: 'PARAM_UNPARSEABLE', message: `${key}=${raw}: ${parsed.diagnostic}`, subjectId: key });
  }
}

function nullNumeric(raw: string, isExpression: boolean): ParamValue {
  return { raw, isExpression, numeric: null, unit: { si: null, unit: '', suffix: null }, diagnostic: null };
}

/** 解析作用域内一个值引用：数字字面量 / {表达式} / 裸参数名 */
function resolveValue(s: State, scopeKey: string, raw: string): ParamValue {
  const isExpr = raw.startsWith('{') && raw.endsWith('}');
  if (isExpr) {
    const a = analyzeExpression(raw);
    const env = buildEnv(s, scopeKey, a.dependencies.map((d) => d.name), new Set());
    if (env === null) {
      return { raw, isExpression: true, numeric: null, unit: { si: null, unit: '', suffix: null }, diagnostic: 'unresolved-expression-dependency' };
    }
    const r = evaluate(a.body, env);
    return {
      raw, isExpression: true, numeric: r.value,
      unit: r.value === null ? { si: null, unit: '', suffix: null } : { si: r.value, unit: '', suffix: null },
      diagnostic: r.diagnostic,
    };
  }
  const asParam = lookupParam(s, scopeKey, raw.toUpperCase());
  if (asParam) {
    // 裸参数引用：返回被引用参数的有效值，但保留原始 token
    return { ...asParam.value, raw };
  }
  const p = parseSpiceNumber(raw);
  return { raw, isExpression: false, numeric: p.numeric, unit: p.unit, diagnostic: p.diagnostic };
}

function lookupParam(s: State, scopeKey: string, upperName: string): ScopedParam | null {
  // 从当前作用域逐层向外：scopeKey 是路径，逐层截断
  const parts = scopeKey.split('.');
  for (let i = parts.length; i >= 1; i--) {
    const candidate = `${parts.slice(0, i).join('.')}::${upperName}`;
    const p = s.scoped.get(candidate);
    if (p) return p;
  }
  return null;
}

/** 构造表达式环境；某依赖无法解析（多候选/缺失/环）则返回 null（不猜值） */
function buildEnv(
  s: State, scopeKey: string, names: string[],
  stack: Set<string>,
): Map<string, number> | null {
  const env = new Map<string, number>();
  for (const name of names) {
    const p = lookupParam(s, scopeKey, name);
    if (!p) return null;
    if (p.value.numeric === null) {
      if (stack.has(p.key)) return null; // 表达式环
      if (p.value.isExpression) {
        const a = analyzeExpression(p.value.raw);
        stack.add(p.key);
        const inner = buildEnv(s, p.origin.scopePath[1] ?? scopeKey, a.dependencies.map((d) => d.name), stack);
        stack.delete(p.key);
        if (!inner) return null;
        const r = evaluate(a.body, inner);
        if (r.value === null) return null;
        env.set(name, r.value);
        continue;
      }
      return null;
    }
    env.set(name, p.value.numeric);
  }
  return env;
}

/** 把作用域内节点名映射到全局 canonical 网络；端口节点绑定外部，内部节点路径限定 */
function bindNet(
  s: State, rawNode: string, portIndex: number, portNets: string[],
  def: SubcktDef | null, instancePath: string,
): { netId: ID; canonical: string } {
  if (def && portIndex < def.ports.length && def.ports[portIndex].toUpperCase() === rawNode.toUpperCase()) {
    const canonical = portNets[portIndex];
    return ensureNet(s, canonical, instancePath, rawNode);
  }
  // 全局地/零节点保持同一网络
  if (rawNode === '0' || rawNode.toUpperCase() === 'GND!') {
    return ensureNet(s, '0', instancePath, rawNode);
  }
  const canonical = def ? `${instancePath}.${rawNode}` : rawNode;
  return ensureNet(s, canonical, instancePath, rawNode);
}

function ensureNet(s: State, canonical: string, devicePath: string, rawNode: string) {
  let net = s.nets.get(canonical);
  if (!net) {
    net = { id: stableId('net', canonical), canonical, members: [], external: !canonical.includes('.') };
    s.nets.set(canonical, net);
  }
  if (!net.members.some((m) => m.devicePath === devicePath && m.rawNode === rawNode)) {
    net.members.push({ devicePath, rawNode });
  }
  return { netId: net.id, canonical };
}

function expandDevice(
  s: State, parentPath: string, el: ElementCard, card: { id: ID; sourceId: string; lineId: ID },
  portNets: string[], def: SubcktDef | null,
  provChain: HierarchyNode['provenance'][], scopeKey: string,
): void {
  const devicePath = `${parentPath}.${el.name}`;
  const prefix = el.typePrefix;
  const family: DeviceFamily = FAMILY[prefix] ?? 'unknown';
  const pinNames = PIN_NAMES[prefix];
  const pins: FlatDevice['pins'] = [];

  if (el.opaque || !pinNames) {
    // 未知元件：每个出现的节点都保留为 opaque pin（pin1..pinN），不删除连接
    el.nodeTokens.forEach((nt, i) => {
      const { netId } = bindNet(s, nt.text, i, portNets, def, devicePath);
      pins.push({ pin: `pin${i + 1}`, netId, rawNode: nt.text });
    });
  } else {
    el.nodeTokens.forEach((nt, i) => {
      const { netId } = bindNet(s, nt.text, i, portNets, def, devicePath);
      pins.push({ pin: pinNames[i] ?? `pin${i + 1}`, netId, rawNode: nt.text });
    });
    if (el.nodeTokens.length < pinNames.length) {
      s.diagnostics.push({
        code: 'DEVICE_MISSING_NODES',
        message: `${devicePath} 节点数 ${el.nodeTokens.length} 少于 ${family} 期望 ${pinNames.length}`,
        subjectId: devicePath,
      });
    }
  }

  const params: FlatParam[] = [];
  for (const pt of el.paramTokens) {
    const eff = resolveValue(s, scopeKey, pt.value.text);
    const origin: ParamOrigin = {
      kind: 'instance-override',
      sourceId: card.sourceId, lineId: card.lineId,
      scopePath: [card.sourceId, scopeKey], dependsOn: eff.isExpression
        ? analyzeExpression(pt.value.text).dependencies.map((d) => d.name)
        : [],
    };
    params.push({ name: pt.name.text, effective: eff, origin, defaultValue: null, overrideValue: eff });
  }
  // R/C/L 的位置数值（电阻值/电容/电感）
  if (['R', 'C', 'L', 'V', 'I'].includes(prefix) && el.positional.length > 0) {
    const valueTok = el.positional[0];
    const eff = resolveValue(s, scopeKey, valueTok.text);
    const pname = prefix === 'R' ? 'resistance' : prefix === 'C' ? 'capacitance' : prefix === 'L' ? 'inductance' : prefix === 'V' ? 'dc' : 'dc';
    const origin: ParamOrigin = {
      kind: 'instance-override', sourceId: card.sourceId, lineId: card.lineId,
      scopePath: [card.sourceId, scopeKey],
      dependsOn: eff.isExpression ? analyzeExpression(valueTok.text).dependencies.map((d) => d.name) : [],
    };
    params.unshift({ name: pname, effective: eff, origin, defaultValue: null, overrideValue: eff });
  }

  const provenance = [
    ...provChain,
    { sourceId: card.sourceId, lineId: card.lineId, cardId: card.id },
  ];
  const device: FlatDevice = {
    id: stableId('dev', devicePath),
    path: devicePath,
    localName: el.name,
    family,
    prefix,
    modelRef: el.refName
      ? { name: el.refName, identity: s.unit.models[el.refName]?.[0]?.identity ?? null }
      : null,
    pins,
    params,
    provenance,
    symmetricPinGroups: el.opaque ? [] : (SYMMETRIES[family] ?? []),
    opaque: el.opaque,
  };
  s.devices.push(device);
}

function expandInstance(
  s: State, parentPath: string, el: ElementCard,
  card: { id: ID; sourceId: string; lineId: ID },
  portNets: string[], def: SubcktDef | null,
  provChain: HierarchyNode['provenance'][], scopeKey: string,
): void {
  const instPath = `${parentPath}.${el.name}`;
  const subName = el.refName ?? '';
  const defs = subName ? s.unit.subckts[subName] ?? [] : [];

  if (defs.length === 0) {
    s.diagnostics.push({
      code: 'SUBCKT_NOT_FOUND',
      message: `实例 ${instPath} 引用未定义子电路 "${subName}"，保留为 opaque`,
      subjectId: instPath,
    });
    // 未定义 X：作为 opaque unknown 器件保留全部连接，不删除
    const pins: FlatDevice['pins'] = el.nodeTokens.map((nt, i) => {
      const { netId } = bindNet(s, nt.text, i, portNets, def, instPath);
      return { pin: `pin${i + 1}`, netId, rawNode: nt.text };
    });
    s.devices.push({
      id: stableId('dev', instPath), path: instPath, localName: el.name,
      family: 'unknown', prefix: 'X', modelRef: { name: subName, identity: null },
      pins, params: [], provenance: [...provChain, { sourceId: card.sourceId, lineId: card.lineId, cardId: card.id }],
      symmetricPinGroups: [], opaque: true,
    });
    return;
  }

  let chosen = defs[0];
  if (defs.length > 1) {
    // 子电路重名：不静默挑选——记录歧义，展开首个并把其余身份钉在诊断上
    chosen = defs[0];
    s.diagnostics.push({
      code: 'SUBCKT_DUPLICATE_NAME',
      message: `子电路名 "${subName}" 有 ${defs.length} 个定义：${defs.map((d) => d.identity).join(', ')}；当前展开 ${chosen.identity}（候选未删除）`,
      subjectId: instPath,
    });
  }

  // 实例实参：named 参数覆盖；positional 中超出端口数的也保留为参数
  const named = new Map<string, string>();
  for (const p of el.paramTokens) named.set(p.name.text.toUpperCase(), p.value.text);

  // 绑定端口网络（在父作用域里把节点映射成 canonical）
  const childPortNets: string[] = chosen.ports.map((_, i) => {
    const nt = el.nodeTokens[i];
    if (!nt) return `${instPath}.<open-port-${i + 1}>`;
    const { canonical } = bindNet(s, nt.text, i, portNets, def, instPath);
    return canonical;
  });

  const hNode = node(
    instPath, el.name, `h_${parentPath}`, chosen.identity,
    el.paramTokens.map((p) => ({ name: p.name.text, raw: p.value.text })),
    { sourceId: card.sourceId, lineId: card.lineId, cardId: card.id },
  );
  s.hierarchy.push(hNode);
  const parentH = s.hierarchy.find((h) => h.id === `h_${parentPath}`);
  parentH?.children.push(hNode.id);

  instantiateScope(
    s, instPath, chosen, childPortNets,
    el.nodeTokens.map((t) => t.text), named,
    [...provChain, { sourceId: card.sourceId, lineId: card.lineId, cardId: card.id }],
  );
}
