// 核心领域类型：原始材料一律不改写，所有标识稳定可追溯。

/** 带原始坐标基准的文本片段 */
export interface RawLine {
  id: string;              // 稳定身份: `${sourceId}#L${lineNo}`
  sourceId: string;        // 来源材料 id
  lineNo: number;          // 1-based 物理行号
  raw: string;             // 原始文本（含续行前的原样，不做任何改写）
  logicalLineNo: number;   // 合并行续接后的逻辑行号
  continuationOf?: string; // 若为续行，指向首行 RawLine.id
}

export interface SourceFile {
  id: string;              // 稳定身份：导入时由路径/内容哈希确定
  origin: string;          // include 来源路径（原样保留）
  role: 'netlistA' | 'netlistB' | 'include' | 'model';
  text: string;            // 原文本，逐字节保留
  includedBy?: string;     // include 链：父 SourceFile.id
  includeRef?: string;     // 触发本文件的 .include 原文参数
}

export type DiagnosticLevel = 'error' | 'warning' | 'info';

export interface Diagnostic {
  id: string;
  code: string;
  message: string;
  level: DiagnosticLevel;
  rawLineId?: string;      // 定位到原始行
  sourceId?: string;
  value?: string;          // 无法转换时留在原位置的值
}

/** 带单位后缀的原始数值：raw 不改写，normalized 才规范化 */
export interface DimValue {
  raw: string;             // 例如 "10k"、"2.2u"、"1.5MEG"
  normalized?: number;     // SI 规范化数值；无法转换则缺省
  suffix?: string;         // 单位/倍率后缀原文
  unit?: string;           // 推断的物理量纲
  diagnosticId?: string;   // 无法转换时的诊断
}

/** SPICE 元件行的一个 token 引用（节点/参数/值），保留原文 */
export interface Token {
  raw: string;
  index: number;           // 在逻辑行内的列序号
}

export type DeviceKind =
  | 'resistor' | 'capacitor' | 'inductor'
  | 'voltage' | 'current'
  | 'mosfet' | 'bjt' | 'diode'
  | 'subckt-call'
  | 'unknown';

export interface ParamDef {
  id: string;              // `${scope}::${name}` 稳定身份
  name: string;
  rawExpr: string;         // 参数表达式原文，不改写
  default?: string;        // 默认值原文
  source: 'default' | 'instance-override' | 'model' | 'revision';
  rawLineId?: string;
}

export interface ModelCard {
  id: string;              // `${sourceId}::${kind}::${name}@v${version}`
  name: string;
  kind: string;            // nmos/pmos/npn/...
  versionKey: string;      // model 版本键（内容哈希）
  params: Record<string, string>; // 原文参数
  sourceId: string;
  rawLineId: string;
}

export interface Device {
  id: string;              // 展平后稳定实例身份（路径 + 序号）
  name: string;            // 实例名原文，如 X1 / M2 / Rtop
  kind: DeviceKind;
  nodes: string[];         // 展平后连接到的全局节点 id
  localNodes: string[];    // 子电路模板内局部节点名（原文）
  value?: DimValue;        // R/C/L/源 的值（带单位原文）
  modelRef?: string;       // model 卡引用原文
  modelVersionId?: string; // 解析后的 model 版本 id
  subcktName?: string;     // subckt-call 目标名（原文）
  params: ParamBinding[];  // 实例参数绑定
  path: string[];          // 层次路径（实例名序列）
  rawLineId: string;
  opaque?: boolean;        // unknown 元件：保留 opaque 连接
  symmetric?: boolean;     // 端子对称（如两端电阻），可置换
}

export interface ParamBinding {
  name: string;
  rawExpr: string;         // 覆盖表达式原文
  resolvedExpr?: string;   // 依赖解析后的表达式（派生层）
  resolvedValue?: number | string;
  rawLineId: string;
}

export interface SubcktDef {
  id: string;              // `${sourceId}#subckt:${name}`
  name: string;
  ports: string[];         // 端口局部名原文
  params: ParamDef[];
  bodyRawLineIds: string[];
  sourceId: string;
}

export interface ParsedNetlist {
  sourceId: string;
  lines: RawLine[];
  logical: LogicalLine[];
  diagnostics: Diagnostic[];
}

export interface LogicalLine {
  id: string;
  sourceId: string;
  logicalLineNo: number;
  rawLineIds: string[];    // 行续接的所有物理行
  text: string;            // 合并后的逻辑行（仅用于解析；原始物理行不改写）
  kind:
    | 'subckt' | 'ends' | 'device' | 'model' | 'include'
    | 'param' | 'control' | 'comment' | 'empty' | 'unknown';
}

export interface IncludeEdge {
  id: string;
  fromSourceId: string;
  rawLineId: string;
  ref: string;             // .include 原文参数
  resolvedSourceId?: string;
  cyclic: boolean;
}

export interface Scope {
  id: string;              // 实例路径派生的作用域身份
  path: string[];
  params: ParamDef[];
  parentId?: string;
}

/** 展平网表（派生层） */
export interface FlatNetlist {
  versionId: string;       // 派生版本身份
  devices: Device[];
  nodes: FlatNode[];
  scopes: Scope[];
  models: ModelCard[];
  diagnostics: Diagnostic[];
  includedSources: string[];
}

export interface FlatNode {
  id: string;              // 展平后全局稳定 id
  label: string;           // 显示标签（可 alpha-rename）
  originalNames: string[]; // 原始局部节点名来源
  external: boolean;       // 顶层端口
}

