import { createHash } from 'node:crypto';

/** 稳定身份：内容寻址哈希。导出/删除/再导入后身份不变。 */
export function contentId(kind: string, ...parts: string[]): string {
  const h = createHash('sha256');
  h.update(kind);
  for (const p of parts) h.update('').update(p);
  return `${kind}_${h.digest('hex').slice(0, 16)}`;
}

let seqCounter = 0;
/** 事件/版本身份：时间有序且导出可保留。 */
export function orderedId(prefix: string, seq: number): string {
  return `${prefix}_${String(seq).padStart(8, '0')}`;
}

export function nextLocalSeq(): number {
  return ++seqCounter;
}
