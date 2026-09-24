/**
 * 稳定身份：所有身份都由内容与结构位置确定性导出，
 * 不依赖 SQLite rowid，因此导出→删库→导入后身份保持。
 */
import { createHash } from 'node:crypto';

export const shortHash = (...parts: string[]): string => {
  const bytes = createHash('sha256').update(parts.join('')).digest();
  // base32 (RFC4648 lowercased) 前 26 位 → 约 130 bit，碰撞概率可忽略
  let bits = '';
  for (const b of bytes) bits += b.toString(2).padStart(8, '0');
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let out = '';
  for (let i = 0; i + 5 <= bits.length; i += 5) {
    out += alphabet[parseInt(bits.slice(i, i + 5), 2)];
    if (out.length === 26) break;
  }
  return out;
};

export const sid = (kind: string, ...parts: string[]): string =>
  `${kind}:${shortHash(...parts)}`;

export const docId = (revisionId: string, path: string, content: string): string =>
  sid('doc', revisionId, path, content);

export const logicalLineId = (fileId: string, ordinal: number): string =>
  `ln:${fileId}:${String(ordinal).padStart(6, '0')}`;

export const elementId = (branch: string, instancePath: string): string =>
  `el:${branch}:${instancePath}`;

export const nodeId = (branch: string, path: string, local: string): string =>
  `nd:${branch}:${path}/${local}`;

export const modelId = (branch: string, name: string, bodySha: string): string =>
  `md:${branch}:${name.toLowerCase()}:${bodySha.slice(0, 16)}`;

export const subcktDefId = (branch: string, name: string, bodySha: string): string =>
  `sx:${branch}:${name.toLowerCase()}:${bodySha.slice(0, 16)}`;

export const eventId = (seq: number, kind: string, payload: unknown): string =>
  `ev:${String(seq).padStart(8, '0')}:${shortHash(kind, JSON.stringify(payload))}`;
