import { stableId } from "./ids.js";
import type { FlattenResult, FlatElement, FlatNode } from "./flatten.js";

/**
 * 节点/实例可 alpha-rename：外部端口按“有序端口角色”锚定，global 按名锚定，
 * 其余节点允许任意双射重命名。参数作用域/默认值/表达式依赖不参与重命名、不可压平。
 */

export interface ExternalAnchor {
  kind: "external" | "global";
  key: string;
  sideA: string | null;
  sideB: string | null;
}

export interface NodeMapping {
  id: string;
  /** flat node id: A -> B */
  nodeAtoB: Record<string, string>;
  /** instance path: A -> B */
  instAtoB: Record<string, string>;
  /** 该映射为何合法（锚定/传播依据，机器可读）。 */
  rationale: string[];
  /** 是否完整覆盖所有节点/实例。 */
  complete: boolean;
  score: number;
}

export type DifferenceKind =
  | "unmatched-instance"
  | "class-mismatch"
  | "model-mismatch"
  | "value-mismatch"
  | "parameter-mismatch"
  | "parameter-scope-mismatch"
  | "parameter-dependency-mismatch"
  | "unconvertible-value"
  | "arity-mismatch"
  | "opaque-vs-known"
  | "unmatched-node";

export interface Difference {
  id: string;
  kind: DifferenceKind;
  message: string;
  /** 涉及的元件/节点 id（A、B 可缺一侧）。 */
  elementAId: string | null;
  elementBId: string | null;
  nodeAId: string | null;
  nodeBId: string | null;
  /** 涉及参数（canonical），如有。 */
  paramCanonical: string | null;
  /** 原始值回显（不改写）。 */
  rawA: string | null;
  rawB: string | null;
  siA: number | null;
  siB: number | null;
}

export interface MinimalWitness {
  id: string;
  label: string;
  /** 该最小不等价子图包含的元件 id（两侧）。 */
  elementAIds: string[];
  elementBIds: string[];
  nodeAIds: string[];
  nodeBIds: string[];
  differenceIds: string[];
  /** 为什么这是“最小”：再移除任一元件即无差异。 */
  minimalityReason: string;
}

export interface EquivalenceReport {
  id: string;
  ruleVersion: string;
  equivalent: boolean;
  status: "equivalent" | "inequivalent" | "ambiguous" | "error";
  mappings: NodeMapping[];
  selectedMappingId: string | null;
  differences: Difference[];
  witnesses: MinimalWitness[];
  anchors: ExternalAnchor[];
  opaqueA: string[];
  opaqueB: string[];
  diagnostics: string[];
  /** 参与计算的输入版本指纹，用于重算依赖判断。 */
  inputFingerprint: string;
}

export const RULE_VERSION = "equiv-1.0.0";

export interface EquivalenceOptions {
  /** 数值等价容差（相对）。 */
  relTol?: number;
  absTol?: number;
  /** 最多保留的合法对称映射数量（防止组合爆炸，默认 24）。 */
  maxMappings?: number;
}

const EPS_REL = 1e-9;
const EPS_ABS = 1e-15;

function numsEqual(a: number | null, b: number | null, rel: number, abs: number): boolean {
  if (a === null || b === null) return false;
  if (a === b) return true;
  const scale = Math.max(1, Math.abs(a), Math.abs(b));
  return Math.abs(a - b) <= abs + rel * scale;
}

interface Sig {
  classLetter: string;
  modelKey: string | null;
  valueKey: string;
  opaque: boolean;
  paramSig: string;
}

function elementSemanticKey(el: FlatElement, flat: FlattenResult): Sig {
  const paramMap = new Map<string, import("./flatten.js").FlatParam>(
    el.params.map((id) => {
      const fp = flat.params.find((p) => p.id === id)!;
      return [fp.canonicalName, fp] as const;
    })
  );
  const paramParts: string[] = [];
  for (const [k, fp] of [...paramMap.entries()].sort()) {
    paramParts.push(`${k}=${fp.siValue ?? "?"}(${fp.diagnostic ?? "ok"})<${fp.resolutionOrder.join(",")}>`);
  }
  return {
    classLetter: el.classLetter,
    modelKey: el.modelNameRaw?.toLowerCase() ?? null,
    valueKey: el.siValue === null ? `raw:${el.valueRaw ?? "null"}` : `si:${el.siValue}`,
    opaque: el.opaque,
    paramSig: paramParts.join(";")
  };
}

