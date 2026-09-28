// ============================================================================
// 核心领域类型：原文本层(raw) -> 派生层(derived) -> 裁定层(decisions)
// 不变量：
//  1) raw 层永远保留源文件原始表示（文本、行续接、单位后缀、大小写等不改写）
//  2) 参数作用域、默认值、表达式依赖不可压平
//  3) 未知元件保留 opaque 连接，不删除
//  4) 节点/实例可 alpha-rename；多解/不确定时保留全部合法候选
// ============================================================================

/** 稳定身份：导入即确定，导出/删除数据库再导入后保持不变 */
export type StableId = string;

/** 带原始表示 + 规范化值 + 单位的领域量（无法转换时 normalized=null 并附诊断） */
export interface RawQuantity {
  /** 原始词法表示，不改写，例如 "10k" "1.5uF" "2.2MEG" */
  raw: string;
  /** 规范化后的 SI 数值（后缀换算后），无法转换为 null */
  normalized: number | null;
  /** 归一化后的 SI 单位，如 ohm/f/h/v/a；纯数字为 "" */
  unit: string;
  /** 诊断（无法转换时的原因） */
  diagnostics: Diagnostic[];
}

export interface Diagnostic {
  code: string;
  message: string;
  /** 严重级别：error 不阻断原始保留，仅阻止规范化 */
  severity: 'info' | 'warning' | 'error';
}

export type CardKind =
  | 'element' // R C L V I Q M D G E F H 等以字母开头的元件实例卡
  | 'subckt'
  | 'ends'
  | 'model'
  | 'param'
  | 'include'
  | 'global'
  | 'end'
  | 'control' // 其它点控卡（.tran .op ...），保留原文
  | 'unknown'; // 无法分类但必须保留为 opaque

export interface RawLine {
  /** 文件内稳定 id */
  id: StableId;
  /** 所属源文件 id */
  fileId: StableId;
  /** 1 基原始行号（含被续接行） */
  lineNo: number;
  /** 原始行文本（去行尾换行，含原始缩进与注释，不改写） */
  text: string;
}

/** include 来源链（谁在哪一行引入了谁），循环在此产生 finding 而非递归崩溃 */
export interface IncludeEdge {
  id: StableId;
  parentFileId: StableId;
  lineId: StableId;
  /** include 指令中的原始路径文本 */
  rawPath: string;
  /** 解析（可访问时）到的文件 id；解析失败为 null */
  resolvedFileId: StableId | null;
}

export interface RawFile {
  id: StableId;
  /** include 指令中使用的原始路径（不改写） */
  path: string;
  /** 展示名 */
  name: string;
  /** 原始字节/字符内容，逐字符保留 */
  content: string;
  /** 内容指纹，用于导出再导入身份保持 */
  sha256: string;
  lines: RawLine[];
  /** 来源标签：main / include / model-set */
  origin: 'main' | 'include' | 'model';
}

/** 参数作用域：subckt 定义默认值 / 实例实参 / .param 链，绝不在 raw 层合并 */
export interface ParamScope {
  id: StableId;
  kind: 'subckt-default' | 'instance-args' | 'global-param';
  ownerId: StableId; // subckt def id / instance card id / 主文件
  /** 有序参数条目，保持源码顺序 */
  entries: ParamEntry[];
}

export interface ParamEntry {
  id: StableId;
  name: string;
  /** 右侧原始文本（表达式原样保留），形如 "W*2+1u" */
  rawExpr: string;
  /** 仅当右侧为字面量后缀值时存在 */
  quantity: RawQuantity | null;
  /** 是否在源码中显式给出（区分默认值与缺失） */
  present: boolean;
  lineId: StableId;
}

/** 参数解析后的表达式依赖图（派生层；raw 层的 rawExpr 才是事实来源） */
export interface ExprNode {
  id: StableId;
  /** 参数的全限定名，如 /U1/:W */
  fqn: StableId;
  rawExpr: string;
  /** 直接依赖的其它 fqn */
  deps: string[];
  /** 求值结果（成功时）；表达式环或缺失依赖时为 null */
  value: number | null;
  unit: string;
  diagnostics: Diagnostic[];
}

export interface ModelDef {
  id: StableId;
  name: string;
  type: string; // nmos/pmos/npn/... 原文
  /** 该 model 名第几次定义（同名版本），0 基 */
  versionIndex: number;
  /** 原始参数对（不改写） */
  rawParams: { key: string; rawValue: string }[];
  fileId: StableId;
  lineId: StableId;
  /** 同一逻辑 model 定义链 id（同名同文件来源视为一族版本） */
  familyId: StableId;
}

