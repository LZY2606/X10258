// 领域类型定义：所有“原始表示”字段都标注 Raw，导入阶段不做任何改写。

/** 来源坐标：每个原始片段都能反查到文件、起止行/列、include 来源链。 */
export interface SourceLoc {
  fileId: string;
  /** 物理行号（1-based，按原始文件换行切分）。 */
  line: number;
  /** 列起止（0-based, 半开区间），指向原始行文本。 */
  colStart: number;
  colEnd: number;
  /** include 来源链：[根文件, ..., 当前文件] 的 fileId 序列。 */
  includeChain: string[];
}

/** 原始逻辑行：行续接已按结构关联，但 rawText 保持逐字节原文（含续行符与空白）。 */
export interface RawLogicalLine {
  id: string;
  /** 组成该逻辑行的物理行（每行保留原始文本，包括 '+' 前缀）。 */
  physical: { rawText: string; line: number; noNewline: boolean }[];
  loc: SourceLoc;
  /** 是否包含至少一个行续接（首个物理行之后以 '+' 开头）。 */
  continued: boolean;
  /** 去掉注释（'$' 或 ';' 起）后的逻辑令牌，但保留原始大小写与后缀。 */
  tokens: string[];
  /** 注释原文（含起始符），无则 null。 */
  comment: string | null;
  /** 指令类型（原始小写关键字），如 .subckt/.ends/.include/.param/.model/.global/.end。 */
  kind: "element" | "control" | "blank" | "comment";
  controlName?: string;
}

export type ParamValueKind =
  | { kind: "numeric"; raw: string }
  | { kind: "string"; raw: string }
  | { kind: "expression"; raw: string };

/** 参数赋值的原始表示 + 来源 + 规范化结果（派生层填充）。 */
export interface ParamAssignment {
  id: string;
  /** 参数名的原始拼写（SPICE 参数大小写不敏感，派生层另有 canonicalName）。 */
  nameRaw: string;
  /** '=' 是否带空格等均不保留到结构，但整个 rawText 保留。 */
  valueRaw: string;
  loc: SourceLoc;
  /** 作用域层级：subckt 名 / 'TOP'。 */
  scopePath: string[];
  /** 派生层：尝试解析出的数值与单位；无法转换时 raw 保留且诊断非空。 */
  normalized?: NormalizedValue;
}

export interface NormalizedValue {
  /** SI 基准单位下的数值（派生量，不回写原文）。 */
  siValue: number | null;
  /** 原始单位后缀文本，如 "k"、"uF"、"Meg"、"GHz"；无后缀为 ""。 */
  unitSuffix: string;
  /** 坐标/单位基准，例如 "resistance:ohm"、"capacitance:F"、"frequency:Hz"、"dimensionless"。 */
  basis: string;
  /** 解析诊断；无法转换时 non-null，值留在原位置。 */
  diagnostic: string | null;
  /** 依赖的外部参数名（canonical），表达式无法立即求值时记录。 */
  dependsOn: string[];
}

export interface RawModel {
  id: string;
  nameRaw: string;
  /** 原始类型，如 NMOS/PMOS/R/C/…（SPICE 大小写不敏感，保留原文）。 */
  typeRaw: string;
  /** .model 行内的全部 token（含 name/type/参数），用于版本比对。 */
  paramsRaw: { nameRaw: string; valueRaw: string; loc: SourceLoc }[];
  loc: SourceLoc;
  /** include 来源链快照。 */
  originFileId: string;
  /** 同一 model 名重复定义时的版本序号（按导入顺序）。 */
  versionIndex: number;
}

export interface IncludeRef {
  id: string;
  /** .include/.lib 后的原始路径文本（保留引号与大小写）。 */
  pathRaw: string;
  loc: SourceLoc;
  /** 解析到的 fileId；循环/缺失时为 null。 */
  resolvedFileId: string | null;
  /** 'include' | 'lib' 以及 .lib section 名（如有，保留原文）。 */
  mode: "include" | "lib";
  sectionRaw: string | null;
  diagnostic: string | null;
}

export interface RawFile {
  id: string;
  /** 仓库相对路径（导入时登记的路径，不改写）。 */
  path: string;
  /** 原始文件字节解码文本（LF 归一仅用于行切分索引，rawText 每行保留行尾前原文）。 */
  content: string;
  /** 内容的 sha256，用于身份稳定与导入幂等。 */
  sha256: string;
  side: "A" | "B" | "shared";
}

export interface SubcktDef {
  id: string;
  nameRaw: string;
  /** 外部端口，顺序即连接顺序；保留原始节点名。 */
  ports: { nameRaw: string; loc: SourceLoc }[];
  /** 形参默认值（原始）。 */
  params: ParamAssignment[];
  bodyLineIds: string[];
  loc: SourceLoc;
  fileId: string;
  /** 同名定义序号（子电路重名场景）。 */
  versionIndex: number;
}

/** 未识别元件：不删除，作为 opaque 黑盒保留连接。 */
export interface OpaqueElement {
  id: string;
  instNameRaw: string;
  /** 元件首字母（决定 SPICE 元件类），如 X/Y/G/…，未知时保留。 */
  classLetter: string;
  nodesRaw: string[];
  restTokens: string[];
  loc: SourceLoc;
  reason: string;
}

export type DiagnosticLevel = "error" | "warning" | "info";

export interface Diagnostic {
  id: string;
  code: string;
  level: DiagnosticLevel;
  message: string;
  loc: SourceLoc | null;
  subjectId: string | null;
}