function sigEqual(a: Sig, b: Sig, rel: number, abs: number, diffs: Difference[], elA: FlatElement, elB: FlatElement, FA: FlattenResult, FB: FlattenResult): boolean {
  let ok = true;
  if (a.opaque || b.opaque) {
    // opaque 元件：仅当两侧都 opaque 且 classLetter/连接数一致才算同形状；语义未知不删除
    if (!(a.opaque && b.opaque && a.classLetter === b.classLetter)) {
      diffs.push(mkDiff("opaque-vs-known", elA, elB,
        `opaque status differs: ${elA.opaqueReason ?? ""} vs ${elB.opaqueReason ?? ""}`));
      ok = false;
    }
    return ok;
  }
  if (a.classLetter !== b.classLetter) {
    diffs.push(mkDiff("class-mismatch", elA, elB,
      `class ${elA.classLetter} vs ${elB.classLetter}`));
    ok = false;
  }
  if (a.modelKey !== b.modelKey) {
    diffs.push(mkDiff("model-mismatch", elA, elB,
      `model ${elA.modelNameRaw ?? "-"} vs ${elB.modelNameRaw ?? "-"}`));
    ok = false;
  }
  // 值比较：优先 si 值；任一无法转换则 raw 保留并给 unconvertible 差异，而不是删数据
  const va = elA.siValue;
  const vb = elB.siValue;
  if (va !== null && vb !== null) {
    if (!numsEqual(va, vb, rel, abs)) {
      diffs.push(mkDiff("value-mismatch", elA, elB,
        `value ${elA.valueRaw} vs ${elB.valueRaw} (SI ${va} vs ${vb})`));
      ok = false;
    }
  } else if (elA.valueRaw !== null || elB.valueRaw !== null) {
    if ((elA.valueRaw ?? null) !== (elB.valueRaw ?? null)) {
      const diagA = elA.valueDiagnostic ?? "";
      const diagB = elB.valueDiagnostic ?? "";
      diffs.push(mkDiff(
        /unresolved|deferred|not-a|unknown/.test(diagA + diagB) ? "unconvertible-value" : "value-mismatch",
        elA, elB,
        `unconverted/raw value ${elA.valueRaw ?? "-"} vs ${elB.valueRaw ?? "-"} [${diagA} | ${diagB}]`
      ));
      ok = false;
    }
  }
  // 参数签名比较：含 resolutionOrder，确保作用域差异不被压平
  if (a.paramSig !== b.paramSig) {
    const mapA = new Map<string, import("./flatten.js").FlatParam>(elA.params.map((id) => {
      const fp = FA.params.find((p) => p.id === id)!;
      return [fp.canonicalName, fp] as const;
    }));
    const mapB = new Map<string, import("./flatten.js").FlatParam>(elB.params.map((id) => {
      const fp = FB.params.find((p) => p.id === id)!;
      return [fp.canonicalName, fp] as const;
    }));
    const keys = new Set([...mapA.keys(), ...mapB.keys()]);
    for (const key of [...keys].sort()) {
      const pa = mapA.get(key);
      const pb = mapB.get(key);
      if (!pa || !pb) {
        diffs.push(mkParamDiff("parameter-mismatch", elA, elB, key,
          pa?.valueRaw ?? null, pb?.valueRaw ?? null, pa?.siValue ?? null, pb?.siValue ?? null));
        ok = false; continue;
      }
      if (pa.resolutionOrder.join(",") !== pb.resolutionOrder.join(",") ||
          pa.scopePath.map((x) => x.toLowerCase()).join(",") !== pb.scopePath.map((x) => x.toLowerCase()).join(",")) {
        diffs.push(mkParamDiff("parameter-scope-mismatch", elA, elB, key,
          pa.valueRaw, pb.valueRaw, pa.siValue ?? null, pb.siValue ?? null));
        ok = false;
      }
      const depsA = pa.dependsOn.join(",");
      const depsB = pb.dependsOn.join(",");
      if (depsA !== depsB) {
        diffs.push(mkParamDiff("parameter-dependency-mismatch", elA, elB, key,
          pa.valueRaw, pb.valueRaw, pa.siValue ?? null, pb.siValue ?? null));
        ok = false;
      }
      if (!numsEqual(pa.siValue, pb.siValue, rel, abs)) {
        diffs.push(mkParamDiff("parameter-mismatch", elA, elB, key,
          pa.valueRaw, pb.valueRaw, pa.siValue, pb.siValue));
        ok = false;
      }
    }
  }
  return ok;
}


