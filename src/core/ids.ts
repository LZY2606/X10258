// 稳定身份：身份由“来源坐标”（文件路径 + 物理行号 + 序号 + 原文名）决定，
// 与数据库自增主键无关。导出/删除/重新导入后身份保持。
import { createHash } from 'node:crypto';

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function posixPath(p: string): string {
  return p.split('\\').join('/');
}

export const fileId = (bundle: string, relPath: string) =>
  `src:${bundle}:${posixPath(relPath)}`;

export const logicalLineId = (fileId: string, start: number) =>
  `${fileId}#L${start + 1}`;

export const statementId = (fileId: string, logicalIndex: number, kind: string) =>
  `${fileId}#S${logicalIndex}:${kind}`;

export const subcktId = (fileId: string, lineStart: number, name: string) =>
  `${fileId}#SUBCKT@${lineStart + 1}:${name}`;

export const modelId = (fileId: string, lineStart: number, name: string) =>
  `${fileId}#MODEL@${lineStart + 1}:${name.toUpperCase()}`;

export const includeId = (fileId: string, lineStart: number, target: string) =>
  `${fileId}#INC@${lineStart + 1}:${target}`;

export const deviceId = (fileId: string, lineStart: number, instance: string) =>
  `${fileId}#DEV@${lineStart + 1}:${instance}`;

export const controlId = (fileId: string, lineStart: number) =>
  `${fileId}#CTL@${lineStart + 1}`;

/** 展平后的层次实例 uid：路径各段保留原始实例名。 */
export const flatUid = (parentPath: string, instance: string) =>
  parentPath === '' ? instance : `${parentPath}/${instance}`;

/** 展平节点 uid：顶层节点为 net::<root>；层次内部节点带实例路径。 */
export const nodeUid = (instancePath: string, token: string) =>
  instancePath === '' ? `net::${token}` : `net::${instancePath}::${token}`;

/** 派生版本内容寻址。 */
export function derivationHash(payload: unknown): string {
  return 'sha256:' + sha256(JSON.stringify(payload));
}

/** 决策/事件 id：同分支同序号确定，便于重放复现。 */
export const eventId = (projectId: string, seq: number) =>
  `evt:${projectId}:${seq.toString().padStart(5, '0')}`;
