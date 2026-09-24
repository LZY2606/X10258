// 核心领域类型。所有“原始数据”（原文本、行续接、单位后缀等）在源层不改写，
// 规范化仅发生在派生层；无法转换的值保留原表示并附诊断。

export type DiagnosticLevel = 'error' | 'warning' | 'info';

export interface Diagnostic {
  level: DiagnosticLevel;
  code: string;
  message: string;
  sourceFileId?: string;
  physicalLine?: number; // 1-based，指向原文本物理行
  objectId?: string;
}

/** 物理行：完全按换行切分，原文不改写（含续行符、注释、空白）。 */
export interface PhysicalLine {
  index: number; // 0-based
  text: string; // 原始行文本（不含换行符）
  hasContinuation: boolean; // 以行续接符 + 结尾（+ 之前为空白）
}

/** 逻辑行：由若干物理行续接而成，保留拼接来源。 */
export interface LogicalLine {
  id: string;
  physicalStart: number; // 0-based
  physicalEnd: number; // inclusive
  segments: string[]; // 每段去除续接符后的原文（保留空白，供溯源）
  joined: string; // segments 用空格连接后的规范化逻辑行（仅去续接符，不改写 token）
  comment: string | null; // 行内注释原文（$ 之后）
}

export interface SourceFile {
  id: string; // stable: src:<project>:<relpath-posix>
  path: string; // 相对导入根的 POSIX 路径
  rawText: string; // 原文本，逐字节保留
  sha256: string;
  physicalLines: PhysicalLine[];
  logicalLines: LogicalLine[];
}

export type Spiece =
  | { kind: 'subckt'; name: string }
  | { kind: 'model'; name: string; modelType: string };

export type RawParam = {
  raw: string; // 原始 name=expr 文本（token 原样）
  name: string;
  exprRaw: string; // 表达式原文（不改写）
  lineId: string;
};

export type DeviceKind =
  | 'R' | 'C' | 'L' | 'V' | 'I' | 'D' | 'Q' | 'M' | 'X' | 'unknown';

export interface RawDevice {
  id: string; // stable 身份见 ids.ts
  instanceName: string; // 原文（保留大小写）
  kind: DeviceKind;
  tokens: string[]; // 逻辑行全部 token 原文
  nodeTokens: string[]; // 识别出的节点 token 原文（不改写）
  modelRef: string | null; // 模型/子电路引用原文
  params: RawParam[]; // 原始 name=expr 参数
  rawValueToken: string | null; // R/C/L/V/I 的值 token 原文（含后缀）
  lineId: string;
}

export interface RawSubckt {
  id: string;
  name: string; // 原文
  externalNodes: string[]; // 端口节点 token 原文
  params: RawParam[]; // .SUBCKT 行上的默认参数
  body: RawDevice[]; // 实例（含嵌套 X）
  bodyLineIds: string[];
  lineStart: number; // logical line id
  lineEndsId: string; // .ENDS 逻辑行 id
  sourceFileId: string;
}

export interface RawModel {
  id: string;
  name: string; // 原文
  modelType: string; // NPN/PMOS/nmos ...
  params: RawParam[];
  lineId: string;
  sourceFileId: string;
}

export interface RawInclude {
  id: string;
  targetPath: string; // include 路径 token 原文
  resolvedPath: string | null; // 解析后的 POSIX 相对路径
  libSection: string | null; // .LIB name section
  lineId: string;
  sourceFileId: string;
}

export type RawStatement =
  | { type: 'subckt'; sub: RawSubckt }
  | { type: 'model'; model: RawModel }
  | { type: 'include'; inc: RawInclude }
  | { type: 'device'; dev: RawDevice }
  | { type: 'control'; raw: string; lineId: string; id: string }
  | { type: 'unknown'; raw: string; lineId: string; id: string };

/** 一次导入的完整源包：多文件 + include 解析，不改写原文。 */
export interface SourceBundle {
  id: string; // A / B 等
  rootPath: string;
  files: SourceFile[];
  statements: RawStatement[];
  includeEdges: { from: string; to: string; incId: string }[];
  diagnostics: Diagnostic[];
  includeCycle: string[] | null; // 构成环的文件路径序列
}

// ---- 表达式与单位后缀（派生层）----

export type Expr =
  | { t: 'num'; value: number | null; raw: string; unit: UnitTag; suffix: string | null }
  | { t: 'ref'; name: string; raw: string }
  | { t: 'unary'; op: '-' | '+'; e: Expr }
  | { t: 'bin'; op: string; l: Expr; r: Expr }
  | { t: 'call'; name: string; args: Expr[]; raw: string };

/** 领域量的单位/坐标基准；无法识别的后缀标 unknown 且 value=null。 */
export interface UnitTag {
  context: 'resistance' | 'capacitance' | 'inductance' | 'voltage' | 'current'
    | 'frequency' | 'time' | 'length' | 'generic' | 'unconvertible';
  scaleFactor: number | null; // SPICE 倍率
  unitWord: string | null; // ohm/f/v/...
}

