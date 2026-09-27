/**
 * 稳定身份（stable identity）。
 *
 * 身份一旦在导入时由“来源坐标”确定，后续重算 / 导出-删除-再导入都保持不变。
 * 身份基于内容无关的来源路径坐标，而不是规范化后的值，从而与“保真不改写”原则一致。
 */

export function sha1Short(text: string): string {
  // FNV-1a 64 位，纯确定性、无依赖；冲突风险在案例规模下可忽略，并带前缀防类别碰撞。
  let h1 = 0xcbf29ce4 >>> 0;
  let h2 = 0x84222325 >>> 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ ((c << 3) | (c >> 5)), 0x01000193) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

export function stableId(kind: string, parts: Array<string | number>): string {
  return `${kind}_${sha1Short(parts.join(''))}`;
}

/** 实例路径身份：沿层次路径用“实例名(子电路名)”累积。 */
export function instancePathId(
  parentPath: string,
  instanceName: string,
  subcktName: string,
): string {
  const seg = `${instanceName.toLowerCase()}@${subcktName.toLowerCase()}`;
  return parentPath === '' ? `I/${seg}` : `${parentPath}/${seg}`;
}

/** 展平节点身份：实例路径 + 该实例端口位绑定到的祖先网络坐标。 */
export function flatNodeId(netKey: string): string {
  return `N/${sha1Short(netKey)}`;
}
