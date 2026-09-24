// 领域模型类型。所有原始层字段均保持原文，派生层才做规范化。

export interface TextSpan {
  fileId: string;
  line: number; // 1 起，行续接的首行
  startCol: number;
  endLine: number;
  endCol: number;
  raw: string; // 原文（含续行连接结构，不改写、不规范空白）
  lines: string[]; // 参与该行（含行续接）的原始物理行
}

export interface FileSource {
  path: string; // include 路径原文
  fileId: string; // 内容寻址稳定身份 sha256
  rawText: string; // 字节级原文（\n 行尾保持导入时表示）
  includeKind: 'top' | 'include' | 'library';
  includedBy?: string; // 来源 fileId
}

export type Severity = 'error' | 'warning' | 'note';

export interface Diagnostic {
  code: string;
  severity: Severity;
  message: string;
  span?: TextSpan;
  value?: string;
}

export type ElementKind =
  | 'R' | 'C' | 'L' | 'V' | 'I' | 'D' | 'Q' | 'M' | 'X' | 'unknown';

export interface RawElement {
  id: string; // def@fileId#line
  name: string; // 原实例名（如 X1）
  kind: ElementKind;
  tokens: string[]; // 行续接合并后的逻辑 token（不改写大小写）
  nodeTokens: string[]; // 节点 token 原文
  modelToken?: string; // 模型名原文（best effort）
  valueToken?: string; // 值 token 原文
  rawParamTokens: string[]; // PARAM/裸 key=val token 原文
  span: TextSpan;
  opaqueSignature?: string; // unknown 元件的规范化结构签名
  heuristic: boolean;
}

export interface RawModel {
  id: string;
  name: string; // 模型名原文
  type: string; // NMOS/PMOS/R/...
  paramTokens: string[]; // key=val 原文
  span: TextSpan;
}

export interface RawParamDefault {
  key: string; // 参数名原文（规范大写用于解析，身份保留原文）
  keyRaw: string;
  valueRaw: string; // 默认值表达式原文
  span: TextSpan;
}

export interface RawSubckt {
  id: string;
  name: string;
  nameRaw: string;
  ports: string[]; // 端口节点原文
  bodyElementIds: string[];
  params: RawParamDefault[];
  span: TextSpan;
  endSpan?: TextSpan;
}

export interface RawControl {
  id: string;
  kind: 'include' | 'param' | 'model' | 'other';
  text: string;
  tokens: string[]; // include: [path, kind]
  span: TextSpan;
}

export interface ParsedFile {
  source: FileSource;
  physicalLines: string[];
  logicalLines: { ids: number[]; text: string }[];
  elements: RawElement[];
  models: RawModel[];
  subckts: RawSubckt[];
  controls: RawControl[];
  diagnostics: Diagnostic[];
}

export interface IncludeEdge {
  fromFileId: string;
  toPath: string;
  toFileId?: string;
  atLine: number;
  kind: 'include' | 'library';
  resolved: boolean;
}

export interface IncludeResolution {
  roots: string[]; // 根 fileId（按导入顺序）
  order: string[]; // 解析顺序 fileId（循环时停在首次重复前）
  edges: IncludeEdge[];
  cycles: string[][]; // 检测到的环（fileId 序列，首尾重复）
  missing: { path: string; fromFileId: string; atLine: number }[];
}

export interface ParamProvenance {
  key: string;
  valueRaw: string; // 当前作用域内生效表达式原文
  kind: 'default' | 'instance-override' | 'global' | 'literal';
  span: TextSpan;
  instancePath?: string;
  subcktId?: string;
}

export interface ResolvedParam {
  key: string;
  raw: string;
  value: number | string; // 无法求值则保留原文字符串
  evaluated: boolean;
  unitSuffix?: string; // 原文后缀（如 k, meg, u）
  normalizedSi?: number; // 派生层 SI 数值
  dependsOn: string[];
  diagnostic?: Diagnostic;
  provenance: ParamProvenance;
}

export interface FlatNode {
  id: string; // 展平网络稳定身份
  path: string; // 层次路径（实例链）/ 内部局部节点
  name: string; // 最内层节点原文
  isPort: boolean;
  boundTo?: string; // 绑定到的父网络 id
}

export interface FlatComponent {
  id: string; // 稳定身份：展平实例路径 + 原元件名
  path: string[]; // X1/X2 链
  localElementId: string;
  name: string;
  kind: ElementKind;
  terminals: { nodeId: string; raw: string }[];
  model?: { name: string; activeVersionId?: string; versions: string[] };
  params: ResolvedParam[];
  opaqueSignature?: string;
  unknown: boolean;
}

export interface ModelVersion {
  id: string;
  name: string;
  type: string;
  paramsRaw: string[];
  span: TextSpan;
  order: number; // 定义先后
}