export interface Quantity {
  rawToken: string; // 原始表示
  number: number | null; // 规范化 SI 值（派生层）；无法转换为 null
  unit: UnitTag;
  suffixRaw: string | null; // 单位后缀原文（如 k / meg / uF）
  ok: boolean;
  diagnostics: Diagnostic[];
}

// ---- 参数作用域（派生层，不压平）----

export interface ParamValue {
  name: string; // 统一大写键
  nameRaw: string; // 原始名
  exprRaw: string; // 定义处表达式原文
  expr: Expr | null;
  value: number | string | null; // 求值结果（字符串用于不可转换/未解析）
  resolved: boolean;
  /** 来源链：定义参数的物理位置 -> 覆盖链（实例 PARAMS -> 子电路默认）。 */
  origin: ParamOrigin;
  depRefs: string[];
  depResolutions: { name: string; frame: string; origin: ParamOrigin }[];
}

export interface ParamOrigin {
  sourceFileId: string;
  lineId: string;
  physicalLine: number;
  kind: 'subckt-default' | 'instance-override' | 'top-params' | 'model';
  instancePath: string | null; // 覆盖发生的实例路径（层次）
  rawText: string;
}

export interface ScopeChain {
  frame: string; // 层次路径
  params: Record<string, ParamValue>;
  parent: string | null;
}

// ---- 层次树与展平 ----

export interface HierarchyNode {
  id: string; // stable path id，如 inst/x1/x2
  instanceRaw: string;
  subcktName: string; // 引用的子电路名
  subcktDefId: string;
  parentId: string | null;
  children: string[];
  originFileId: string;
  originLineId: string;
  localParamFrame: Record<string, ParamValue>;
  ambiguousSubckt: boolean; // 重名定义时
}

export interface FlatDevice {
  uid: string; // 层次路径 + 原实例名（alpha-rename 前的稳定身份）
  path: string; // 实例层次
  instanceRaw: string;
  kind: DeviceKind;
  nodeUids: string[]; // 展平节点 uid
  nodeTokenByUid: Record<string, string>;
  modelRef: string | null;
  modelDefId: string | null;
  quantities: Record<string, Quantity>; // 参数/值名 -> 带单位量
  params: Record<string, ParamValue>;
  opaque: boolean; // 未知元件：保留 opaque 连接
  originFileId: string;
  originLineId: string;
}

export interface FlatNetwork {
  rootExternalNodes: string[];
  devices: FlatDevice[];
  nodeTokens: Record<string, string>; // uid -> 代表性原始 token
  hierarchy: HierarchyNode[];
  scopes: Record<string, ScopeChain>;
  diagnostics: Diagnostic[];
}

// ---- 等价裁定 ----

export interface NodeCorrespondence {
  mappingId: string; // stable
  aNode: string;
  bNode: string;
  basis: 'external-name' | 'color-refinement' | 'backtrack';
}

export interface DeviceCorrespondence {
  mappingId: string;
  aDevice: string;
  bDevice: string;
  kind: DeviceKind;
  sameSemantics: boolean;
  reasons: string[];
}

export interface ParamDifference {
  id: string;
  aDevice: string;
  bDevice: string;
  paramName: string;
  aRaw: string;
  bRaw: string;
  aValue: number | string | null;
  bValue: number | string | null;
  aOrigin: ParamOrigin | null;
  bOrigin: ParamOrigin | null;
  equal: boolean;
}

export interface WitnessSubgraph {
  id: string;
  deviceUidsA: string[];
  deviceUidsB: string[];
  nodeUidsA: string[];
  nodeUidsB: string[];
  reason: string;
  minimal: boolean;
}

export type VerdictLevel =
  | 'equivalent'
  | 'equivalent-alpha' // 仅经 alpha-rename 等价
  | 'candidate-equivalent' // 存在多个合法同构映射（多解保留）
  | 'different'
  | 'inconclusive'; // 未知元件/不可转换导致无法唯一决定

export interface EquivalenceVerdict {
  id: string;
  derivationId: string;
  level: VerdictLevel;
  candidates: EquivalenceCandidate[]; // 全部合法候选，不吞多解
  nodeMappings: NodeCorrespondence[];
  deviceMappings: DeviceCorrespondence[];
  paramDiffs: ParamDifference[];
  witnesses: WitnessSubgraph[];
  opaqueDevices: { a: string[]; b: string[] };
  diagnostics: Diagnostic[];
  inputHashes: { a: string; b: string };
}

export interface EquivalenceCandidate {
  id: string;
  nodeMap: Record<string, string>;
  deviceMap: Record<string, string>;
  symmetryClass: string; // 对称器件置换产生的等价类标签
  complete: boolean;
  blockedByOpaque: boolean;
}
