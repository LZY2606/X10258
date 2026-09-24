/**
 * 网表双影室 —— SPICE 领域模型。
 * 原则：原文本、行续接、子电路实例、参数表达式、model 版本、include 来源、
 * 单位后缀在导入层一律不改写；规范化只发生在派生层。
 */

export interface RawLine {
  file: string;
  line: number;      // 1-based 物理行号
  text: string;      // 原始行文本（含续行标记）
  continued: boolean;
}

export interface SourceRef {
  file: string;
  line: number;            // 逻辑行起始物理行号
  statementId: string;     // 稳定身份 stmt:<file>:<index>
}

/** 表达式节点：参数表达式不可压平，保留依赖 */
export type ExprNode =
  | { kind: 'num'; raw: string }
  | { kind: 'ref'; name: string }
  | { kind: 'op'; op: string; args: ExprNode[] };

export interface ValueToken {
  raw: string; // 原始 token，不改写
  kind: 'number' | 'expr' | 'ident' | 'string';
  expr?: ExprNode;
}

export interface ParamAssign {
  key: string;
  value: ValueToken;
  raw: string; // 形如 "W={WDEF*2}" 的原文
}

interface StmtBase {
  id: string;          // 稳定身份
  raw: string;         // 拼接续行后的原文（不改写）
  lines: RawLine[];    // 行续接信息保留
  source: SourceRef;
}

export type Statement =
  | (StmtBase & { type: 'title'; text: string })
  | (StmtBase & { type: 'comment'; text: string })
  | (StmtBase & { type: 'subckt'; name: string; ports: string[]; defaults: ParamAssign[] })
  | (StmtBase & { type: 'ends'; name: string | null })
  | (StmtBase & { type: 'model'; name: string; modelType: string; params: ParamAssign[] })
  | (StmtBase & { type: 'include'; path: string })
  | (StmtBase & { type: 'param'; params: ParamAssign[] })
  | (StmtBase & {
      type: 'device';
      name: string;
      kindLetter: string;      // 规范化后的大写首字母
      known: boolean;          // 未知元件为 false → opaque 保留
      nodes: string[];
      positional: ValueToken[]; // 模型名/取值等位置参数（原文 token）
      params: ParamAssign[];
    })
  | (StmtBase & { type: 'directive'; name: string; args: string[] })
  | (StmtBase & { type: 'end' });

export interface NetlistFile {
  id: string;        // 稳定身份 file:<path>
  path: string;
  role: 'netlist' | 'include' | 'model';
  rawText: string;   // 整文件原文，不改写
  statements: Statement[];
}

/** 已知元件首字母（其余一律 opaque 保留，不删除） */
export const KNOWN_DEVICE_LETTERS = new Set([
  'R', 'C', 'L', 'D', 'Q', 'M', 'J', 'X', 'V', 'I', 'E', 'G', 'F', 'H', 'K', 'S', 'W', 'T', 'B',
]);

/** 对称器件：引脚组内允许置换（M 的 D/S、差分对输入等） */
export const SYMMETRIC_PIN_GROUPS: Record<string, number[][]> = {
  M: [[0, 2]], // D <-> S
  J: [[0, 2]],
};
