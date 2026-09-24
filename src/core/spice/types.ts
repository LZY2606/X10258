/** 溯源信息：任何被展示/比较的值都能回到原始文件与行号。 */
export interface Provenance {
  file: string;
  line: number;      // 逻辑行起始行号（1 基）
  endLine: number;   // 行续接合并后的结束行号
  raw: string;       // 原文本（含续接行，不改写）
}

/** 参数值：原始表示永远保留；规范化只在派生层发生。 */
export interface ParamValue {
  raw: string;                    // 原文 token，如 "1k"、"{RVAL*2}"、"4.7meg"
  kind: 'number' | 'expr' | 'identifier' | 'string';
  normalized?: number;            // 派生层规范化结果（SI 基本单位）
  unit?: string;                  // 单位后缀原文（k/meg/mil/...）
  dependsOn: string[];            // 表达式依赖的参数名（作用域链解析前）
  diagnostic?: string;            // 无法转换时留在原位并附诊断
}

export interface ParamAssign {
  name: string;
  value: ParamValue;
  prov: Provenance;
}

export type ElementKind =
  | 'R' | 'C' | 'L' | 'K' | 'V' | 'I' | 'D' | 'Q' | 'M' | 'J' | 'B' | 'E' | 'F' | 'G' | 'H' | 'S' | 'W'
  | 'X'      // 子电路实例
  | 'UNKNOWN';

export interface Element {
  id: string;              // 稳定身份：内容寻址（见 ids.ts）
  name: string;            // 原文实例名
  kind: ElementKind;
  letter: string;          // 原始首字母（未知元件保留）
  nodes: string[];         // 原文节点名（未改名）
  subcktName?: string;     // X 实例引用的子电路名
  modelName?: string;      // M/Q/D 等引用的 model 名
  params: ParamAssign[];
  value?: ParamValue;      // R/C/L/V/I 的主值
  prov: Provenance;
  opaque?: boolean;        // 未知元件：保留 opaque 连接而不删除
}

export interface ModelCard {
  id: string;
  name: string;
  type: string;            // nmos/pmos/res/...
  versionTag: string;      // model 版本（来自文件集哈希，不改写内容）
  params: ParamAssign[];
  prov: Provenance;
}

export interface SubcktDef {
  id: string;
  name: string;
  ports: string[];
  defaults: ParamAssign[]; // .subckt 行上的 params: 默认参数
  elements: Element[];
  models: ModelCard[];
  params: ParamAssign[];   // 局部 .param
  prov: Provenance;
  sourceFile: string;      // include 来源
}

export interface IncludeEdge {
  from: string;            // 发起 include 的文件
  to: string;              // 被 include 的文件
  prov: Provenance;
  cycle?: boolean;         // 循环 include 诊断
}

export interface NetlistDoc {
  id: string;
  title: string;
  files: string[];                 // 参与解析的文件（include 展开后）
  includes: IncludeEdge[];
  globals: ParamAssign[];          // 顶层 .param
  models: ModelCard[];             // 顶层 .model
  subckts: SubcktDef[];            // 可能重名：全部保留，由解析层裁定
  topElements: Element[];
  diagnostics: Diagnostic[];
}

export interface Diagnostic {
  id: string;
  severity: 'info' | 'warn' | 'error';
  code: string;                    // 如 SUBCKT_NAME_COLLISION / INCLUDE_CYCLE / UNKNOWN_ELEMENT
  message: string;
  prov?: Provenance;
  related: string[];               // 相关对象稳定 id
}

/** 展平后的实例：节点/实例已 alpha-rename，参数作用域未压平。 */
export interface FlatInstance {
  id: string;                      // 稳定身份
  path: string;                    // 层次路径，如 xu1/xm2
  kind: ElementKind;
  letter: string;
  modelName?: string;
  subcktName?: string;
  nodes: string[];                 // 展平后节点名（层次路径化）
  effectiveParams: ScopedParam[];  // 每个参数带来源作用域
  opaque: boolean;
  sourceElementId: string;         // 回溯到原始 Element
  prov: Provenance;
}

export interface ScopedParam {
  name: string;
  value: ParamValue;               // 原始表示保留
  scope: 'instance' | 'subckt-default' | 'subckt-local' | 'global' | 'model';
  scopePath: string;               // 提供该值的作用域路径
  resolved: boolean;               // 依赖是否已在作用域链内解析
}

export interface FlatNetlist {
  id: string;
  docId: string;
  instances: FlatInstance[];
  nodes: string[];
  diagnostics: Diagnostic[];
  stats: { instances: number; nodes: number; opaque: number };
}
