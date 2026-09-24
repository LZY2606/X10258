// 解析层：逻辑行 -> 原始语句（不改写任何 token）。
// 支持 .SUBCKT/.ENDS、.MODEL、.INCLUDE/.LIB、.PARAM、常见元件与未知元件。
import {
  controlId, deviceId, includeId, modelId, statementId, subcktId
} from './ids.js';
import type {
  DeviceKind, RawDevice, RawInclude, RawModel, RawParam,
  RawStatement, RawSubckt, SourceFile
} from './types.js';
import { tokenize } from './source.js';

const FIRST_LETTER_KIND: Record<string, DeviceKind> = {
  r: 'R', c: 'C', l: 'L', v: 'V', i: 'I', d: 'D', q: 'Q', m: 'M', x: 'X'
};

/** 从 token 序列中解析 name=value 参数（value 支持 {expr} 与独立 token 形式）。 */
export function parseParams(tokens: string[], start: number, lineId: string): {
  params: RawParam[]; valueToken: string | null; consumed: number;
} {
  const params: RawParam[] = [];
  let i = start;
  let valueToken: string | null = null;
  while (i < tokens.length) {
    const tk = tokens[i];
    const eq = tk.indexOf('=');
    if (eq > 0 && !tk.startsWith('=')) {
      const name = tk.slice(0, eq);
      let rest = tk.slice(eq + 1);
      if (rest.startsWith('{')) {
        // {a*b c} 可能跨 token，直到出现 }
        while (!rest.includes('}') && i + 1 < tokens.length) {
          i++;
          rest += ' ' + tokens[i];
        }
        rest = rest.replace(/^\{/, '').replace(/\}$/, '');
      } else if (rest === '' && i + 1 < tokens.length) {
        i++;
        rest = tokens[i].replace(/^\{/, '').replace(/\}$/, '');
      }
      params.push({ raw: tk, name, exprRaw: rest, lineId });
      i++;
      continue;
    }
    // 位置值（如 R1 n1 n2 10k）
    if (valueToken === null && !tk.startsWith('{')) valueToken = tk;
    i++;
  }
  return { params, valueToken, consumed: i - start };
}