let diffCounter = 0;
function mkDiff(kind: DifferenceKind, a: FlatElement | null, b: FlatElement | null, message: string): Difference {
  diffCounter++;
  return {
    id: stableId("df", [kind, a?.id ?? "-", b?.id ?? "-", message, diffCounter]),
    kind, message,
    elementAId: a?.id ?? null, elementBId: b?.id ?? null,
    nodeAId: null, nodeBId: null, paramCanonical: null,
    rawA: a?.valueRaw ?? null, rawB: b?.valueRaw ?? null,
    siA: a?.siValue ?? null, siB: b?.siValue ?? null
  };
}
function mkParamDiff(
  kind: DifferenceKind, a: FlatElement, b: FlatElement, key: string,
  rawA: string | null, rawB: string | null, siA: number | null, siB: number | null
): Difference {
  diffCounter++;
  return {
    id: stableId("df", [kind, a.id, b.id, key, diffCounter]),
    kind,
    message: `parameter '${key}': ${rawA ?? "-"} vs ${rawB ?? "-"}`,
    elementAId: a.id, elementBId: b.id,
    nodeAId: null, nodeBId: null, paramCanonical: key,
    rawA, rawB, siA, siB
  };
}

type NodeMap = Map<string, string>; // A node id -> B node id
type InstMap = Map<string, string>; // A element id -> B element id

interface SearchState {
  nodeMap: NodeMap;
  instMap: InstMap;
  rationale: string[];
}

export function compareEquivalence(
  FA: FlattenResult,
  FB: FlattenResult,
  options: EquivalenceOptions = {}
): EquivalenceReport {
  const rel = options.relTol ?? EPS_REL;
  const abs = options.absTol ?? EPS_ABS;
  const maxMappings = options.maxMappings ?? 24;
  diffCounter = 0;

  // 1) 锚点：external 按顶层端口出现顺序配对；global 按名配对
  const anchors = buildAnchors(FA, FB);
  const initNodeMap = new Map<string, string>();
  const rationale: string[] = [];
  for (const an of anchors) {
    if (an.sideA && an.sideB) {
      initNodeMap.set(an.sideA, an.sideB);
      rationale.push(`anchor(${an.kind}):${an.key}`);
    }
  }

  // 2) 按元件语义签名分组（不含节点连接，用于候选剪枝）
  const sigA = new Map(FA.elements.map((e) => [e.id, elementSemanticKey(e, FA)] as const));
  const sigB = new Map(FB.elements.map((e) => [e.id, elementSemanticKey(e, FB)] as const));

  // 邻接：node -> elements
  const adjA = nodeAdjacency(FA);
  const adjB = nodeAdjacency(FB);

  // 3) 同构搜索（带语义剪枝 + 对称枚举）
  const solutions: SearchState[] = [];
  search(FA, FB, sigA, sigB, adjA, adjB, initNodeMap, new Map(), rationale, solutions, maxMappings);

  // 4) 对每个完整映射求差异；挑选差异最少的映射作为 selected，其余作为合法候选保留（多解不吞掉）
  interface Scored { state: SearchState; diffs: Difference[]; mappingId: string }
  const scored: Scored[] = [];
  const mappings: NodeMapping[] = [];
  for (const state of solutions) {
    const diffs: Difference[] = [];
    semanticDiffsForMapping(state, FA, FB, rel, abs, diffs);
    const complete = state.instMap.size === FA.elements.length && FB.elements.every((b) =>
      [...state.instMap.values()].includes(b.id));
    const mappingId = stableId("map", [
      JSON.stringify([...state.nodeMap.entries()].sort()),
      JSON.stringify([...state.instMap.entries()].sort())
    ]);
    mappings.push({
      id: mappingId,
      nodeAtoB: Object.fromEntries(state.nodeMap),
      instAtoB: Object.fromEntries([...state.instMap].map(([a, b]) => {
        const ea = FA.elements.find((x) => x.id === a)!;
        const eb = FB.elements.find((x) => x.id === b)!;
        return [ea.instancePath, eb.instancePath];
      })),
      rationale: state.rationale,
      complete,
      score: -diffs.length
    });
    scored.push({ state, diffs, mappingId });
  }
  scored.sort((x, y) => x.diffs.length - y.diffs.length);
  const best: Scored | null = scored[0] ?? null;

  let differences: Difference[] = [];
  if (best) {
    differences = best.diffs;
  } else {
    // 连结构同构都不成立：报告无法匹配的实例
    for (const el of FA.elements) {
      differences.push(mkDiff("unmatched-instance", el, null, `unmatched instance ${el.instancePath}`));
    }
  }

  const witnesses = buildWitnesses(differences, best?.state ?? null, FA, FB);
  const equivalent = differences.length === 0 && mappings.some((m) => m.complete);
  const status: EquivalenceReport["status"] = equivalent
    ? "equivalent"
    : (mappings.length > 1 ? "ambiguous" : "inequivalent");

  const fingerprint = stableId("fp", [
    FA.side, FA.elements.length, FA.nodes.length,
    FB.side, FB.elements.length, FB.nodes.length,
    RULE_VERSION
  ]);

  return {
    id: stableId("rep", [fingerprint, mappings.length, differences.length]),
    ruleVersion: RULE_VERSION,
    equivalent,
    status,
    mappings,
    selectedMappingId: best?.mappingId ?? null,
    differences,
    witnesses,
    anchors,
    opaqueA: FA.elements.filter((e) => e.opaque).map((e) => e.id),
    opaqueB: FB.elements.filter((e) => e.opaque).map((e) => e.id),
    diagnostics: [],
    inputFingerprint: fingerprint
  };
}