export interface FlattenedNetlist {
  rootFileId: string;
  includeResolution: IncludeResolution;
  nodes: FlatNode[];
  components: FlatComponent[];
  subcktDefs: { id: string; name: string; portCount: number }[];
  modelCatalog: { name: string; versions: ModelVersion[]; activeVersionId: string }[];
  globalParams: ResolvedParam[];
  diagnostics: Diagnostic[];
}

export type FindingCode =
  | 'MATCH'
  | 'PARAM_MISMATCH'
  | 'MODEL_VERSION_MISMATCH'
  | 'OPAQUE_PATTERN_MISMATCH'
  | 'NODE_DEGREE_MISMATCH'
  | 'TOPOLOGY_MISMATCH'
  | 'UNIT_UNRESOLVED'
  | 'CIRCULAR_INCLUDE'
  | 'MISSING_INCLUDE'
  | 'SUBCKT_COLLISION'
  | 'NONDETERMINATE';

export interface EquivFinding {
  id: string;
  code: FindingCode;
  severity: Severity;
  message: string;
  side?: 'A' | 'B' | 'both';
  componentIds?: { A?: string; B?: string };
  nodeIds?: { A?: string; B?: string };
  modelName?: string;
  spans?: TextSpan[];
}

export interface NodeMapping {
  A: string;
  B: string;
}
export interface ComponentMapping {
  A: string;
  B: string;
  symmetric: boolean;
  terminalPermutation: number[];
}

export interface MinimalDiff {
  id: string;
  componentIds: string[]; // A、B 两侧涉及的最小不等价子图节点（元件）
  nodeIds: string[];
  reason: string;
  size: number;
}

export interface EquivalenceResult {
  equivalent: boolean;
  determinate: boolean; // 无法唯一决定时为 false，候选全部保留
  nodeMappings: NodeMapping[]; // 全部合法候选（alpha-rename 空间）
  componentMappings: ComponentMapping[];
  findings: EquivFinding[];
  minimalDiffs: MinimalDiff[];
  opaqueRetained: number; // 保留的 unknown 元件连接数
  derivedAt: string;
  ruleVersion: string;
  dependencyHashes: Record<string, string>;
}

export type EventType =
  | 'import'
  | 'baseline'
  | 'param_revision'
  | 'local_source_change'
  | 'scenario_probe'
  | 'decision'
  | 'branch_checkout'
  | 'param_adjust'
  | 'accept'
  | 'reject'
  | 'conflict_detected'
  | 'conflict_resolved'
  | 'rule_migration';

export interface ArchiveEvent {
  id: string; // 事件稳定身份
  seq: number;
  branch: string;
  type: EventType;
  at: string;
  actor: string;
  summary: string;
  payload: unknown;
  // 该事件发生时可见的派生版本指针（不拿最新结果覆盖历史）
  derivedVersionId: string;
  parentEventId: string | null;
}

export interface DerivedVersion {
  id: string;
  parentId: string | null;
  eventId: string;
  branch: string;
  createdAt: string;
  ruleVersion: string;
  flatAHash: string;
  flatBHash: string;
  equivalenceHash: string;
  flatA: FlattenedNetlist;
  flatB: FlattenedNetlist;
  equivalence: EquivalenceResult;
  dependencies: DependencyEntry[];
}

export interface DependencyEntry {
  artifactId: string; // 被依赖的源对象稳定身份
  kind: 'file' | 'line' | 'subckt' | 'model' | 'param';
  hash: string;
}

export interface CounterexampleCase {
  id: string;
  name: string;
  description: string;
  baselineRawPreserved: {
    rawText: true;
    continuation: true;
    subcktInstances: true;
    paramExpressions: true;
    modelVersions: true;
    includeSources: true;
    unitSuffixes: true;
  };
  directSourceDelta: string; // 本次只改动的直接来源说明
  scenarios: CounterexampleScenario[];
  adopted: { scenarioId: string; eventId: string; adopted: boolean; rationale: string }[];
  judgments: MachineJudgment[];
}

export interface CounterexampleScenario {
  id: string;
  kind:
    | 'subckt-shadow-name'
    | 'local-param-override'
    | 'unit-suffix'
    | 'circular-include'
    | 'symmetric-permutation'
    | 'unknown-opaque'
    | 'multiple-minimal-diffs';
  inputSnippets: { side: 'A' | 'B' | 'both'; path: string; lines: string[] }[];
  expected: {
    impactScope: string[]; // 影响必须被限制在的对象稳定身份
    determinate: boolean;
    opaqueKept?: number;
  };
  actual?: {
    impactScope: string[];
    determinate: boolean;
    opaqueKept?: number;
    findings: EquivFinding[];
  };
  adopted: boolean | null;
}

export interface MachineJudgment {
  id: string;
  ruleId: string;
  statement: string;
  evidence: { artifactId: string; span?: TextSpan }[];
  eventIds: string[];
}