export function parseFile(file: SourceFile): {
  statements: RawStatement[];
} {
  const statements: RawStatement[] = [];
  // 仅对非整行注释的逻辑行解析
  const codeLines = file.logicalLines.filter((l) => !l.segments[0].startsWith('*'));
  let subStack: RawSubckt[] = [];

  for (const line of codeLines) {
    const { tokens } = tokenize(line.joined);
    if (tokens.length === 0) continue;
    const head = tokens[0].toLowerCase();
    const physStart = line.physicalStart;

    if (head === '.subckt') {
      const name = tokens[1] ?? '';
      let i = 2;
      const externalNodes: string[] = [];
      let params: RawParam[] = [];
      while (i < tokens.length && !tokens[i].toLowerCase().startsWith('params:')) {
        externalNodes.push(tokens[i]); i++;
      }
      if (i < tokens.length) {
        params = parseParams(tokens.slice(i + 1), 0, line.id).params;
      }
      const sub: RawSubckt = {
        id: subcktId(file.id, physStart, name),
        name, externalNodes, params, body: [], bodyLineIds: [],
        lineStart: line.id, lineEndsId: '', sourceFileId: file.id
      };
      subStack.push(sub);
      statements.push({ type: 'subckt', sub });
      continue;
    }
    if (head === '.ends') {
      const top = subStack.pop();
      if (top) top.lineEndsId = line.id;
      statements.push({ type: 'control', raw: line.joined, lineId: line.id, id: controlId(file.id, physStart) });
      continue;
    }
    if (head === '.model') {
      const name = tokens[1] ?? '';
      const modelType = (tokens[2] ?? '').replace(/[()]/g, '');
      const { params } = parseParams(tokens, 3, line.id);
      const model: RawModel = {
        id: modelId(file.id, physStart, name), name, modelType, params,
        lineId: line.id, sourceFileId: file.id
      };
      statements.push({ type: 'model', model });
      continue;
    }
    if (head === '.include' || head === '.inc' || head === '.lib') {
      let target = tokens[1] ?? '';
      let libSection: string | null = null;
      target = target.replace(/^["'<]/, '').replace(/["'>]$/, '');
      if (head === '.lib' && tokens.length >= 3 && !tokens[1].includes('=')) {
        libSection = tokens[2];
      }
      const inc: RawInclude = {
        id: includeId(file.id, physStart, target),
        targetPath: target, resolvedPath: null, libSection,
        lineId: line.id, sourceFileId: file.id
      };
      statements.push({ type: 'include', inc });
      continue;
    }
    if (head === '.param' || head === '.parameters') {
      statements.push({ type: 'control', raw: line.joined, lineId: line.id, id: controlId(file.id, physStart) });
      continue;
    }
    if (head.startsWith('.')) {
      statements.push({ type: 'control', raw: line.joined, lineId: line.id, id: controlId(file.id, physStart) });
      continue;
    }

    const dev = parseDevice(tokens, file, line.id, physStart);
    const currentSub = subStack[subStack.length - 1];
    if (currentSub) {
      currentSub.body.push(dev);
      currentSub.bodyLineIds.push(line.id);
    }
    statements.push({ type: 'device', dev });
  }

  return { statements };
}

function parseDevice(tokens: string[], file: SourceFile, lineId: string, physStart: number): RawDevice {
  const instanceName = tokens[0];
  const kind = FIRST_LETTER_KIND[instanceName[0].toLowerCase()] ?? 'unknown';
  let nodeTokens: string[] = [];
  let modelRef: string | null = null;
  let params: RawParam[] = [];
  let rawValueToken: string | null = null;

  const countBeforeParams = (n: number) => {
    const slice = tokens.slice(1, 1 + n);
    return slice;
  };

  if (kind === 'X') {
    // 节点直到首个含 '=' 或遇到子电路名（子电路名 = 第一个非节点 token）
    let i = 1;
    while (i < tokens.length && !tokens[i].includes('=')) i++;
    const nodeEnd = i;
    nodeTokens = tokens.slice(1, nodeEnd - 1);
    modelRef = tokens[nodeEnd - 1] ?? null;
    params = parseParams(tokens, nodeEnd, lineId).params;
  } else if (kind === 'M' || kind === 'Q') {
    const n = kind === 'M' ? 4 : 3;
    nodeTokens = countBeforeParams(n);
    modelRef = tokens[1 + n] ?? null;
    params = parseParams(tokens, 2 + n, lineId).params;
  } else if (kind === 'D') {
    nodeTokens = countBeforeParams(2);
    modelRef = tokens[3] ?? null;
    params = parseParams(tokens, 4, lineId).params;
  } else if (kind === 'R' || kind === 'C' || kind === 'L' || kind === 'V' || kind === 'I') {
    nodeTokens = countBeforeParams(2);
    const rest = parseParams(tokens, 3, lineId);
    rawValueToken = rest.valueToken;
    params = rest.params;
  } else {
    // 未知元件：不猜测拓扑，但尽可能保守提取节点（所有不含 = 且不是首 token 的 token 视作连接）
    let i = 1;
    while (i < tokens.length && !tokens[i].includes('=')) { nodeTokens.push(tokens[i]); i++; }
    params = parseParams(tokens, i, lineId).params;
  }

  const dev: RawDevice = {
    id: deviceId(file.id, physStart, instanceName),
    instanceName, kind, tokens, nodeTokens, modelRef, params,
    rawValueToken, lineId
  };
  return dev;
}

/** 跨文件建立子电路/模型注册表（保留重名定义；active 默认取“最后加载”，歧义另记）。 */
export interface SymbolRegistry {
  subckts: Map<string, RawSubckt[]>;
  models: Map<string, RawModel[]>;
}

export function buildRegistry(stmts: RawStatement[]): SymbolRegistry {
  const subckts = new Map<string, RawSubckt[]>();
  const models = new Map<string, RawModel[]>();
  for (const s of stmts) {
    if (s.type === 'subckt') {
      const key = s.sub.name.toUpperCase();
      const list = subckts.get(key) ?? [];
      list.push(s.sub); subckts.set(key, list);
    } else if (s.type === 'model') {
      const key = `${s.model.name.toUpperCase()}|${s.model.modelType.toUpperCase()}`;
      const list = models.get(key) ?? [];
      list.push(s.model); models.set(key, list);
    }
  }
  return { subckts, models };
}