function buildAnchors(FA: FlattenResult, FB: FlattenResult): ExternalAnchor[] {
  const out: ExternalAnchor[] = [];
  // 顶层外部节点：以展平后“路径即原名”出现顺序作为端口次序锚定
  const extA = FA.nodes.filter((n) => n.kind === "external");
  const extB = FB.nodes.filter((n) => n.kind === "external");
  const n = Math.max(extA.length, extB.length);
  for (let i = 0; i < n; i++) {
    out.push({
      kind: "external",
      key: `port#${i}(${extA[i]?.localNameRaw ?? extB[i]?.localNameRaw ?? "?"})`,
      sideA: extA[i]?.id ?? null,
      sideB: extB[i]?.id ?? null
    });
  }
  const gA = new Map(FA.nodes.filter((x) => x.kind === "global").map((x) => [x.localNameRaw.toLowerCase(), x.id]));
  const gB = new Map(FB.nodes.filter((x) => x.kind === "global").map((x) => [x.localNameRaw.toLowerCase(), x.id]));
  for (const name of new Set([...gA.keys(), ...gB.keys()])) {
    out.push({ kind: "global", key: name!, sideA: gA.get(name!) ?? null, sideB: gB.get(name!) ?? null });
  }
  return out;
}

function nodeAdjacency(flat: FlattenResult): Map<string, { el: FlatElement; portIndex: number }[]> {
  const m = new Map<string, { el: FlatElement; portIndex: number }[]>();
  for (const el of flat.elements) {
    el.nodeIds.forEach((nid, i) => {
      const arr = m.get(nid) ?? [];
      arr.push({ el, portIndex: i });
      m.set(nid, arr);
    });
  }
  return m;
}

function portsCompatible(elA: FlatElement, elB: FlatElement, nodeMap: NodeMap): boolean {
  if (elA.nodeIds.length !== elB.nodeIds.length) return false;
  for (let i = 0; i < elA.nodeIds.length; i++) {
    const a = elA.nodeIds[i]!;
    const b = elB.nodeIds[i]!;
    const mapped = nodeMap.get(a);
    if (mapped !== undefined && mapped !== b) return false;
  }
  return true;
}

