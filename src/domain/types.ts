export type Id = string;
export type Side = 'A' | 'B';

export interface SourceFileRecord {
  id: Id; // sf_* 逻辑文件身份（跨修订稳定）
  rev: number; // 修订号，从 1 开始
  side: Side | 'shared';
  path: string; // 集合内逻辑路径，如 A/main.cir
  rawText: string; // 原文，不改写
  sha256: string;
  importedAt: string;
}

export interface PhysicalLine {
  lineNo: number; // 1-based 物理行号
  text: string; // 原始物理行，不改写
}

export interface LogicalLine {
  index: number; // 0-based 逻辑行号
  raw: string; // 续接后的原始文本（保留 '+' 续行符）
  physicalLines: PhysicalLine[];
}

export type StmtKind =
  | 'title'
  | 'comment'
  | 'param'
  | 'subckt'
  | 'ends'
  | 'model'
  | 'include'
  | 'lib'
  | 'endcard'
  | 'control'
  | 'element'
  | 'unknown-directive';

export interface ParamAssign {
  name: string;
  expr: string; // 原文表达式，不改写
}

export interface ElementStmt {
  name: string;
  prefix: string; // 首字母大写
  nodes: string[];
  modelOrSubckt?: string;
  params: ParamAssign[];
  positionalValues: string[]; // 无名值原文（如 1k、{gain*1k}）
  opaque: boolean; // 未知元件 → opaque，保留连接不删除
}

export interface Statement {
  id: Id; // st_*
  fileId: Id;
  rev: number;
  logicalIndex: number;
  kind: StmtKind;
  raw: string; // 原文（含续行符），不改写
  physicalLines: PhysicalLine[];
  tokens: string[]; // 解析视图（派生）
  element?: ElementStmt;
  subckt?: { name: string; portNodes: string[]; defaults: ParamAssign[] };
  param?: ParamAssign[];
  model?: { name: string; type: string; params: ParamAssign[] };
  include?: { target: string };
  diagnostics: Diagnostic[];
}

export interface Diagnostic {
  id: Id; // dg_*
  severity: 'info' | 'warning' | 'error';
  code: string;
  message: string;
  fileId?: Id;
  stmtId?: Id;
  path?: string; // 作用域 / 实例路径
  value?: string; // 原始值
}

export interface UnitValue {
  raw: string; // 原始表示，不改写
  number?: number;
  suffix?: string; // 原始后缀文本
  trailing?: string; // 已知后缀之后的尾随文本（SPICE 惯例忽略但记录）
  normalized?: number; // 派生层规范化 SI 值
  status: 'ok' | 'unknown-suffix' | 'unparseable';
  diagnostic?: Diagnostic;
}

export interface ParsedFile {
  fileId: Id;
  rev: number;
  statements: Statement[];
  diagnostics: Diagnostic[];
}

export type ParamSourceKind = 'instance-override' | 'subckt-default' | 'subckt-local' | 'global-param' | 'builtin';

export interface ParamSource {
  kind: ParamSourceKind;
  stmtId?: Id; // 来源语句（稳定身份）
  fileId?: Id;
  scopePath: string; // 绑定发生的作用域路径
  detail: string;
}

export interface ParamBinding {
  name: string;
  exprRaw: string; // 原文表达式
  deps: string[]; // 表达式依赖（不可压平）
  value?: number;
  error?: string;
  source: ParamSource;
}

export interface ScopeInfo {
  path: string; // '' 根；'/X1/X3' 实例路径
  subcktName?: string;
  parentPath?: string;
  params: ParamBinding[]; // 本作用域绑定（不含继承）
}

export interface SubcktDef {
  id: Id; // sd_*
  name: string;
  portNodes: string[];
  defaults: ParamAssign[];
  body: Statement[]; // 子电路体内语句（引用，不改写）
  stmtId: Id;
  fileId: Id;
  active: boolean; // 重名时只有生效定义 active
}

export interface ModelDef {
  id: Id; // mo_*
  name: string;
  type: string;
  params: { name: string; exprRaw: string; value?: number; unit?: UnitValue }[];
  stmtId: Id;
  fileId: Id;
  version: string; // model 版本标识（文件 sha + 语句）
}

export interface IncludeEdge {
  id: Id; // ie_*
  fromFileId: Id;
  stmtId: Id;
  target: string; // 原文 include 目标，不改写
  resolvedFileId?: Id;
  cycle: boolean;
  missing: boolean;
}

