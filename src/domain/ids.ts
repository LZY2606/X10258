import { createHash } from 'node:crypto';

export const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
export const shortHash = (s: string): string => sha256(s).slice(0, 12);

/** 逻辑文件身份：同一文件多次修订共享同一 id（rev 区分版本）。 */
export const fileIdOf = (side: string, path: string): string => `sf_${shortHash(`${side}${path}`)}`;
export const stmtIdOf = (fileId: string, rev: number, logicalIndex: number): string =>
  `st_${fileId.slice(3)}_r${rev}_l${logicalIndex}`;
export const deviceIdOf = (side: string, instPath: string): string =>
  `dv_${side}_${instPath.replaceAll('/', '.') || 'root'}`;
export const flatIdOf = (side: string, material: string): string => `fl_${side}_${shortHash(material)}`;
export const equivIdOf = (leftFlatId: string, rightFlatId: string): string =>
  `eq_${shortHash(`${leftFlatId}|${rightFlatId}`)}`;
export const diffIdOf = (equivId: string, kind: string, material: string): string =>
  `md_${shortHash(`${equivId}|${kind}|${material}`)}`;
export const diagIdOf = (code: string, context: string): string => `dg_${shortHash(`${code}|${context}`)}`;
export const rationaleIdOf = (rule: string, context: string): string => `re_${shortHash(`${rule}|${context}`)}`;
export const candidateIdOf = (equivId: string, index: number, material: string): string =>
  `cm_${shortHash(`${equivId}|${index}|${material}`)}`;
