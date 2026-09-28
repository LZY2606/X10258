import { createHash } from 'node:crypto';

export function stableHash(value: string, length = 16): string {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

export function stableId(kind: string, ...parts: Array<string | number | null | undefined>): string {
  return `${kind}:${stableHash(parts.map((part) => String(part ?? '∅')).join('\u0000'))}`;
}

export function pathId(parts: Array<string | number>): string {
  return parts.map((part) => String(part).replace(/[^\p{L}\p{N}_.-]+/gu, '_')).join('/');
}