export interface HierarchyNode {
  id: Id; // hi_*
  name: string; // 实例名或 'root'
  subcktName?: string;
  scopePath: string;
  stmtId?: Id;
  fileId?: Id;
  children: HierarchyNode[];
}

export interface FlatDevice {
  id: Id; // dv_*
  path: string; // X1/X3/M2
  refDes: string;
  kind: string; // 前缀大写或 'X'
  modelOrSubckt?: string;
  nodes: { global: string; local: string }[];
  params: ResolvedParam[];
  opaque: boolean;
  stmtId: Id;
  fileId: Id;
}

export interface ResolvedParam {
  name: string;
  exprRaw: string; // 原文表达式，不改写
  deps: string[];
  value?: number;
  unit?: UnitValue;
  error?: string;
  source: ParamSource;
}

export interface FlatNetlist {
  id: Id; // fl_*
  side: Side;
  rootFileId: Id;
  rootRev: number;
  devices: FlatDevice[];
  nodes: string[]; // 全局节点名
  scopes: ScopeInfo[];
  hierarchy: HierarchyNode;
  subckts: SubcktDef[];
  models: ModelDef[];
  includes: IncludeEdge[];
  diagnostics: Diagnostic[];
}

export interface NodePair {
  left: string;
  right: string;
  kind: 'exact' | 'alpha-rename';
}

export interface CandidateMapping {
  id: Id; // cm_*
  nodeMap: Record<string, string>;
  devicePairs: { left: Id; right: Id; pinPermutation?: number[] }[];
  complete: boolean;
  note: string;
}

export interface MinimalDiff {
  id: Id; // md_*
  kind: 'device-unmatched' | 'param-mismatch' | 'model-mismatch' | 'node-mismatch' | 'opaque-unmatched';
  summary: string;
  devices: { side: Side; deviceId: Id }[];
  nodes: string[];
  params?: { deviceId: Id; name: string; left?: string; right?: string }[];
}

export interface RationaleEvent {
  id: Id; // re_*
  rule:
    | 'alpha-rename.nodes'
    | 'alpha-rename.instances'
    | 'param-scope.no-flatten'
    | 'param-default.keep'
    | 'expr-deps.keep'
    | 'unknown-element.opaque'
    | 'symmetric-device.permutation'
    | 'unit-suffix.normalize'
    | 'subckt.duplicate-name'
    | 'include.cycle';
  decision: 'accepted' | 'rejected' | 'observed';
  detail: string;
  refs: Id[];
}

export type EquivStatus = 'equivalent' | 'not-equivalent' | 'undetermined';

export interface EquivResult {
  id: Id; // eq_*
  leftFlatId: Id;
  rightFlatId: Id;
  status: EquivStatus;
  nodeCorrespondence: NodePair[];
  devicePairs: { left: Id; right: Id; note?: string }[];
  unmatched: { side: Side; deviceId: Id; reason: string }[];
  candidates: CandidateMapping[]; // 多解全部保留
  minimalDiffs: MinimalDiff[];
  rationale: RationaleEvent[];
  diagnostics: Diagnostic[];
}

export type DerivationKind = 'import' | 'parse' | 'flatten' | 'equivalence';

export interface Derivation {
  id: Id; // dr_<seq>_<kind>
  seq: number;
  kind: DerivationKind;
  inputs: Record<string, Id>;
  deps: Id[]; // 依赖的推导 id
  payload: unknown;
  diagnostics: Diagnostic[];
  createdAt: string;
}

export type EventType = 'import' | 'edit' | 'derive' | 'decision' | 'branch' | 'conflict' | 'replay' | 'note';

export interface ReviewEvent {
  id: Id; // ev_<seq>
  seq: number;
  type: EventType;
  parentId: Id | null;
  branch: string;
  actor: string;
  summary: string;
  payload: unknown;
  derivations: Id[]; // 该事件时刻生效的推导版本（钉住，可回放）
  createdAt: string;
}

export interface Branch {
  id: Id; // br_*
  name: string;
  baseEventId: Id;
  headEventId: Id;
  status: 'active' | 'kept-candidate' | 'merged';
  note: string;
}

export interface InvalidationReport {
  recomputed: { id: Id; kind: DerivationKind; reason: string }[];
  kept: { id: Id; kind: DerivationKind; reason: string }[];
  invalidated: { id: Id; kind: DerivationKind; reason: string }[];
}
