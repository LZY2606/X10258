// SPICE 原始层解析器：
//  - 原文本、行尾、行续接（+ 开头）不改写
//  - 第一列 '*' 为整行注释，'$' 为行内注释（字符串外）
//  - .subckt/.ends/.model/.param/.include/.lib/.global 被识别
//  - 无法识别的元件保留为 unknown（opaque），绝不删除
import { fnv1a64, shortId } from './hash.js';
import type {
  Diagnostic, ElementKind, FileSource, ParsedFile,
  RawControl, RawElement, RawModel, RawParamDefault, RawSubckt, TextSpan,
} from '../shared/types.js';

export function splitPhysicalLines(rawText: string): string[] {
  // 保留行尾表示：按 \n 切，\r 留在行内（导入时不改写）
  return rawText.split('\n');
}

// 逻辑行 = 物理行 + 其后续所有第一列为 '+' 的续行。注释行不参与续接。
export function joinContinuations(physical: string[]): { ids: number[]; text: string }[] {
  const out: { ids: number[]; text: string }[] = [];
  for (let i = 0; i < physical.length; i++) {
    const line = physical[i]!;
    if (isComment(line)) {
      out.push({ ids: [i], text: line });
      continue;
    }
    const ids = [i];
    const parts = [stripInlineComment(line)];
    let j = i + 1;
    while (j < physical.length && /^\s*\+/.test(physical[j]!)) {
      ids.push(j);
      parts.push(stripInlineComment(physical[j]!).replace(/^\s*\+/, ''));
      j++;
    }
    out.push({ ids, text: parts.join(' ') });
    i = j - 1;
  }
  return out;
}

function isComment(line: string): boolean {
  return line.startsWith('*') || line.trim() === '';
}

function stripInlineComment(line: string): string {
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === '"') inQuote = !inQuote;
    if (c === '$' && !inQuote && (i === 0 || /\s/.test(line[i - 1]!))) return line.slice(0, i);
  }
  return line;
}

function spanFor(source: FileSource, physical: string[], ids: number[], text: string): TextSpan {
  const first = ids[0]!;
  const last = ids[ids.length - 1]!;
  return {
    fileId: source.fileId,
    line: first + 1,
    startCol: 1,
    endLine: last + 1,
    endCol: (physical[last]?.length ?? 0) + 1,
    raw: text,
    lines: ids.map((i) => physical[i]!),
  };
}

export function classifyElement(name: string): ElementKind {
  const c = name[0]?.toUpperCase();
  switch (c) {
    case 'R': return 'R';
    case 'C': return 'C';
    case 'L': return 'L';
    case 'V': return 'V';
    case 'I': return 'I';
    case 'D': return 'D';
    case 'Q': return 'Q';
    case 'M': return 'M';
    case 'X': return 'X';
    default: return 'unknown';
  }
}

function splitParams(tokens: string[]): { positional: string[]; paramTokens: string[] } {
  const positional: string[] = [];
  const paramTokens: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (/^PARAM:/i.test(t) || /^PARAM$/i.test(t)) {
      paramTokens.push(...tokens.slice(i + 1).filter((x) => /^[^=\s]+=/.test(x)));
      break;
    }
    if (/^[^=\s]+=/.test(t)) {
      paramTokens.push(...tokens.slice(i).filter((x) => /^[^=\s]+=/.test(x)));
      break;
    }
    positional.push(t);
  }
  return { positional, paramTokens };
}

const KNOWN_TERMINALS: Record<string, number> = {
  R: 2, C: 2, L: 2, V: 2, I: 2, D: 2, Q: 3, M: 4,
};

function heuristicUnknown(tokens: string[]): {
  nodeTokens: string[]; modelToken?: string; valueToken?: string; heuristic: boolean; signature: string;
} {
  // unknown 元件：节点名通常不以数字值开头。启发式抽取连接，同时记录 heuristic=true。
  const nodeTokens: string[] = [];
  let i = 0;
  while (i < tokens.length && !/^[+\-]?(\d|\.)/.test(tokens[i]!) && !/^[^=\s]+=/.test(tokens[i]!)) {
    nodeTokens.push(tokens[i]!);
    i++;
  }
  const rest = tokens.slice(i);
  const valueToken = rest.find((t) => /^[+\-]?(\d|\.)/.test(t));
  const modelToken = rest.find((t) => /^[A-Za-z_]/.test(t) && !/^[^=\s]+=/.test(t));
  const sig = [nodeTokens.length, ...tokens.map((t) => (/^[+\-]?(\d|\.)/.test(t) ? '#num' : t.toLowerCase()))].join('|');
  return { nodeTokens, modelToken, valueToken, heuristic: true, signature: sig };
}

