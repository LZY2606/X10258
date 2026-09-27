/**
 * 领域模型。所有“原始层”结构都逐字保留来源表示；派生层（数值/规范化）放在独立字段。
 */

export type Spine = 'A' | 'B';

/** 一条物理源行（未做任何改写）。 */
export interface RawLine {
  fileId: string;
  /** 物理行号，从 1 开始。 */
  lineNo: number;
  /** 逐字原文（不含换行符）。 */
  raw: string;
  /** 行续接：属于第几条逻辑行（逻辑行首物理行号）。 */
  logicalNo: number;
  /** 在逻辑行中的续接次序，0 表示首行；>0 表示被 '+' 续接。 */
  continuationIndex: number;
}

/** 重组后的逻辑行：原文由片段拼接，不丢任何字符信息。 */
export interface LogicalLine {
  fileId: string;
  logicalNo: number;
  /** 首物理行号。 */
  firstLineNo: number;
  /** 构成该逻辑行的物理行号。 */
  physicalLines: number[];
  /** 逐字拼接的原始文本（首行原文 + 每个续行去掉起始 '+' 前保留诊断信息）。 */
  joinedRaw: string;
  /** 去注释后的令牌原文（令牌大小写/数字后缀不改写）。 */
  tokens: string[];
  /** 行内注释原文（若有），含前导分隔。 */
  inlineComment: string | null;
  hasContinuation: boolean;
}

export type NetItemKind =
  | 'instance'
  | 'subckt'
  | 'ends'
  | 'model'
  | 'include'
  | 'control'
  | 'param'
  | 'global'
  | 'blank'
  | 'comment';

export interface ParamAssign {
  /** 形参名（原文大小写）。 */
  name: string;
  /** '=' 右侧表达式逐字原文。 */
  exprRaw: string;
  /** 来源逻辑行。 */
  origin: Origin;
  /** 是否显式写了值（false 表示仅形参无默认，如 .subckt X a b P= 之类不出现）。 */
  hasDefault: boolean;
}

export interface Origin {
  fileId: string;
  logicalNo: number;
  firstLineNo: number;
  physicalLines: number[];
  /** 行内令牌片段的逐字切片（可空），用于从异常点反查到列。 */
  snippet: string;
  spine?: Spine;
}

export interface InstanceNodeRef {
  /** 逐字网络名（可能是数字节点，也可能是命名网络）。 */
  raw: string;
  /** 是否解析为全局网络（.global / 节点 0）。 */
  global: boolean;
}

export interface ParsedInstance {
  kind: 'instance';
  /** 实例名原文，首字母决定器件族。 */
  nameRaw: string;
  /** 器件族（首字母大写化的判定键，原文仍保留在 nameRaw）。 */
  family: string;
  nodes: InstanceNodeRef[];
  /** 形如 <modelname> 或 <value> 的逐字主体令牌，顺序保留。 */
  bodyTokens: string[];
  /** 被识别为引用的子电路/model 名（小写键，原文另存）。 */
  modelRefRaw: string | null;
  /** name=value 形式的实例参数（原文）。 */
  params: ParamAssign[];
  origin: Origin;
  /** 出现时所在的词法作用域：'' 表示顶层，否则为子电路名键。 */
  lexicalScope: string;
}

export interface ParsedSubckt {
  kind: 'subckt';
  nameRaw: string;
  nameKey: string;
  ports: string[];
  params: ParamAssign[];
  /** 可选 params: / optparams: 形态标记，保留原文诊断。 */
  paramsStyle: 'inline' | 'params:' | 'optparams:' | 'none';
  body: ParsedNetItem[];
  origin: Origin;
  endsOrigin: Origin | null;
}

export interface ParsedEnds {
  kind: 'ends';
  nameRaw: string | null;
  origin: Origin;
}

export interface ParsedModel {
  kind: 'model';
  nameRaw: string;
  nameKey: string;
  typeRaw: string;
  /** 所有参数赋值逐字保留（含单位后缀）。 */
  params: ParamAssign[];
  origin: Origin;
  versionKey: string;
}

export interface ParsedInclude {
  kind: 'include';
  /** .include/.lib 原始关键字。 */
  directive: string;
  /** 路径逐字原文（保留引号）。 */
  pathRaw: string;
  /** .lib 可能带 section/token。 */
  extraTokens: string[];
  origin: Origin;
  /** 解析阶段填：解析到的文件 id；循环/缺失时为 null。 */
  resolvedFileId: string | null;
}

export interface ParsedParam {
  kind: 'param';
  assigns: ParamAssign[];
  origin: Origin;
  lexicalScope: string;
}

export interface ParsedGlobal {
  kind: 'global';
  nodes: string[];
  origin: Origin;
}

export interface ParsedControl {
  kind: 'control';
  directive: string;
  tokens: string[];
  origin: Origin;
}

export type ParsedNetItem =
  | ParsedInstance
  | ParsedSubckt
  | ParsedEnds
  | ParsedModel
  | ParsedInclude
  | ParsedParam
  | ParsedGlobal
  | ParsedControl;

export interface SourceFile {
  fileId: string;
  /** 相对工程根的“逻辑路径”，使用正斜杠；这是来源坐标的一部分。 */
  path: string;
  /** 逐字全文。 */
  text: string;
  rawLines: RawLine[];
  logicalLines: LogicalLine[];
  /** 顶层词法顺序的条目（include 节点保留在内，展开由 include 图处理）。 */
  items: ParsedNetItem[];
  /** 解析诊断（不改写原文，只附着诊断）。 */
  diagnostics: Diagnostic[];
}

export interface Diagnostic {
  code: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  origin: Origin | null;
  /** 无法转换/解析时，原值留在原处，诊断指向它。 */
  offendingRaw?: string;
}

/** include 图：边 = (fromFile, directiveIndex) -> toFile。 */
export interface IncludeGraph {
  edges: Array<{
    fromFileId: string;
    includeIndex: number;
    toFileId: string | null;
    cycle: boolean;
    cyclePath: string[];
  }>;
  /** 根文件先序去重的包含序列（循环边不二次进入）。 */
  inclusionOrder: string[];
}

export interface ParsedNetlist {
  spine: Spine;
  rootFileId: string;
  files: Record<string, SourceFile>;
  includeGraph: IncludeGraph;
  diagnostics: Diagnostic[];
}
