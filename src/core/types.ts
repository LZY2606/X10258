/** 核心领域类型。原始层(raw)永不规范化；派生层(derived)才做单位/表达式求值。 */

export interface RawFile {
  id: string;
  revisionId: string;
  path: string;
  content: string;
}

export interface RawLine {
  id: string;
  fileId: string;
  ordinal: number;
  text: string;
  physicalLines: { fileId: string; ordinal: number; text: string }[];
}

export type QuantityStatus = 'ok' | 'unresolved';

export interface Quantity {
  /** 原文本，例如 "10K"、"2.2u"、"3Meg"、"1 MEG"、"2nF" */
  raw: string;
  /** 规范化数值（SI 基准单位：电阻 Ω、电容 F、电感 H…），无法转换时为 null */
  value: number | null;
  unit: string | null;
  status: QuantityStatus;
  reason?: string;
  sourceLineId: string;
  tokenIndex: number;
}

export interface RawToken {
  text: string;
  index: number;
}

export type ParamOriginKind = 'global' | 'subckt-default' | 'instance-override' | 'unresolved';

export interface ParamOrigin {
  kind: ParamOriginKind;
  lineId: string;
  scopePath: string;
}

export interface ParamValue {
  rawExpr: string;
  origin: ParamOrigin;
}

export type ExprNode =
  | { t: 'num'; raw: string; value: number | null; suffix?: string }
  | { t: 'ref'; name: string }
  | { t: 'unary'; op: '-' | '+'; e: ExprNode }
  | { t: 'bin'; op: string; l: ExprNode; r: ExprNode }
  | { t: 'call'; name: string; args: ExprNode[] }
  | { t: 'opaque'; raw: string; reason: string };

export interface ParamResolution {
  value: number | null;
  status: QuantityStatus;
  reason?: string;
  /** 参与求值的参数名 → 作用域来源，构成依赖边 */
  deps: { name: string; origin: ParamOrigin }[];
  expressionText: string;
  origin: ParamOrigin;
}

export type ModelKind =
  | 'resistor' | 'capacitor' | 'inductor' | 'mosfet' | 'bjt'
  | 'diode' | 'voltage' | 'current' | 'unknown';

export interface ModelDef {
  id: string;
  branch: string;
  name: string;
  kind: ModelKind;
  level: string | null;
  params: { raw: string; value: string }[];
  bodyText: string;
  bodySha: string;
  lineIds: string[];
}

export interface SubcktDef {
  id: string;
  branch: string;
  name: string;
  ports: string[];
  bodyLines: string[];
  bodySha: string;
  lineIds: string[];
  endsLineId: string;
}

export interface RawElement {
  kindLetter: string;
  instanceName: string;
  tokens: string[];
  lineId: string;
  scopePath: string;
}

export interface FlatElement {
  id: string;
  branch: string;
  instancePath: string;
  kindLetter: string;
  instanceName: string;
  /** 展平后节点（分支局部稳定标识） */
  nodes: string[];
  modelRef: string | null;
  quantities: Quantity[];
  sourceLineIds: string[];
  opaque: boolean;
  opaqueReason?: string;
}

export interface FlatNode {
  id: string;
  branch: string;
  path: string;
  local: string;
  external: boolean;
}

export interface HierNode {
  id: string;
  branch: string;
  instancePath: string;
  subcktName: string | null;
  parentPath: string | null;
  sourceLineId: string;
  childPaths: string[];
}

export interface FlatNetlist {
  branch: string;
  elements: FlatElement[];
  nodes: FlatNode[];
  hierarchy: HierNode[];
  params: { scopePath: string; resolved: Record<string, ParamResolution> }[];
  models: ModelDef[];
  diagnostics: import('./diagnostic').Diagnostic[];
}

/** 等价裁定结果 */
export type Verdict = 'equivalent' | 'uncertain' | 'inequivalent';

export interface NodeMapping {
  a: string;
  b: string;
  reason: string;
}

export interface ElementMapping {
  a: string;
  b: string;
  permutation: number[];
  reason: string;
}

export interface MappingCandidate {
  id: string;
  nodeMapping: NodeMapping[];
  elementMapping: ElementMapping[];
  rationale: string[];
}

export interface MinimalDifference {
  id: string;
  aElementIds: string[];
  bElementIds: string[];
  nodeIds: { a: string[]; b: string[] };
  reason: string;
  kind: 'value' | 'connectivity' | 'device-semantics' | 'opaque' | 'param-scope';
}

export interface EquivalenceReport {
  ruleVersion: string;
  verdict: Verdict;
  candidates: MappingCandidate[];
  differences: MinimalDifference[];
  diagnostics: import('./diagnostic').Diagnostic[];
  rejectedCandidates: { candidate: MappingCandidate; why: string }[];
}

/** 事件流（机器可读、追加式） */
export type EventPayload =
  | { t: 'revision-created'; revisionId: string; label: string; parentRevisionId: string | null }
  | { t: 'file-ingested'; revisionId: string; file: { path: string; content: string } }
  | { t: 'include-resolved'; revisionId: string; fromPath: string; target: string; viaLineId: string }
  | { t: 'include-cycle'; revisionId: string; chain: string[] }
  | { t: 'subckt-collision'; revisionId: string; name: string; defIds: string[] }
  | { t: 'parse-diagnostic'; revisionId: string; branch: string; diagnostic: import('./diagnostic').Diagnostic }
  | { t: 'derivation-committed'; derivationId: string; ruleVersion: string; basisEventSeq: number; summary: Record<string, unknown> }
  | { t: 'derivation-invalidated'; derivationId: string; changedFileIds: string[]; affected: string[] }
  | { t: 'decision'; decisionId: string; branch: string; subject: string; chosen: string | null; rejected: string[]; note: string; baseEventSeq: number }
  | { t: 'conflict'; reason: string; expectedSeq: number; actualSeq: number };

export interface StoredEvent {
  seq: number;
  id: string;
  kind: string;
  payload: EventPayload;
  created: string;
}

export interface BundleFile {
  path: string;
  content: string;
}

export interface RevisionInput {
  revisionId: string;
  label: string;
  roots: Record<'A' | 'B', BundleFile[]>;
}
