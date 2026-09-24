// 核心领域类型。贯穿"原文本 -> 解析 -> 展平 -> 等价 -> 裁定 -> 版本"全流程。

export type RuleVersion = string; // 规则版本，例如 'rule/1.0.0'

export interface Coord {
  /** 1 基物理行号（保留行续接后的物理定位） */
  line: number;
  /** 0 基列 */
  column: number;
}

export interface Origin {
  /** 来源文件的稳定标识（由路径推导） */
  fileId: string;
  /** 该文件在 include 展开顺序中的逻辑路径，原样保留 */
  path: string;
  /** include 链，根文件为空数组 */
  includeChain: string[];
  start: Coord;
  end?: Coord;
}

export interface SourceFile {
  fileId: string;
  /** include 用的路径，原样保留 */
  path: string;
  /** 原始字节文本，绝不改写 */
  rawText: string;
}

export interface SourceLine {
  /** fileId + ':' + physicalLine */
  id: string;
  fileId: string;
  physicalLine: number; // 1 基
  raw: string; // 原文本（含前缀空白与续行符），不改写
  continuation: boolean; // 该行是否以 '+' 续接到上一逻辑行
}

export interface Token {
  text: string; // 原样大小写
  start: Coord;
  end: Coord;
}

export type ParamKind = 'scalar' | 'vector';

export interface ParamDefault {
  /** 原始表达式文本，不改写，例如 '2*PI' 或 '10k' */
  raw: string;
  origin: Origin;
}

export interface ParamDef {
  name: string; // 规范大写名
  rawName: string;
  defaultExpr?: ParamDefault;
  origin: Origin;
}

export type DirectiveKind =
  | 'subckt'
  | 'ends'
  | 'model'
  | 'include'
  | 'lib'
  | 'param'
  | 'globals'
  | 'control'
  | 'unknown';

export interface SubcktDef {
  id: string; // content-derived
  kind: 'subckt';
  name: string; // 大写
  rawName: string;
  ports: string[]; // 端口内部名（原样大写化），顺序保留
  params: ParamDef[];
  body: LogicalLine[];
  origin: Origin;
  endOrigin?: Origin;
}

export interface ModelDef {
  id: string;
  kind: 'model';
  name: string;
  rawName: string;
  /** model 类型，如 NMOS/RES；原样 */
  type: string;
  /** 版本标识：同文件内可出现多个同名 model（版本不同），保留全部 */
  versionKey: string;
  params: { rawName: string; rawValue: string }[];
  origin: Origin;
}

export interface IncludeDirective {
  kind: 'include' | 'lib';
  target: string; // 原样路径
  section?: string; // .lib 可带 section
  origin: Origin;
}

export interface ParamDirective {
  kind: 'param';
  params: ParamDef[];
  origin: Origin;
}

export type InstanceType =
  | 'R' | 'C' | 'L' | 'D' | 'Q' | 'M' | 'J' | 'B' | 'E' | 'F' | 'G' | 'H' | 'I' | 'V' | 'K' | 'S' | 'W' | 'T' | 'O' | 'U' | 'X'
  | 'unknown';

export interface InstanceLine {
  kind: 'instance';
  id: string;
  /** 实例首字母大写，X 为子电路实例 */
  letter: string;
  name: string; // 大写
  rawName: string;
  /** 原始节点名（未改名前），顺序保留 */
  nodes: string[];
  /** X 实例的子电路名（原样） */
  subName?: string;
  /** 子电路实例的原始位置参数（端口表达式） */
  positional: string[];
  /** name=value 原始片段（含单位后缀），不改写 */
  params: { rawName: string; rawValue: string; start: Coord }[];
  /** 未被消费的 token（未知元件时保留全部语义线索） */
  rest: Token[];
  /** 未知/不支持元件：opaque，不删除 */
  opaque: boolean;
  origin: Origin;
}

export interface PlainDirective {
  kind: Exclude<DirectiveKind, 'subckt' | 'ends' | 'model' | 'include' | 'lib' | 'param'>;
  tokens: Token[];
  origin: Origin;
}

export type LogicalLine =
  | SubcktDef
  | ModelDef
  | IncludeDirective
  | ParamDirective
  | InstanceLine
  | { kind: 'ends'; name?: string; origin: Origin }
  | PlainDirective;

/** 解析产物：以来源文件为边界，原样保留所有物理行 */
export interface ParsedFile {
  file: SourceFile;
  lines: SourceLine[];
  directives: LogicalLine[];
  diagnostics: Diagnostic[];
}

export type Severity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  code: string;
  message: string;
  severity: Severity;
  origin?: Origin;
}

/** include 解析后的来源单元 */
export interface LoadedUnit {
  fileId: string;
  path: string;
  includeChain: string[];
  parsed: ParsedFile;
}

/** SPICE 数值（携带单位基准与原始表示） */
export interface SpiceNumber {
  ok: boolean;
  raw: string; // 原始表示
  value?: number; // SI 规范化数值
  scaleSuffix?: string; // 匹配到的比例后缀，原样（如 'k' 'meg'）
  unitSuffix?: string; // 物理单位后缀，原样（如 'ohm' 'f' 'V'），无则 undefined
  basis?: string; // 坐标/单位基准，例如 'SI:ohm'；无法转换时保留原值并附诊断
  reason?: string;
}
