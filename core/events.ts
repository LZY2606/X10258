/** 机器可读事件：所有判断依据都以事件形式落库 */
export interface DomainEvent {
  id: string;                 // 稳定身份 evt:<run>:<n>
  kind: string;               // 见 EVENT_KINDS
  payload: Record<string, unknown>;
  subjects: string[];         // 受影响对象的稳定身份
}

export const EVENT_KINDS = [
  'import', 'parse', 'include-resolved', 'include-cycle',
  'subckt-collision', 'param-override', 'param-default-used',
  'unit-normalized', 'unit-unconvertible',
  'opaque-element', 'symmetric-permutation', 'alpha-rename',
  'equiv-judgment', 'minimal-diff',
  'decision-proposed', 'decision-accepted', 'decision-rejected',
  'branch-created', 'branch-continued', 'conflict-detected', 'conflict-resolved',
  'replay-step', 'version-committed', 'migration',
  // 语义规则（机器可读的裁定依据）
  'rule:alpha-rename-allowed',
  'rule:param-scope-not-flattened',
  'rule:opaque-kept',
] as const;