function sigCompatible(
  sA: Sig, sB: Sig, FA: FlattenResult, FB: FlattenResult,
  elA: FlatElement, elB: FlatElement
): boolean {
  // 结构候选阶段使用“宽松签名”：class/model/opaque/端口数一致即可；
  // 数值与参数差异在语义阶段记录（这样对称置换仍枚举，差异保留）。
  if (sA.classLetter !== sB.classLetter) return false;
  if (sA.modelKey !== sB.modelKey) return false;
  if (sA.opaque !== sB.opaque) return false;
  if (elA.nodeIds.length !== elB.nodeIds.length) return false;
  void FA; void FB;
  return true;
}

function search(
  FA: FlattenResult, FB: FlattenResult,
  sigA: Map<string, Sig>, sigB: Map<string, Sig>,
  adjA: Map<string, { el: FlatElement; portIndex: number }[]>,
  adjB: Map<string, { el: FlatElement; portIndex: number }[]>,
  initNodeMap: NodeMap,
  initInstMap: InstMap,
  initRationale: string[],
  solutions: SearchState[],
  maxMappings: number
) {
  // 端口数量必须一致
  if (FA.elements.reduce((s, e) => s + e.nodeIds.length, 0) !==
      FB.elements.reduce((s, e) => s + e.nodeIds.length, 0)) return;

  const remainingA = new Set(FA.elements.map((e) => e.id));

  function rec(nodeMap: NodeMap, instMap: InstMap, rationale: string[]) {
    if (solutions.length >= maxMappings) return;
    if (remainingA.size === 0) {
      // 检查 B 侧节点是否都被映射（无悬空节点）
      const mappedB = new Set(nodeMap.values());
      const allBCovered = FB.nodes.every((n) => mappedB.has(n.id));
      if (allBCovered) {
        solutions.push({
          nodeMap: new Map(nodeMap),
          instMap: new Map(instMap),
          rationale: [...rationale]
        });
      }
      return;
    }
    // 选择约束最多的未匹配 A 元件：已落在已映射节点上的优先（连接传播）
    const next = pickMostConstrained(remainingA, adjA, nodeMap, FA);
    if (!next) return;
    remainingA.delete(next.id);

    const candidates = FB.elements.filter((b) =>
      !new Set(instMap.values()).has(b.id) &&
      sigCompatible(sigA.get(next.id)!, sigB.get(b.id)!, FA, FB, next, b) &&
      portsCompatible(next, b, nodeMap));

    for (const b of candidates) {
      for (const perm of portPermutations(next.classLetter, next.nodeIds.length)) {
        const { nodeMap: nm, ok } = applyPortsWithPerm(next, b, nodeMap, perm);
        if (!ok) continue;
        const im = new Map(instMap);
        im.set(next.id, b.id);
        const tag = perm.every((v, i) => v === i) ? "" : "|sym-perm";
        const r = [...rationale, `match(${next.instancePath}->${b.instancePath}${tag})`];
        rec(nm, im, r);
      }
    }
    remainingA.add(next.id);
  }

  rec(initNodeMap, initInstMap, initRationale);
}

function pickMostConstrained(
  remaining: Set<string>,
  adjA: Map<string, { el: FlatElement; portIndex: number }[]>,
  nodeMap: NodeMap,
  FA: FlattenResult
): FlatElement | null {
  let bestEl: FlatElement | null = null;
  let bestScore = -1;
  for (const id of remaining) {
    const el = FA.elements.find((x) => x.id === id)!;
    let score = 0;
    for (const nid of el.nodeIds) if (nodeMap.has(nid)) score += 10;
    // MRV：候选签名稀有度
    score += rarityBump(el);
    if (score > bestScore) { bestScore = score; bestEl = el; }
  }
  return bestEl;
}

function rarityBump(el: FlatElement): number {
  // 四端/opaque/带 model 元件更稀有，优先匹配
  let s = el.nodeIds.length;
  if (el.modelNameRaw) s += 2;
  if (el.opaque) s += 3;
  return s;
}

