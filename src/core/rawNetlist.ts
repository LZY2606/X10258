import type {
  RawLogicalLine, RawModel, ParamAssignment, IncludeRef,
  SubcktDef, OpaqueElement, Diagnostic, SourceLoc
} from "./types.js";

export interface RawElement {
  id: string;
  instNameRaw: string;
  classLetter: string;
  nodesRaw: string[];
  modelOrValue: string | null;
  restTokens: string[];
  /** 子电路实例形参覆盖：X... PARAMS: W=...（保留原文）。 */
  instanceParams: ParamAssignment[];
  /** 对 X 元件：指向被实例化的 subckt 名（原始），由绑定阶段解析。 */
  subcktNameRaw: string | null;
  loc: SourceLoc;
  /** 所在层次路径（subckt id 链），顶层为 []。 */
  ownerPath: string[];
  /** 已知元件类（派生判定），未知则进入 opaque。 */
  known: boolean;
  opaqueReason: string | null;
}

export interface RawNetlist {
  logicalLines: RawLogicalLine[];
  elements: RawElement[];
  subckts: SubcktDef[];
  models: RawModel[];
  includes: IncludeRef[];
  paramAssignments: ParamAssignment[];
  globalNodes: { nameRaw: string; loc: SourceLoc }[];
  diagnostics: Diagnostic[];
}

export const KNOWN_CLASS_LETTERS = new Set([
  "r", "c", "l", "d", "q", "m", "j", "z", "f", "g", "h", "e", "k", "s", "w", "v", "i", "x", "o", "u", "t", "p"
]);

/** 各已知元件的节点数（不含 model/value），用于结构校验；x 为变端口，单独处理。 */
export const CLASS_NODE_ARITY: Record<string, number> = {
  r: 2, c: 2, l: 2, d: 2, v: 2, i: 2,
  e: 4, g: 4, f: 2, h: 2,
  q: 3, j: 3, z: 3, m: 4,
  k: 2, s: 4, w: 4, o: 4, u: 0
};
