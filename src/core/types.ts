/**
 * 领域模型：所有对象都带稳定身份 id。
 *
 * 设计约束（对应需求硬语义）：
 *  - rawText 永不改写：行续接、大小写、单位后缀、空白都以片段形式保留。
 *  - 参数有作用域：default / instance override / .PARAM / 表达式依赖不做压平。
 *  - 未知元件不删除：kind='unknown' 时仍保留其 opaque 引脚连接。
 *  - 节点/实例只做 alpha-rename：等价映射以候选集形式保留，不强行唯一化。
 */

export type ID = string;

/** 坐标基准：所有领域量可携带单位或坐标基准 */
export interface UnitRef {
  /** 归一化 SI 基准量；无法转换时为 null，原值保留在 raw 并附 diagnostic */
  si: number | null;
  /** 规范化后的 SI 单位名，如 'ohm' | 'farad' | 'volt' | ''（无量纲） */
  unit: string;
  /** 解析出的后缀原文，如 'k'、'MEG'、'u'，没有则 null */
  suffix: string | null;
}

/** 参数原始表示与派生表示并存 */
export interface ParamValue {
  /** 原始 token 文本，不改写，如 '2.2k'、'{2*R}'、'10u' */
  raw: string;
  /** 是否为表达式（花括号或 .PARAM 表达式） */
  isExpression: boolean;
  /** 数值化结果；表达式未解析或无法转换时为 null */
  numeric: number | null;
  unit: UnitRef;
  /** 无法转换/无法求值时的诊断，留原位置，不丢值 */
  diagnostic: string | null;
}

/** 参数作用域来源 */
export type ParamOriginKind =
  | 'subckt-default' // .SUBCKT 形参默认值
  | 'instance-override' // 实例行上的实参覆盖
  | 'dot-param' // .PARAM 赋值
  | 'model-param' // .MODEL 参数
  | 'builtin'; // 内置缺省

export interface ParamOrigin {
  kind: ParamOriginKind;
  /** 来源文件 id */
  sourceId: ID;
  /** 来源行 id（原始行，可反查） */
  lineId: ID;
  /** 定义处的作用域路径，如 ['ROOT','AMP1','Q1'] */
  scopePath: ID[];
  /** 表达式直接依赖的参数名（依赖图边） */
  dependsOn: string[];
}

export interface ScopedParam {
  /** 规范全名：作用域路径 + '::' + name */
  key: string;
  name: string;
  value: ParamValue;
  origin: ParamOrigin;
  /** 同一 key 的所有候选值（默认值 vs 覆盖），采纳指针在裁定层 */
  overrides: { value: ParamValue; origin: ParamOrigin }[];
}

export type SourceKind = 'netlist' | 'include';

export interface RawLine {
  id: ID;
  sourceId: ID;
  /** 1 基行号（逻辑行首行；续行追加 physicalFrom..physicalTo） */
  logicalIndex: number;
  physicalFrom: number;
  physicalTo: number;
  /** 续接之前的物理行原文数组（含开头 '+' 行原文，不改写） */
  rawSegments: string[];
  /** 拼接后用于词法分析的文本（仅派生用，rawSegments 才是凭证） */
  joined: string;
}

export interface SourceFile {
  id: ID;
  kind: SourceKind;
  /** include 路径或逻辑名，原文保留 */
  path: string;
  /** 文件全文，一字不改 */
  rawText: string;
  /** 被谁 include（sourceId,lineId）；根网表为 null */
  includedBy: { sourceId: ID; lineId: ID } | null;
  /** 文本层内容指纹（稳定身份派生用） */
  sha256: string;
}

/** include 关系（含循环检测结果，不静默丢弃） */
export interface IncludeEdge {
  id: ID;
  fromSource: ID;
  fromLine: ID;
  toSource: ID;
  /** include 路径原文 token */
  rawPath: string;
  /** 是否落在一个 include 环上 */
  cycle: boolean;
  cyclePath: ID[] | null;
  diagnostic: string | null;
}

export type CardKind =
  | 'element'
  | 'subckt'
  | 'ends'
  | 'model'
  | 'param'
  | 'include'
  | 'title'
  | 'comment'
  | 'control'
  | 'unknown';

export interface Token {
  text: string;
  /** 在 joined 文本中的字符区间（坐标基准） */
  start: number;
  end: number;
}

export interface ParsedCard {
  id: ID;
  sourceId: ID;
  lineId: ID;
  kind: CardKind;
  tokens: Token[];
  /** 该卡在其定义作用域内的序号 */
  order: number;
  /** 解析诊断（未知元件也不删除，仅标注） */
  diagnostic: string | null;
}

export interface ElementCard {
  cardId: ID;
  /** 实例名原文，如 'R1'、'XAMP' */
  name: string;
  /** 首字母元件类型：R C L D Q M J V I X ... */
  typePrefix: string;
  /** 节点 token 原文（保留 0 与命名节点） */
  nodeTokens: Token[];
  /** 对 X：被引用子电路名；对器件：可能存在的 model 名 */
  refName: string | null;
  /** 行内 name=value 参数 token */
  paramTokens: { name: Token; value: Token }[];
  /** 位置参数（无法配对的尾部 token，按序保留） */
  positional: Token[];
  /** true 时为无法识别元件类型（首字母不在已知表） */
  opaque: boolean;
}

export interface SubcktDef {
  cardId: ID;
  /** 子电路名原文 */
  name: string;
  /** 外部节点名原文（顺序即端口序） */
  ports: string[];
  /** 形参默认值原文 name=value */
  formalDefaults: { name: string; raw: string }[];
  /** 体内卡 id 顺序 */
  bodyCardIds: ID[];
  /** 同名定义时的消歧身份（来源+行） */
  identity: ID;
}

export interface ModelDef {
  cardId: ID;
  /** model 名原文 */
  name: string;
  /** model 类型原文，如 NPN/NMOS，大小写保留，另存 upper 供匹配 */
  type: string;
  /** 参数字面量原文 */
  params: { name: string; raw: string }[];
  /** 版本身份：同名同类型多份定义时并列保留 */
  version: number;
  identity: ID;
}

/** 解析+include 解析后的一个导入集合（一侧网表） */
export interface NetlistUnit {
  side: Side;
  sources: SourceFile[];
  lines: RawLine[];
  cards: ParsedCard[];
  elements: Record<ID, ElementCard>;
  subckts: Record<string, SubcktDef[]>; // 重名：数组
  models: Record<string, ModelDef[]>; // 同名多版本：数组
  includes: IncludeEdge[];
  diagnostics: Diagnostic[];
}

export type Side = 'A' | 'B';

export interface Diagnostic {
  id: ID;
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  sourceId: ID;
  lineId: ID | null;
  /** 诊断锚定的对象身份 */
  subjectId: ID | null;
}
