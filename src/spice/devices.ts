// 元件字母 -> 节点引脚数（位置参数）与引脚对称性（可置换而不改变连接语义）。
export interface DeviceMeta {
  letter: string;
  arity: number;
  label: string;
  /** 对称引脚组：组内可互换。例如 MOS 的 D/S（部分拓扑下）默认保守不设；
   *  差分对/匹配管的对称通过"同型器件置换"在同构层处理。 */
  symmetricPins?: number[][];
  known: boolean;
}

export const DEVICE_TABLE: Record<string, DeviceMeta> = {
  R: { letter: 'R', arity: 2, label: 'resistor' },
  C: { letter: 'C', arity: 2, label: 'capacitor' },
  L: { letter: 'L', arity: 2, label: 'inductor' },
  D: { letter: 'D', arity: 2, label: 'diode' },
  Q: { letter: 'Q', arity: 4, label: 'bjt', symmetricPins: [[1, 2]] }, // 集电极/发射极不对称；保守处理基极外引脚；这里不声明对称
  M: { letter: 'M', arity: 4, label: 'mosfet' },
  J: { letter: 'J', arity: 3, label: 'jfet' },
  B: { letter: 'B', arity: 2, label: 'behavioral-source' },
  E: { letter: 'E', arity: 4, label: 'vcvs' },
  G: { letter: 'G', arity: 4, label: 'vccs' },
  F: { letter: 'F', arity: 2, label: 'cccs' },
  H: { letter: 'H', arity: 2, label: 'ccvs' },
  I: { letter: 'I', arity: 2, label: 'current-source', symmetricPins: [[0, 1]] },
  V: { letter: 'V', arity: 2, label: 'voltage-source', symmetricPins: [[0, 1]] },
  K: { letter: 'K', arity: 0, label: 'coupling' },
  S: { letter: 'S', arity: 4, label: 'switch' },
  W: { letter: 'W', arity: 2, label: 'current-switch' },
  T: { letter: 'T', arity: 4, label: 'transmission-line' },
  O: { letter: 'O', arity: 4, label: 'lossy-line' },
  U: { letter: 'U', arity: 3, label: 'uniform-rc' },
};

// Q 的保守处理：BJT 引脚不做对称置换（C/E 不等价）。
DEVICE_TABLE.Q.symmetricPins = undefined;

export function deviceMeta(letter: string): DeviceMeta {
  return DEVICE_TABLE[letter] ?? { letter, arity: 0, label: 'unknown', known: false };
}

/** 无源两端元件（R/C/L）引脚天然对称。 */
DEVICE_TABLE.R.symmetricPins = [[0, 1]];
DEVICE_TABLE.C.symmetricPins = [[0, 1]];
DEVICE_TABLE.L.symmetricPins = [[0, 1]];
DEVICE_TABLE.D.symmetricPins = undefined;
DEVICE_TABLE.J.symmetricPins = undefined;
