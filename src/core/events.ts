/** 机器可读的领域事件：所有判定、诊断与裁定都以事件落库。 */
export interface DomainEvent {
  kind: string;
  summary: string;
  detail: Record<string, unknown>;
}

export const EV = {
  INCLUDE_CYCLE: 'include.cycle',
  SUBCKT_DUPLICATE: 'subckt.duplicate',
  DEVICE_UNKNOWN: 'device.unknown',
  PARAM_UNCONVERTIBLE: 'param.unconvertible',
  UNIT_SUFFIX: 'unit.suffix',
  PARAM_OVERRIDE: 'param.override',
  EQUIV_PERMUTATION: 'equiv.symmetric-permutation',
  ALPHA_RENAME: 'equiv.alpha-rename',
  PARAM_DIFF: 'equiv.param-diff',
  EXPR_SAME_VALUE: 'equiv.expr-different-same-value',
  TOPO_DIFF: 'equiv.topology-diff',
  MIN_DIFF: 'equiv.minimal-diff-subgraph',
  MULTI_CANDIDATE: 'equiv.multi-candidate',
  DECISION: 'review.decision',
  CONFLICT: 'review.conflict',
  CONFLICT_RESOLVED: 'review.conflict-resolved',
  TIME_TRAVEL: 'review.time-travel',
  RECOMPUTE: 'derive.recompute',
} as const;
