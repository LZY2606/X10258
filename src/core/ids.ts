import { createHash } from 'node:crypto';

/** 内容派生的稳定身份：导出→删库→导入后保持一致 */
export function stableId(prefix: string, ...parts: (string | number)[]): string {
  const material = parts.map((p) => String(p)).join('\u0001');
  const digest = createHash('sha256').update(material).digest('hex').slice(0, 16);
  return `${prefix}_${digest}`;
}

export function sha256Text(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