export function parseFile(source: FileSource): ParsedFile {
  const physicalLines = splitPhysicalLines(source.rawText);
  const logical = joinContinuations(physicalLines);
  const elements: RawElement[] = [];
  const models: RawModel[] = [];
  const subckts: RawSubckt[] = [];
  const controls: RawControl[] = [];
  const diagnostics: Diagnostic[] = [];

  let openSub: RawSubckt | null = null;
  let openSpan: TextSpan | null = null;

  for (const ll of logical) {
    const text = ll.text.trim();
    const span = spanFor(source, physicalLines, ll.ids, ll.text);
    if (text === '' || ll.text.startsWith('*')) continue;

    const upper = text.toUpperCase();
    if (openSub && (upper === '.ENDS' || upper.startsWith('.ENDS '))) {
      openSub.endSpan = span;
      openSub = null;
      openSpan = null;
      continue;
    }

    if (openSub) {
      if (upper.startsWith('.SUBCKT')) {
        diagnostics.push({
          code: 'NESTED_SUBCKT',
          severity: 'error',
          message: '嵌套 .subckt 不允许（另见循环 include 场景）',
          span,
        });
        continue;
      }
      // 子电路体内：元件 / .param / .model
      if (upper.startsWith('.PARAM')) {
        for (const p of parseParamLine(text, span)) openSub.params.push(p);
        controls.push({ id: shortId('ctl', source.fileId + span.line + 'p'), kind: 'param', text, tokens: [], span });
        continue;
      }
      if (upper.startsWith('.MODEL')) {
        const m = parseModel(text, span, source);
        models.push(m);
        controls.push({ id: shortId('ctl', source.fileId + span.line + 'm'), kind: 'model', text, tokens: [m.name, m.type], span });
        continue;
      }
      if (text.startsWith('.')) {
        controls.push({ id: shortId('ctl', source.fileId + span.line), kind: 'other', text, tokens: [], span });
        continue;
      }
      const el = parseElement(text, span, source);
      if (el) {
        elements.push(el);
        openSub.bodyElementIds.push(el.id);
      }
      continue;
    }

    if (upper.startsWith('.SUBCKT')) {
      const sub = parseSubckt(text, span, source);
      subckts.push(sub);
      openSub = sub;
      openSpan = span;
      continue;
    }
    if (upper.startsWith('.MODEL')) {
      const m = parseModel(text, span, source);
      models.push(m);
      controls.push({ id: shortId('ctl', source.fileId + span.line + 'm'), kind: 'model', text, tokens: [m.name, m.type], span });
      continue;
    }
    if (upper.startsWith('.PARAM')) {
      const span2 = span;
      controls.push({ id: shortId('ctl', source.fileId + span.line + 'p'), kind: 'param', text, tokens: parseParamTokens(text), span: span2 });
      continue;
    }
    if (upper.startsWith('.INC')) {
      const path = extractPath(text);
      controls.push({ id: shortId('ctl', source.fileId + span.line + 'i'), kind: 'include', text, tokens: [path, 'include'], span });
      continue;
    }
    if (upper.startsWith('.LIB')) {
      const toks = tokenizeLine(text).slice(1);
      const path = toks.find((t) => !/^[A-Za-z0-9_]+$/.test(t) || /[.\/]/.test(t)) ?? toks[0] ?? '';
      controls.push({ id: shortId('ctl', source.fileId + span.line + 'l'), kind: 'include', text, tokens: [stripQuotes(path), 'library'], span });
      continue;
    }
    if (text.startsWith('.')) {
      controls.push({ id: shortId('ctl', source.fileId + span.line), kind: 'other', text, tokens: tokenizeLine(text), span });
      continue;
    }
    const el = parseElement(text, span, source);
    if (el) elements.push(el);
  }

  if (openSub) {
    diagnostics.push({
      code: 'UNTERMINATED_SUBCKT',
      severity: 'error',
      message: `.subckt ${openSub.name} 缺少 .ends`,
      span: openSpan ?? undefined,
    });
  }

  return { source, physicalLines, logicalLines: logical, elements, models, subckts, controls, diagnostics };
}

export function tokenizeLine(text: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[1] !== undefined ? `"${m[1]}"` : m[2]!);
  return out;
}

function stripQuotes(s: string): string {
  return s.replace(/^"|"$/g, '');
}