/** 层次树上的一个节点：主网表或 .subckt 定义 */
export interface SubcktDef {
  id: StableId;
  name: string;
  /** 外部端口节点名（原文） */
  ports: string[];
  fileId: StableId;
  startLineId: StableId;
  endLineId: StableId | null;
  /** 定义体内卡片 id（有序） */
  bodyCardIds: StableId[];
  /** 同名冲突分组：相同名字的定义共享 defGroupId */
  defGroupId: StableId;
  /** 该名字下第几个定义，0 基 */
  nameIndex: number;
}

/** 原始卡片（语句）。续接后的一张逻辑卡可引用多行 */
export interface RawCard {
  id: StableId;
  fileId: StableId;
  /** 组成该逻辑卡的所有物理行（首行 + 续行），保持顺序 */
  lineIds: StableId[];
  /** 首行 1 基行号（展示用） */
  firstLineNo: number;
  kind: CardKind;
  /** 完整逻辑卡的原始文本（用原始换行拼接续行，不改写） */
  rawText: string;
  /** 词法 token（保持大小写，引号保留在外层） */
  tokens: string[];
  /** 行内注释原文（含前导分隔符），不改写；无则 null */
  inlineComment: string | null;

  // ---- 元件卡 ----
  element?: ElementRef;
  // ---- 子电路实例 X 卡 ----
  instance?: XInstance;
  // ---- include ----
  include?: { rawPath: string };
  // ---- model ----
  model?: { name: string; type: string; rawParams: { key: string; rawValue: string }[] };
  // ---- subckt ----
  subckt?: { name: string; ports: string[] };
  // ---- param ----
  params?: { name: string; rawExpr: string }[];
  // ---- global ----
  globals?: string[];
  /** 无法识别为已知元件时：仍保留全部节点 token，标记 opaque */
  opaque?: { reason: string; nodeTokens: string[] };
}

export interface ElementRef {
  /** 元件实例名原文（如 R1、Mtail、X? 不属于 element） */
  name: string;
  /** 首字母元件类型（大写），如 R/C/L/M/Q/D/V/I/E/F/G/H... */
  type: string;
  /** 节点 token 原文（数量按类型无法确定时保留全部候选位置） */
  nodes: string[];
  /** 型号引用原文（Q/M/D/J 等），无则 null */
  modelRef: string | null;
  /** 剩余 token 原文（值/参数对/其它），不改写 */
  tailTokens: string[];
  /** 主值（若存在，通常是尾首 token） */
  value: RawQuantity | null;
}

export interface XInstance {
  name: string;
  /** 实例连接的节点 token 原文 */
  nodes: string[];
  /** 引用的子电路名 */
  subcktName: string;
  /** 有序实参（原文 name=value 或裸值按声明序） */
  args: { name: string | null; rawExpr: string }[];
}

/** include 解析后的文件集（一个 netlist 导入单元） */
export interface NetlistBundle {
  id: StableId; // A / B 等
  label: string;
  files: RawFile[];
  cards: RawCard[];
  subckts: SubcktDef[];
  models: ModelDef[];
  scopes: ParamScope[];
  includeEdges: IncludeEdge[];
  /** 解析期发现的问题（循环 include、重名、无法转换…） */
  findings: Finding[];
}

// ---------------------------------------------------------------------------
// 派生层：展平 / 参数求值 / 等价
// ---------------------------------------------------------------------------

export interface FlatNode {
  /** 全局展平节点稳定 id，基于路径+局部名，确定性 */
  id: StableId;
  /** 原始局部节点名（alpha-rename 的对象） */
  localName: string;
  /** 层次实例路径，如 /U1/U2 */
  path: string;
  /** 是否全局节点（.global / 0） */
  isGlobal: boolean;
}

export interface FlatDevice {
  id: StableId;
  /** 展平实例路径 / 元件名 */
  path: string;
  /** 元件类型大写 */
  type: string;
  /** 原实例名 */
  localName: string;
  /** 连接的展平节点 id（按卡上顺序） */
  nodeIds: StableId[];
  modelRef: string | null;
  /** 解析后的主值（SI），无法解析为 null */
  value: number | null;
  /** 原始主值表示 */
  rawValue: string | null;
  unit: string;
  /** 求值后的实例参数 fqn->value（作用域不压平，仅在此快照引用） */
  params: { fqn: string; name: string; value: number | null; rawExpr: string }[];
  /** 未知/opaque 元件：保留连接，不参与语义比较，但不删除 */
  opaque: boolean;
  sourceCardId: StableId;
}

export interface FlatNetlist {
  bundleId: StableId;
  devices: FlatDevice[];
  nodes: FlatNode[];
  /** 层次树（实例 -> 子电路定义） */
  hierarchy: HierarchyNode[];
  exprs: ExprNode[];
  /** 展平期发现：子电路重名歧义等 */
  findings: Finding[];
}