/** 参数来源链中的一环 */
export interface ParamProvenance {
  bindingId: string;
  scopeId: string;
  name: string;
  rawExpr: string;
  origin: 'default' | 'instance-override' | 'model' | 'revision';
  rawLineId?: string;
  dependsOn: string[];     // 表达式依赖的其他参数 bindingId
  value?: number | string;
  valid: boolean;          // 当前依赖下是否仍有效
  invalidReason?: string;
}

export interface NodeCorrespondence {
  id: string;              // 对应关系稳定身份
  nodeA: string;
  nodeB: string;
  basis: 'name' | 'external-port' | 'isomorphism' | 'manual';
  confidence: number;      // 0..1，不确定时 <1
  candidates?: string[];   // 无法唯一决定时的全部合法候选（节点 B 候选）
}

export interface InstanceCorrespondence {
  id: string;
  deviceA: string;
  deviceB: string;
  kind: DeviceKind;
  symmetricPermutation?: number[]; // 对称器件端子置换
}

export type EquivStatus =
  | 'equivalent'
  | 'not-equivalent'
  | 'ambiguous'   // 多解/不确定，不吞掉
  | 'error';

export interface MinimalDiff {
  id: string;
  reason: string;
  devicesA: string[];
  devicesB: string[];
  nodes: string[];
  params: string[];
}

export interface EquivalenceReport {
  versionId: string;
  status: EquivStatus;
  nodeMap: NodeCorrespondence[];
  instanceMap: InstanceCorrespondence[];
  paramDiffs: ParamDiff[];
  modelDiffs: ModelDiff[];
  opaqueDevices: { side: 'A' | 'B'; deviceId: string }[];
  minimalDiffs: MinimalDiff[];
  candidates: Ambiguity[];
}

export interface ParamDiff {
  id: string;
  bindingA?: string;
  bindingB?: string;
  name: string;
  rawA?: string;
  rawB?: string;
  valueA?: number | string;
  valueB?: number | string;
  same: boolean;
  reason: string;
}

export interface ModelDiff {
  id: string;
  modelA?: string;
  modelB?: string;
  name: string;
  same: boolean;
  changedParams: string[];
}

export interface Ambiguity {
  id: string;
  kind: 'node-mapping' | 'symmetric' | 'unknown-device' | 'unresolved-param';
  description: string;
  options: string[];
  related: string[];
}

/** 机器可读取的裁定/溯源事件 */
export interface TraceEvent {
  id: string;              // 稳定事件身份
  seq: number;             // 全序序号
  ts: string;
  type:
    | 'import' | 'parse' | 'include-resolve' | 'include-cycle'
    | 'flatten' | 'param-resolve' | 'model-resolve'
    | 'compare' | 'candidate' | 'decision' | 'param-revision'
    | 'source-change' | 'branch-checkpoint' | 'diagnostic'
    | 'derive-version' | 'pointer-switch' | 'conflict'
    | 'export' | 'import-bundle';
  summary: string;
  payload: unknown;
  sources: string[];       // 关联的原始材料/行身份
  derivedVersionId?: string;
  parentEventId?: string;
  branch?: string;
  /** 决策类事件：采纳/未采纳 */
  decision?: {
    accepted: boolean;
    candidateId: string;
    rationale: string;
    rejectedCandidates?: string[];
  };
}

export interface DerivedVersion {
  id: string;
  parentVersionId?: string;
  createdAt: string;
  inputs: string[];        // 依赖的原始材料内容哈希
  flatA: FlatNetlist;
  flatB: FlatNetlist;
  report: EquivalenceReport;
  provA: ParamProvenance[];
  provB: ParamProvenance[];
}

export interface Bundle {
  format: 'netlist-double-shadow/bundle';
  schemaVersion: 1;
  exportedAt: string;
  sources: SourceFile[];
  events: TraceEvent[];
  derivedVersions: DerivedVersion[];
  currentVersionId: string | null;
  decisions: DecisionRecord[];
  archive?: CounterexampleArchive;
}

export interface DecisionRecord {
  id: string;
  eventId: string;
  branch: string;
  candidateId: string;
  accepted: boolean;       // 未采纳候选同样保留
  rationale: string;
  supersededBy?: string;
  createdAt: string;
}

/** 反例档案：基线 + 单源改动 + 采纳/未采纳 */
export interface CounterexampleArchive {
  id: string;
  name: string;
  baseline: {
    description: string;
    invariants: string[];
    sourceIds: string[];
  };
  cases: CounterexampleCase[];
}

export interface CounterexampleCase {
  id: string;
  scenario:
    | 'subckt-shadow'        // 子电路重名
    | 'local-param-override' // 局部参数覆盖
    | 'unit-suffix'          // 单位后缀
    | 'cyclic-include'       // 循环 include
    | 'symmetric-swap'       // 对称器件置换
    | 'unknown-device'       // 未知元件
    | 'multi-min-diff';      // 多个最小差异
  singleSourceChanged: string; // 只改动的那一个直接来源 id
  inputSnippetIds: string[];   // 输入片段
  expectedScope: {
    affectedIds: string[];     // 影响必须被限制的范围
    unaffectedIds: string[];   // 必须保持不变的对象
  };
  adopted: { eventId: string; result: string }[];
  rejected: { eventId: string; result: string; rationale: string }[];
  ruleVersion: string;
}
