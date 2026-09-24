/* ============================================================================
 * 网表双影室 —— 领域类型
 * 设计约束：
 *  - 原文本/行续接/子电路实例/参数表达式/model 版本/include 来源/单位后缀
 *    在摄取层一律不改写；规范化只发生在派生层。
 *  - 节点与实例可 alpha-rename；参数作用域、默认值、表达式依赖不可压平。
 *  - 未知元件保留 opaque 连接，不删除。
 *  - 多解/不确定状态必须保留全部合法候选。
 * ==========================================================================*/

/** 规则引擎版本（裁定依据的一部分，历史事件冻结其取值）。 */
export const RULE_VERSION = "rules/spice-equiv/1.0.0";

/** 存储 schema 版本；旧版本导入时走 migration。 */
export const SCHEMA_VERSION = 1;

/** 逻辑行类别（首字母/控制行决定）。 */
export type StatementKind =
  | "instance"
  | "subckt"
  | "ends"
  | "model"
  | "include"
  | "lib"
  | "param"
  | "global"
  | "control"
  | "comment"
  | "unknown";

/** 物理行：逐字符保留，不做任何 trim 之外的语义改写（trim 仅用于去除行尾换行）。 */
export interface RawLine {
  /** 稳定身份：`<fileId>#L<行号>` */
  id: string;
  fileId: string;
  /** 1 起物理行号 */
  lineNo: number;
  /** 原始文本（保留前后空格、大小写、单位后缀、注释） */
  text: string;
  /** 若本行以 `+` 开头，则指向被续接的逻辑首行 id */
  continuationOf: string | null;
}

/** 逻辑语句：由 1..n 个物理行续接而成，token 保留原始拼写。 */
export interface Statement {
  /** 稳定身份：`<fileId>#S<起始行号>` */
  id: string;
  kind: StatementKind;
  fileId: string;
  firstLineNo: number;
  /** 构成该语句的物理行 id（含续行），顺序固定 */
  lineIds: string[];
  /** 拼接前的逐行文本；派生层不允许改写 */
  rawLines: string[];
  /** 去掉续接符 `+` 后按空白切出的原始 token（大小写/后缀原样） */
  tokens: string[];
  /** 行内 `$` 注释原文（若存在），与语句分离保存但不改写 */
  inlineComment: string | null;
}

export type FileOrigin = "netlist-a" | "netlist-b" | "include" | "model-library";

/** 摄取的源文件：内容与来源不可变。 */
export interface SourceFile {
  /** 内容寻址稳定身份 `F:<sha1(content).slice(0,16)>` */
  id: string;
  /** include 中书写的路径或导入标签，原样保留 */
  path: string;
  origin: FileOrigin;
  content: string;
  lines: RawLine[];
}

/** include 边：来自哪条语句、解析到哪个 fileId（含循环标记）。 */
export interface IncludeEdge {
  statementId: string;
  /** 原文书写的 include 路径 */
  rawPath: string;
  /** 解析目标；循环且被截断时为 null */
  resolvedFileId: string | null;
  /** 解析过程中匹配到的候选路径（fixture 映射），用于来源链 */
  searched: string[];
  cycle: boolean;
  /** 循环路径上的 fileId 序列 */
  cyclePath: string[];
  diagnostic: string | null;
}

/** 参数表达式：原始表示 + 依赖名（规范化大写）+ 派生值（可空）。 */
export interface ParamExpr {
  /** 原始 token，例如 "10k"/"2*R"/"{W*2}"，绝不改写 */
  raw: string;
  /** 去掉外层 {} 的表达式文本（派生字段，原 raw 保留） */
  expr: string;
  /** 原始单位/量级后缀字符（"k"/"meg"/"u"/"m"...），无则 null */
  unitSuffix: string | null;
  /** 依赖的其它参数名（大写） */
  deps: string[];
  /** 派生 SI 数值；无法转换时为 null */
  value: number | null;
  /** value 的单位基准（电阻 Ω、电容 F、电感 H、无量纲 ""） */
  unit: string;
  /** 无法转换/未解析原因；保留原位置 */
  diagnostic: string | null;
}

/** 子电路形参默认值（按声明顺序，顺序本身是语义）。 */
export interface SubcktParam {
  name: string; // 大写规范名
  rawName: string; // 原样拼写
  def: ParamExpr | null; // 无默认值则 null
  statementId: string;
  order: number;
}

export interface SubcktDef {
  /** `SUB:<name>@<sha1(头+体)>`：重名子电路拥有不同 id */
  id: string;
  name: string; // 大写
  rawName: string;
  /** 外部节点（形式节点），顺序保留 */
  nodes: string[];
  params: SubcktParam[];
  body: Statement[];
  fileId: string;
  statementId: string;
}

/** model 定义版本：同名不同参/不同来源即不同版本。 */
export interface ModelVersion {
  /** `MOD:<NAME>@<sha1(origin|type|rawparams)>` */
  id: string;
  name: string; // 大写
  rawName: string;
  type: string; // nmos/pmos/res/cap/sw ...
  /** 参数 token 原样保留 */
  rawParams: string[];
  fileId: string;
  statementId: string;
}

/** 实例上的形参→实参绑定，实参表达式原样保留。 */
export interface InstanceParamBinding {
  formal: string; // 大写
  rawFormal: string;
  actual: ParamExpr;
  order: number;
}

/** 层次树节点：X 实例。 */
export interface HierarchyNode {
  /** 实例路径，如 `XAMP/XQ1`（alpha-rename 前的稳定路径） */
  path: string;
  rawName: string; // 例化名原文
  subcktName: string; // 引用的子电路名（大写）
  subcktDefId: string | null; // 重名/未解析时可能多候选
  candidateDefIds: string[];
  /** 形节点 -> 实节点原文（本层书写） */
  nodeMap: { formal: string; actualRaw: string }[];
  bindings: InstanceParamBinding[];
  children: HierarchyNode[];
  statementId: string;
  diagnostic: string | null;
}