export interface HierarchyNode {
  id: StableId;
  instanceName: string | null; // 顶层为 null
  instancePath: string;
  defId: StableId | null;
  defName: string;
  resolvedDefId: StableId | null; // 重名未决时为 null，候选见 findings
  candidateDefIds: StableId[];
  children: HierarchyNode[];
  cardId: StableId | null;
}

// ---------------------------------------------------------------------------
// 等价裁定
// ---------------------------------------------------------------------------

export type FindingCode =
  | 'include-cycle'
  | 'include-unresolved'
  | 'subckt-name-collision'
  | 'subckt-unresolved'
  | 'unit-unconvertible'
  | 'expr-cycle'
  | 'expr-unresolved'
  | 'unknown-element'
  | 'model-version'
  | 'param-shadow'
  | 'multiple-mappings'
  | 'minimal-diff'
  | 'symmetric-permutation'
  | 'value-mismatch'
  | 'model-mismatch'
  | 'opaque-presence';

export interface Finding {
  id: StableId;
  code: FindingCode;
  severity: 'info' | 'warning' | 'error';
  message: string;
  /** 受影响对象的稳定身份 */
  subjects: StableId[];
  /** 来源链（文件/行/卡片/作用域），可追溯 */
  provenance: ProvenanceRef[];
  /** 机器可读细节 */
  detail?: Record<string, unknown>;
}

export interface ProvenanceRef {
  kind: 'file' | 'line' | 'card' | 'scope' | 'expr' | 'model' | 'subckt' | 'event' | 'decision';
  id: StableId;
  label?: string;
}

/** 节点对应：A 节点 id <-> B 节点 id，一个 equivalence result 可有多个候选解 */
export interface NodeMapping {
  id: StableId;
  aNodeId: StableId;
  bNodeId: StableId;
}

export interface InstanceMapping {
  id: StableId;
  aDeviceId: StableId;
  bDeviceId: StableId;
  /** 对称端子置换（下标对：原 index -> 映射 index） */
  terminalPermutation: number[];
}

export interface EquivalenceCandidate {
  id: StableId;
  label: string;
  nodeMappings: NodeMapping[];
  instanceMappings: InstanceMapping[];
  /** 该候选无法消歧的对称置换说明 */
  ambiguities: { deviceId: StableId; reason: string }[];
}

export interface MinimalDiff {
  id: StableId;
  kind: 'topology' | 'value' | 'model' | 'opaque' | 'unmatched';
  message: string;
  /** 最小不等价子图涉及的节点与器件（双侧） */
  aNodeIds: StableId[];
  aDeviceIds: StableId[];
  bNodeIds: StableId[];
  bDeviceIds: StableId[];
  provenance: ProvenanceRef[];
}

export interface EquivalenceResult {
  equivalent: boolean | null; // null = 无法唯一决定
  reason: string;
  candidates: EquivalenceCandidate[];
  chosenCandidateId: StableId | null;
  minimalDiffs: MinimalDiff[];
  findings: Finding[];
  /** 比较所用数值容差 */
  tolerance: number;
}

// ---------------------------------------------------------------------------
// 事件 / 版本（事件溯源）
// ---------------------------------------------------------------------------

export type EventType =
  | 'project-created'
  | 'bundle-imported'
  | 'baseline-recorded'
  | 'source-amended' // 只改动一个直接来源（反例档案的单源改动）
  | 'subckt-choice' // 子电路重名裁定
  | 'param-revision' // 参数修订
  | 'candidate-accepted'
  | 'candidate-rejected'
  | 'param-adjusted' // 复核界面上的参数调整
  | 'branch-created'
  | 'branch-continued'; // 比较两个分支后选择继续哪一版

export interface GameEvent {
  id: StableId;
  seq: number;
  type: EventType;
  branch: string;
  /** 父事件 id（线性分支内） */
  parentId: StableId | null;
  at: string; // ISO
  actor: string;
  payload: Record<string, unknown>;
  /** 该事件后成功提交的派生版本 id（null=未产生新版本） */
  versionId: StableId | null;
}

/** 一次完整推导的不可变快照指针（原子提交） */
export interface DerivedVersion {
  id: StableId;
  eventId: StableId;
  branch: string;
  /** 各阶段内容 hash，用于增量传播与“为何仍有效/需重算”说明 */
  stageHashes: Record<string, string>;
  /** 实际快照数据 */
  flat: Record<string, FlatNetlist>;
  equivalence: EquivalenceResult | null;
  /** 阶段依赖图：stage -> 依赖的 stage 列表 */
  stageDeps: Record<string, string[]>;
  /** 每个 stage 的有效性说明 */
  stageReasons: Record<string, { status: 'reused' | 'recomputed'; because: string }>;
  createdAt: string;
}

export interface BranchState {
  name: string;
  headEventId: StableId | null;
  headVersionId: StableId | null;
  label: string;
}