function applyPorts(
  elA: FlatElement, elB: FlatElement, prev: NodeMap
): { nodeMap: NodeMap; addedNodes: NodeMap; ok: boolean } {
  const nodeMap = new Map(prev);
  const added = new Map<string, string>();
  for (let i = 0; i < elA.nodeIds.length; i++) {
    const a = elA.nodeIds[i]!;
    const b = elB.nodeIds[i]!;
    const existing = nodeMap.get(a);
    if (existing !== undefined && existing !== b) return { nodeMap, addedNodes: added, ok: false };
    // 不允许两个不同 A 节点映到同一 B 节点（保持双射）
    const usedBy = [...nodeMap.entries()].find(([, vb]) => vb === b)?.[0];
    if (usedBy !== undefined && usedBy !== a) return { nodeMap, addedNodes: added, ok: false };
    if (existing === undefined) { nodeMap.set(a, b); added.set(a, b); }
  }
  return { nodeMap, addedNodes: added, ok: true };
}

function semanticDiffsForMapping(
  state: SearchState, FA: FlattenResult, FB: FlattenResult,
  rel: number, abs: number, diffs: Difference[]
) {
  for (const [aId, bId] of state.instMap) {
    const elA = FA.elements.find((e) => e.id === aId)!;
    const elB = FB.elements.find((e) => e.id === bId)!;
    const sA = elementSemanticKey(elA, FA);
    const sB = elementSemanticKey(elB, FB);
    // arity 在结构阶段已保证一致；这里重点是语义
    sigEqual(sA, sB, rel, abs, diffs, elA, elB, FA, FB);
  }
  // 无法在 A 找到对应的 B 元件（B 多出元件）
  const mappedB = new Set(state.instMap.values());
  for (const b of FB.elements) {
    if (!mappedB.has(b.id)) {
      diffs.push(mkDiff("unmatched-instance", null, b, `extra instance on B ${b.instancePath}`));
    }
  }
}

/**
 * 构造最小不等价子图：
 * - 每个语义属性差异（元件参数/值/model/class/opaque）本身构成一个最小证人；
 * - 未匹配实例按“通过未匹配/异常节点相连”做连通聚簇，形成结构证人。
 * 因而“多个最小差异”天然得到多个证人，而不是被压成一个大图。
 */
function buildWitnesses(
  diffs: Difference[],
  state: SearchState | null,
  FA: FlattenResult,
  FB: FlattenResult
): MinimalWitness[] {
  const witnesses: MinimalWitness[] = [];
  const structural = new Set<Difference>();

  for (const d of diffs) {
    if (d.kind === "unmatched-instance" || d.kind === "unmatched-node" || d.kind === "arity-mismatch") {
      structural.add(d);
      continue;
    }
    witnesses.push({
      id: stableId("wit", ["prop", d.id]),
      label: witnessLabel(d),
      elementAIds: d.elementAId ? [d.elementAId] : [],
      elementBIds: d.elementBId ? [d.elementBId] : [],
      nodeAIds: d.nodeAId ? [d.nodeAId] : [],
      nodeBIds: d.nodeBId ? [d.nodeBId] : [],
      differenceIds: [d.id],
      minimalityReason: "single-element property difference: removing this element removes the difference"
    });
  }

  if (structural.size > 0) {
    const badAElements = new Set<string>();
    const badBElements = new Set<string>();
    const badANodes = new Set<string>();
    const badBNodes = new Set<string>();
    for (const d of structural) {
      if (d.elementAId) badAElements.add(d.elementAId);
      if (d.elementBId) badBElements.add(d.elementBId);
      if (d.nodeAId) badANodes.add(d.nodeAId);
      if (d.nodeBId) badBNodes.add(d.nodeBId);
    }
    // 在“异常元件 + 其节点邻居”诱导子图上按连通性聚簇
    const clustersA = connectedClusters(badAElements, badANodes, FA);
    const clustersB = connectedClusters(badBElements, badBNodes, FB);
    const n = Math.max(clustersA.length, clustersB.length);
    for (let i = 0; i < n; i++) {
      const ca = clustersA[i] ?? { elements: [], nodes: [] };
      const cb = clustersB[i] ?? { elements: [], nodes: [] };
      const ids = [...structural].map((d) => d.id);
      witnesses.push({
        id: stableId("wit", ["struct", i, ca.elements.join(","), cb.elements.join(",")]),
        label: `structural witness #${i + 1}`,
        elementAIds: ca.elements,
        elementBIds: cb.elements,
        nodeAIds: ca.nodes,
        nodeBIds: cb.nodes,
        differenceIds: ids,
        minimalityReason: "connected component of unmatched/arity-difference elements; each component is disjoint and minimal"
      });
    }
  }
  return witnesses;
}