function extractPath(text: string): string {
  const toks = tokenizeLine(text);
  const t = toks.find((x) => /[./\\]/.test(x)) ?? toks[1] ?? '';
  return stripQuotes(t);
}

function parseParamTokens(text: string): string[] {
  const body = text.replace(/^\.\s*PARAM\s*/i, '').replace(/^\.\s*SUBCKT[^\n]*/i, '');
  return tokenizeLine(body).filter((t) => /^[^=\s]+=/.test(t));
}

function parseParamLine(text: string, span: TextSpan): RawParamDefault[] {
  return parseParamTokens(text).map((tok) => {
    const eq = tok.indexOf('=');
    const keyRaw = tok.slice(0, eq);
    return { key: keyRaw.toUpperCase(), keyRaw, valueRaw: tok.slice(eq + 1), span };
  });
}

function parseSubckt(text: string, span: TextSpan, source: FileSource): RawSubckt {
  const toks = tokenizeLine(text);
  const nameIdx = 1;
  const nameRaw = toks[nameIdx] ?? '';
  let i = nameIdx + 1;
  const ports: string[] = [];
  const params: RawParamDefault[] = [];
  for (; i < toks.length; i++) {
    const t = toks[i]!;
    if (/^PARAM:/i.test(t) || /^PARAM$/i.test(t)) continue;
    if (/^[^=\s]+=/.test(t)) {
      const eq = t.indexOf('=');
      const keyRaw = t.slice(0, eq);
      params.push({ key: keyRaw.toUpperCase(), keyRaw, valueRaw: t.slice(eq + 1), span });
    } else {
      ports.push(t);
    }
  }
  return {
    id: shortId('sub', source.fileId + ':' + span.line + ':' + nameRaw),
    name: nameRaw.toUpperCase(),
    nameRaw,
    ports,
    bodyElementIds: [],
    params,
    span,
  };
}

function parseModel(text: string, span: TextSpan, source: FileSource): RawModel {
  const toks = tokenizeLine(text);
  const nameRaw = toks[1] ?? '';
  const type = stripParens(toks[2] ?? '').toUpperCase();
  const paramTokens = toks.slice(3).map((t) => t.replace(/^\(|\)$/g, ''));
  return {
    id: shortId('mdl', source.fileId + ':' + span.line + ':' + nameRaw),
    name: nameRaw.toUpperCase(),
    type,
    paramTokens,
    span,
  };
}

function stripParens(s: string): string {
  return s.replace(/^\(|\)$/g, '');
}

function parseElement(text: string, span: TextSpan, source: FileSource): RawElement | null {
  const toks = tokenizeLine(text);
  const name = toks[0];
  if (!name || name.startsWith('+')) return null;
  const kind = classifyElement(name);
  const rest = toks.slice(1);
  const { positional, paramTokens } = splitParams(rest);
  const id = shortId('el', source.fileId + ':' + span.line + ':' + name);

  if (kind === 'X') {
    // Xname n1 n2 ... subname [param=...]
    const subName = positional[positional.length - 1];
    const nodeTokens = positional.slice(0, -1);
    if (!subName || nodeTokens.length === 0) {
      return {
        id, name, kind, tokens: rest, nodeTokens: [], rawParamTokens: paramTokens,
        span, heuristic: false,
      };
    }
    return {
      id, name, kind, tokens: rest, nodeTokens, modelToken: subName,
      rawParamTokens: paramTokens, span, heuristic: false,
    };
  }

  if (kind === 'unknown') {
    const h = heuristicUnknown(rest);
    return {
      id, name, kind, tokens: rest,
      nodeTokens: h.nodeTokens, modelToken: h.modelToken, valueToken: h.valueToken,
      rawParamTokens: paramTokens, span, opaqueSignature: h.signature, heuristic: true,
    };
  }

  const termCount = KNOWN_TERMINALS[kind] ?? 2;
  const nodeTokens = positional.slice(0, termCount);
  const after = positional.slice(termCount);
  let modelToken: string | undefined;
  let valueToken: string | undefined;
  if (kind === 'R' || kind === 'C' || kind === 'L' || kind === 'V' || kind === 'I') {
    valueToken = after[0];
  } else {
    modelToken = after[0];
  }
  if (kind === 'V' || kind === 'I') {
    // V/I 源可带模型或表达式，原样保留 token
    valueToken = after[0];
  }
  void fnv1a64;
  return {
    id, name, kind, tokens: rest, nodeTokens, modelToken, valueToken,
    rawParamTokens: paramTokens, span, heuristic: false,
  };
}
