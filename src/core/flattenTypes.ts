import type { ID, ParamValue, ParamOrigin } from './types';

/** 展平后的器件实例（alpha-rename 后仍有稳定路径身份） */
export interface FlatDevice {
  id: ID;
  /** 层次路径，如 'ROOT.XAMP.Q2'，稳定、唯一 */
  path: string;
  /** 实例短名 */
  localName: string;
  /** 器件族：resistor/capacitor/inductor/diode/bjt/mosfet/.../unknown */
  family: DeviceFamily;
  /** 原元件首字母，保留（unknown 也保留） */
  prefix: string;
  /** 引用的 model 名（含作用域解析后的 identity），无则 null */
  modelRef: { name: string; identity: ID | null } | null;
  /** 端口：引脚名 -> 展平后网络 id；unknown 用 pin1..pinN 的 opaque 连接 */
  pins: { pin: string; netId: ID; rawNode: string }[];
  /** 实例有效参数（含来源），表达式依赖不压平 */
  params: FlatParam[];
  /** 来源链：定义卡 -> 各级 X 实例卡 */
  provenance: { sourceId: ID; lineId: ID; cardId: ID }[];
  /** 对称引脚等价类，如 bjt 的 ['c','b']？否——见 familySymmetries；此处给置换组 */
  symmetricPinGroups: string[][];
  /** 若为未知元件：opaque 声明，不删除 */
  opaque: boolean;
}

export type DeviceFamily =
  | 'resistor'
  | 'capacitor'
  | 'inductor'
  | 'diode'
  | 'bjt'
  | 'mosfet'
  | 'jfet'
  | 'vsource'
  | 'isource'
  | 'subckt-instance'
  | 'unknown';

export interface FlatParam {
  name: string;
  /** 作用域内最终可见值（采纳哪一候选由 flatten 时的作用域规则决定） */
  effective: ParamValue;
  origin: ParamOrigin;
  /** 默认值（若有），用于证明“默认值未被压平” */
  defaultValue: ParamValue | null;
  /** 覆盖值（实例行），用于证明“局部覆盖” */
  overrideValue: ParamValue | null;
}

export interface FlatNet {
  id: ID;
  /** ROOT 层节点保留原名；内部节点使用路径限定名 */
  canonical: string;
  /** 该网络合并的所有原始 (实例路径, 节点原文) */
  members: { devicePath: string; rawNode: string }[];
  /** 是否顶层对外节点 */
  external: boolean;
}

export interface HierarchyNode {
  id: ID;
  /** X 实例路径；根为 'ROOT' */
  path: string;
  localName: string;
  /** 引用的子电路 definition identity；根为 null */
  subcktIdentity: ID | null;
  parent: ID | null;
  children: ID[];
  /** 该实例处的实参覆盖原文 */
  args: { name: string; raw: string }[];
  /** 实例卡来源 */
  provenance: { sourceId: ID; lineId: ID; cardId: ID };
}

export interface FlatCircuit {
  side: 'A' | 'B';
  devices: FlatDevice[];
  nets: FlatNet[];
  hierarchy: HierarchyNode[];
  /** 参数表：所有作用域参数（含默认/覆盖/.PARAM），不压平 */
  scopedParams: { key: string; name: string; path: string; effective: ParamValue; defaultValue: ParamValue | null; overrideValue: ParamValue | null; origin: ParamOrigin }[];
  diagnostics: { code: string; message: string; subjectId: ID | null }[];
}