/** 展平后的器件（含未知元件 opaque）。 */
export interface FlatDevice {
  /** 展平实例路径，稳定身份 */
  id: string;
  /** 首字母类别：R/C/L/D/Q/M/J/V/I/E/G/H/F/S/W/T/U/X 等；不识别时为 `U?<letter>` */
  letter: string;
  /** 是否 opaque 未知元件（保留但不参与参数语义比较） */
  opaque: boolean;
  /** 连接到的展平全局节点 id（顺序=引脚顺序） */
  nodes: string[];
  /** 连接时逐层的原文节点链（用于来源回溯，不改写） */
  nodeRawChain: string[];
  /** 器件参数（含 model 名等），逐项带来源 */
  params: { name: string; expr: ParamExpr }[];
  /** 绑定的 model 版本（解析得到的候选全部保留） */
  modelVersionIds: string[];
  modelName: string | null;
  sourceStatementId: string;
  diagnostic: string | null;
}

/** 参数作用域帧：表达式依赖不可压平，按帧保留。 */
export interface ParamFrame {
  scopePath: string;
  params: Record<
    string,
    {
      raw: string;
      rawName: string;
      value: number | null;
      unit: string;
      unitSuffix: string | null;
      deps: string[];
      /** default | instance-override | .param */
      origin: "default" | "instance" | "param";
      sourceStatementId: string;
      diagnostic: string | null;
    }
  >;
}

export interface FlatNetlist {
  side: "A" | "B";
  globalNodes: { id: string; raw: string }[];
  devices: FlatDevice[];
  hierarchy: HierarchyNode[];
  frames: ParamFrame[];
  subckts: SubcktDef[];
  models: ModelVersion[];
  includes: IncludeEdge[];
  files: SourceFile[];
  diagnostics: Diagnostic[];
}

export interface Diagnostic {
  code:
    | "include-cycle"
    | "include-missing"
    | "subckt-ambiguous"
    | "subckt-missing"
    | "param-unresolved"
    | "unit-unconvertible"
    | "unknown-element"
    | "model-ambiguous"
    | "model-missing";
  message: string;
  statementId?: string;
  fileId?: string;
  objectId?: string;
}

/* ----------------------------- 等价裁定 ----------------------------- */

/** 节点对应候选（alpha-rename）。非唯一时保留全部合法候选。 */
export interface NodeMappingCandidate {
  id: string;
  /** A 全局节点 id -> B 全局节点 id */
  map: Record<string, string>;
  /** 未被映射（无对应）的节点 */
  unmappedA: string[];
  unmappedB: string[];
  /** 该候选对应的器件同构自同构标签（对称置换来源） */
  symmetryOrbits: string[][];
}

export type EquivalenceVerdict =
  | "equivalent"
  | "alpha-equivalent"
  | "inequivalent"
  | "indeterminate";

/** 最小不等价子图（差异核心）。多个时全部保留。 */
export interface MinimalDiffSubgraph {
  id: string;
  devicesA: string[];
  devicesB: string[];
  nodesA: string[];
  nodesB: string[];
  kind:
    | "connectivity"
    | "parameter"
    | "model-version"
    | "missing-device"
    | "extra-device"
    | "opaque-vs-known"
    | "unresolved";
  reason: string;
  /** 证据：语句 id / 参数帧 scope / model 版本 id */
  evidence: { statementIds: string[]; frameScopes: string[]; modelVersionIds: string[] };
}

export interface EquivalenceResult {
  verdict: EquivalenceVerdict;
  ruleVersion: string;
  mappingCandidates: NodeMappingCandidate[];
  uniqueMapping: boolean;
  diffs: MinimalDiffSubgraph[];
  /** 被保留的 opaque 器件 id（两侧） */
  opaque: { A: string[]; B: string[] };
  /** 参与比较的参数项身份（scope:name），用于参数来源面板 */
  comparedParams: { id: string; scope: string; name: string; equal: boolean; reason: string }[];
  diagnostics: Diagnostic[];
}

/* ----------------------------- 事件溯源 ----------------------------- */

export type EventType =
  | "import"
  | "parse"
  | "include-resolve"
  | "flatten"
  | "param-revise"
  | "source-change"
  | "equiv-decide"
  | "review-accept"
  | "review-reject"
  | "review-adjust"
  | "branch-create"
  | "branch-choose"
  | "checkpoint";

export type EventStatus = "adopted" | "rejected" | "superseded" | "pending";

/** 机器可读裁定事件：界面每个显示值都能回溯到它。 */
export interface TraceEvent {
  id: string;
  seq: number;
  ts: string;
  caseId: string;
  branch: string;
  type: EventType;
  status: EventStatus;
  /** 裁定依据：规则版本 + 语义原则引用 */
  basis: { ruleVersion: string; principles: string[] };
  /** 直接输入对象（材料/语句/参数帧/model 版本的稳定 id） */
  inputs: string[];
  /** 产出对象的稳定 id */
  outputs: string[];
  /** 父事件（来源链） */
  parentId: string | null;
  payload: unknown;
  /** 乐观并发：同一分支编辑基于的期望 seq */
  baseSeq: number | null;
}

export interface Branch {
  name: string;
  parentBranch: string | null;
  forkedFromEventId: string | null;
  createdAt: string;
}

/** 分支当前指针：只有完整成功的推导批次才推进。 */
export interface BranchPointer {
  branch: string;
  currentEventId: string;
  currentSeq: number;
}
