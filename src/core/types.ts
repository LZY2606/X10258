// 领域类型：所有领域量携带原始表示；规范化只发生在派生层。
export interface SourceFile {
  id: string;            // 稳定身份，如 src:top_a
  path: string;          // 逻辑路径（include 来源关系用）
  text: string;          // 原文本，不改写
  sha: string;           // 内容摘要
}

export interface RawStatement {
  id: string;            // stmt:<sourceId>:<lineStart>
  sourceId: string;
  lineStart: number;     // 1-based
  lineEnd: number;
  continued: boolean;    // 是否使用了行续接
  raw: string;           // 原始文本（含续接行拼接前的原始行）
  kind: StatementKind;
  // 解析出的结构（不改写 raw）
  head?: string;         // 元素首字母 / 指令名
  name?: string;
  nodes?: string[];
  subckt?: string;       // X 实例引用的子电路名
  params?: RawParam[];   // 参数表达式，原样保留
  modelType?: string;    // .model 的类型（model 版本语义）
  includeTarget?: string;
  ports?: string[];      // .subckt 端口
  unknown?: boolean;     // 未知元件：保留 opaque 连接
}

export type StatementKind =
  | 'subckt' | 'ends' | 'param' | 'model' | 'include' | 'end'
  | 'element' | 'instance' | 'comment' | 'blank' | 'other';

export interface RawParam {
  name: string;
  rawExpr: string;       // 原样表达式文本，如 "{wp*2}" / "1.2k"
  deps: string[];        // 表达式依赖的标识符（作用域分析用）
}

export interface Diagnostic {
  id: string;
  severity: 'info' | 'warn' | 'error';
  kind: string;          // unit-unconvertible / include-cycle / subckt-collision / ...
  message: string;
  at: { sourceId?: string; line?: number; objectId?: string };
}

export interface NormalizedValue {
  raw: string;           // 原始表示，保留
  value?: number;        // 规范化值（派生层）
  unit?: string;         // 单位基准，如 'ohm' 'F' 'm' 'V' 'A'
  suffix?: string;       // 命中的单位后缀
  ignoredTail?: string;  // SPICE 忽略的尾部字符
  unconvertible?: boolean;
}

export interface FlatParam {
  name: string;
  raw: string;
  norm: NormalizedValue;
  deps: string[];
  provenance: ParamProvenance; // 参数来源：作用域不可压平
}

export interface ParamProvenance {
  scopePath: string[];         // 作用域链，如 ['top','X1(inv)']
  definedAt: { sourceId: string; line: number } | null;
  origin: 'instance-override' | 'subckt-default' | 'global-param' | 'builtin-default';
  overridden?: ParamProvenance; // 被覆盖的下层来源（保留，不删除）
}

export interface FlatDevice {
  id: string;            // 层次路径，如 top/X1/R1
  kind: string;          // R C L M Q D V I ... 或 opaque:<letter>
  model?: string;
  pins: string[];        // 展平后的网名（层次路径）
  params: FlatParam[];
  opaque: boolean;       // 未知元件：保留 opaque 连接而不删除
  rawRef: { sourceId: string; stmtId: string; line: number };
  instancePath: string[];
}

export interface FlatNetlist {
  top: string;
  devices: FlatDevice[];
  nets: string[];
  hierarchy: HierNode;
  diagnostics: Diagnostic[];
}

export interface HierNode {
  name: string;          // 子电路名或 top
  instanceId: string;    // 层次实例路径
  children: HierNode[];
  sourceId?: string;
  line?: number;
}

export interface NodeCorrespondence {
  a: string; b: string;  // 网 A <-> 网 B（alpha-rename 允许）
  confidence: 'exact' | 'candidate';
}

export interface EquivResult {
  status: 'equivalent' | 'not-equivalent' | 'ambiguous' | 'incomplete';
  solutions: NodeCorrespondence[][];  // 多解全部保留
  minimalDiffs: MinimalDiff[];        // 多个最小差异
  opaqueKept: string[];               // 被保留的 opaque 器件 id
  notes: EquivNote[];
}

export interface EquivNote {
  kind: 'alpha-rename' | 'symmetric-permutation' | 'scope-dependency' | 'opaque-kept' | 'unit-normalized';
  message: string;
  objects: string[];
}

export interface MinimalDiff {
  id: string;
  devicesA: string[];
  devicesB: string[];
  nets: string[];
  reason: string;
}

export interface DomainEvent {
  id: string;            // evt:NNNNNN 稳定身份
  seq: number;
  branch: string;
  kind: string;
  actor: string;
  baseVersion: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface VersionRow {
  id: string;            // ver:NNNNNN
  seq: number;
  eventId: string | null;
  status: 'building' | 'complete' | 'aborted';
  snapshot: string;      // JSON
  report: string;        // 重算报告 JSON
  createdAt: string;
}