function witnessLabel(d: Difference): string {
  switch (d.kind) {
    case "value-mismatch": return "value difference";
    case "unconvertible-value": return "unconvertible value retained on both sides";
    case "model-mismatch": return "model version difference";
    case "class-mismatch": return "device class difference";
    case "parameter-mismatch": return `parameter '${d.paramCanonical}' differs`;
    case "parameter-scope-mismatch": return `parameter '${d.paramCanonical}' scope/source differs`;
    case "parameter-dependency-mismatch": return `parameter '${d.paramCanonical}' dependency differs`;
    case "opaque-vs-known": return "opaque vs recognized device";
    default: return d.kind;
  }
}

function connectedClusters(
  seedElements: Set<string>, seedNodes: Set<string>, flat: FlattenResult
): { elements: string[]; nodes: string[] }[] {
  const nodeToEls = new Map<string, Set<string>>();
  const elToNodes = new Map<string, Set<string>>();
  for (const el of flat.elements) {
    const ns = new Set(el.nodeIds);
    elToNodes.set(el.id, ns);
    for (const n of el.nodeIds) {
      const s = nodeToEls.get(n) ?? new Set<string>();
      s.add(el.id);
      nodeToEls.set(n, s);
    }
  }
  const seen = new Set<string>();
  const clusters: { elements: string[]; nodes: string[] }[] = [];
  for (const seed of seedElements) {
    if (seen.has(seed)) continue;
    const els = new Set<string>();
    const nodes = new Set<string>();
    const stack = [seed];
    while (stack.length) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      if (!seedElements.has(cur)) continue; // 只在种子元件间聚簇
      els.add(cur);
      for (const n of elToNodes.get(cur) ?? []) {
        nodes.add(n);
        for (const other of nodeToEls.get(n) ?? []) {
          if (seedElements.has(other) && !seen.has(other)) stack.push(other);
        }
      }
    }
    for (const n of seedNodes) {
      if ([...nodeToEls.get(n) ?? []].some((e) => els.has(e))) nodes.add(n);
    }
    clusters.push({ elements: [...els].sort(), nodes: [...nodes].sort() });
  }
  // 仅有节点种子（无元件）的情况
  for (const n of seedNodes) {
    const touched = clusters.some((c) => c.nodes.includes(n));
    if (!touched) clusters.push({ elements: [], nodes: [n] });
  }
  return clusters;
}

/**
 * 电气对称的端口可交换（alpha-rename 的一部分）：
 * - R/C/L/V/I/D/F/H/K：两端口任意交换；
 * - M/J/Q：对于本案例，保守地不自动交换（D 与 S 对 MOS 电气对称但 model 参数可能区分；
 *   仍可由审阅者通过候选选择）。需要时在 element 参数 symmetric=true 上扩展。
 * 这里默认仅 2 端元件对称，返回“恒等 + 交换”两种排列（去重）。
 */
function portPermutations(classLetter: string, arity: number): number[][] {
  const identity = Array.from({ length: arity }, (_, i) => i);
  if (arity === 2 && "rcldvifhk".includes(classLetter)) {
    return [identity, [1, 0]];
  }
  return [identity];
}

function applyPortsWithPerm(
  elA: FlatElement, elB: FlatElement, prev: NodeMap, perm: number[]
): { nodeMap: NodeMap; ok: boolean } {
  const nodeMap = new Map(prev);
  for (let i = 0; i < elA.nodeIds.length; i++) {
    const a = elA.nodeIds[i]!;
    const b = elB.nodeIds[perm[i]!]!;
    const existing = nodeMap.get(a);
    if (existing !== undefined && existing !== b) return { nodeMap, ok: false };
    const usedBy = [...nodeMap.entries()].find(([, vb]) => vb === b)?.[0];
    if (usedBy !== undefined && usedBy !== a) return { nodeMap, ok: false };
    if (existing === undefined) nodeMap.set(a, b);
  }
  return { nodeMap, ok: true };
}
