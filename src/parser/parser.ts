/**
 * 语法层：逻辑行 -> 结构化条目。
 * 原始文本/令牌不改写；任何无法确定的信息以诊断附着，绝不丢弃。
 */
import type {
  Diagnostic, InstanceNodeRef, Origin, ParamAssign, ParsedInclude,
  ParsedInstance, ParsedNetItem, ParsedSubckt, SourceFile,
} from '../shared/types.js';
import { makeOrigin, parseAssignToken, stripWrappingParens } from './lexer.js';

// 基元器件“端子数”。K（电感耦合）端子经由电感实例，整体按 opaque 保留。
export const PRIMITIVE_ARITY: Record<string, number> = {
  R: 2, C: 2, L: 2, D: 2,
  Q: 3, M: 4, J: 3, Z: 3,
  B: 2, G: 2, E: 2, F: 2, H: 2,
  V: 2, I: 2,
  S: 4, W: 2,
  K: 0, O: 0, U: 0, T: 2, P: 2,
};

export function parseFile(file: SourceFile): SourceFile {
  const diags: Diagnostic[] = file.diagnostics;
  const items: ParsedNetItem[] = [];
  const lines = file.logicalLines;
  let i = 0;

  while (i < lines.length) {
    const ll = lines[i];
    const toks = ll.tokens;
    if (toks.length === 0) { i++; continue; }
    const head = toks[0];
    const origin = makeOrigin(file.fileId, ll, head);

    switch (head.toLowerCase()) {
      case '.subckt': {
        const res = parseSubckt(file, lines, i, diags);
        items.push(res.sub);
        i = res.nextLine;
        continue;
      }
      case '.ends':
        items.push({ kind: 'ends', nameRaw: toks[1] ?? null, origin });
        i++; continue;
      case '.model':
        items.push(parseModel(toks, origin, diags));
        i++; continue;
      case '.include':
      case '.inc':
      case '.lib':
        items.push(parseInclude(toks, head, origin));
        i++; continue;
      case '.param':
        items.push(parseParam(toks, origin, '', diags));
        i++; continue;
      case '.global':
        items.push({ kind: 'global', nodes: toks.slice(1), origin });
        i++; continue;
      default:
        if (head.startsWith('.')) {
          items.push({ kind: 'control', directive: head, tokens: toks.slice(1), origin });
          i++; continue;
        }
        items.push(parseInstance(toks, head, origin, diags));
        i++;
    }
  }

  file.items = items;
  file.diagnostics = diags;
  return file;
}

function trailingParams(tokens: string[], origin: Origin): { params: ParamAssign[]; cut: number } {
  const params: ParamAssign[] = [];
  let cut = tokens.length;
  for (let j = tokens.length - 1; j >= 0; j--) {
    const a = parseAssignToken(tokens[j], origin);
    if (a) { params.unshift(a); cut = j; continue; }
    break;
  }
  return { params, cut };
}

function parseInstance(
  toks: string[],
  head: string,
  origin: Origin,
  diags: Diagnostic[],
): ParsedInstance {
  const family = head[0].toUpperCase();
  const isX = family === 'X';
  const rest = toks.slice(1);
  const { params, cut } = trailingParams(rest, origin);
  const headToks = rest.slice(0, cut);

  let nodes: InstanceNodeRef[] = [];
  let bodyTokens: string[] = [];
  let modelRefRaw: string | null = null;

  if (isX) {
    if (headToks.length >= 1) {
      const subName = headToks[headToks.length - 1];
      bodyTokens = [subName];
      modelRefRaw = subName;
      nodes = headToks.slice(0, -1).map((n) => ({ raw: n, global: isGlobalNode(n) }));
    } else {
      diags.push(diag('INSTANCE_NO_SUBCKT', 'error', `X 实例 ${head} 缺少子电路名`, origin, head));
      bodyTokens = headToks;
    }
  } else {
    const arity = PRIMITIVE_ARITY[family];
    if (arity && arity > 0 && headToks.length >= arity + 1) {
      nodes = headToks.slice(0, arity).map((n) => ({ raw: n, global: isGlobalNode(n) }));
      bodyTokens = headToks.slice(arity);
      if (bodyTokens.length > 0 && 'DQMJZS'.includes(family)) modelRefRaw = bodyTokens[0];
    } else if (arity === 0) {
      // 耦合/传输线/数字器件：端子无法从行内位置切出，整体 opaque 保留全部令牌。
      bodyTokens = headToks;
      diags.push(diag('OPAQUE_PRIMITIVE', 'warning',
        `器件族 ${family} 端子不可定位，按不透明基元保留（不删除令牌）`, origin, head));
    } else {
      // 未知首字母：无法可靠切分。保守启发式——数字/含 '=' 之前令牌视为候选节点，
      // 但标记未决；真正的“未知元件”用例由缺失定义的 X 实例承载（连接完整、内部 opaque）。
      const splitAt = headToks.findIndex((t) => /^[+-]?[0-9.]/.test(t) || t.includes('='));
      const ncut = splitAt < 0 ? headToks.length : splitAt;
      nodes = headToks.slice(0, ncut).map((n) => ({ raw: n, global: isGlobalNode(n) }));
      bodyTokens = headToks.slice(ncut);
      diags.push(diag('UNKNOWN_FAMILY', 'warning',
        `未知元件族 ${family}：端子数无法唯一确定，连接保留为 opaque，令牌不删除`, origin, head));
    }
  }

  return {
    kind: 'instance',
    nameRaw: head,
    family: isX ? 'X' : family,
    nodes,
    bodyTokens,
    modelRefRaw,
    params,
    origin,
    lexicalScope: '',
  };
}

export function isGlobalNodeName(n: string): boolean {
  return n === '0' || n.toLowerCase() === 'gnd!';
}

function parseModel(toks: string[], origin: Origin, diags: Diagnostic[]): ParsedNetItem {
  const nameRaw = toks[1] ?? '';
  const typeRaw = (toks[2] ?? '').replace(/^\(|\)$/g, '');
  const params: ParamAssign[] = [];
  for (const t of toks.slice(3)) {
    const pieces = stripWrappingParens([t]);
    for (const clean of pieces) {
      const a = parseAssignToken(clean, origin);
      if (a) params.push(a);
      else if (clean !== '') {
        diags.push(diag('MODEL_TOKEN_UNPARSED', 'warning', `model 令牌未能解析为赋值: ${clean}`, origin, clean));
      }
    }
  }
  if (!nameRaw) diags.push(diag('MODEL_NO_NAME', 'error', '.model 缺少名称', origin));
  return {
    kind: 'model', nameRaw, nameKey: nameRaw.toLowerCase(), typeRaw, params, origin,
    versionKey: '',
  };
}

function parseInclude(toks: string[], directive: string, origin: Origin): ParsedInclude {
  let pathRaw = toks[1] ?? '';
  if ((pathRaw.startsWith('"') && pathRaw.endsWith('"')) || (pathRaw.startsWith("'") && pathRaw.endsWith("'"))) {
    pathRaw = pathRaw.slice(1, -1);
  }
  return {
    kind: 'include', directive, pathRaw, extraTokens: toks.slice(2), origin, resolvedFileId: null,
  };
}

function parseParam(toks: string[], origin: Origin, scope: string, diags: Diagnostic[]): ParsedNetItem {
  const assigns: ParamAssign[] = [];
  for (const raw of toks.slice(1)) {
    if (raw.toLowerCase() === 'params:' || raw.toLowerCase() === 'parameters:') continue;
    const a = parseAssignToken(raw, origin);
    if (a) assigns.push(a);
    else diags.push(diag('PARAM_NOT_ASSIGN', 'warning', `.param 令牌非赋值形式: ${raw}`, origin, raw));
  }
  return { kind: 'param', assigns, origin, lexicalScope: scope };
}

interface SubcktParseResult { sub: ParsedSubckt; nextLine: number; }

function parseSubckt(
  file: SourceFile,
  lines: SourceFile['logicalLines'],
  start: number,
  diags: Diagnostic[],
): SubcktParseResult {
  const headLine = lines[start];
  const toks = headLine.tokens;
  const origin = makeOrigin(file.fileId, headLine, toks[0]);
  const rest = toks.slice(1);
  const nameRaw = rest[0] ?? '';
  const ports: string[] = [];
  const params: ParamAssign[] = [];
  let paramsStyle: ParsedSubckt['paramsStyle'] = 'none';
  let inParams = false;

  for (let j = 1; j < rest.length; j++) {
    const t = rest[j];
    const lower = t.toLowerCase();
    if (lower === 'params:' || lower === 'parameters:') {
      inParams = true; paramsStyle = 'params:'; continue;
    }
    if (lower === 'optparams:' || lower === 'optional:') {
      inParams = true; paramsStyle = 'optparams:'; continue;
    }
    const assign = parseAssignToken(t, origin);
    if (assign) {
      params.push(assign);
      inParams = true;
      if (paramsStyle === 'none') paramsStyle = 'inline';
    } else if (!inParams) {
      ports.push(t);
    }
  }

  const body: ParsedNetItem[] = [];
  let i = start + 1;
  for (; i < lines.length; i++) {
    const ll = lines[i];
    const bt = ll.tokens;
    if (bt.length === 0) continue;
    const h = bt[0];
    const o = makeOrigin(file.fileId, ll, h);
    if (h.toLowerCase() === '.ends') {
      return {
        sub: {
          kind: 'subckt', nameRaw, nameKey: nameRaw.toLowerCase(), ports, params,
          paramsStyle, body, origin, endsOrigin: o,
        },
        nextLine: i + 1,
      };
    }
    if (h.toLowerCase() === '.subckt') {
      diags.push(diag('NESTED_SUBCKT', 'error', '不支持嵌套 .subckt 定义（展平要求平铺定义）', o, h));
      continue;
    }
    if (h.toLowerCase() === '.param') { body.push(parseParam(bt, o, nameRaw.toLowerCase(), diags)); continue; }
    if (h.toLowerCase() === '.global') { body.push({ kind: 'global', nodes: bt.slice(1), origin: o }); continue; }
    if (h.startsWith('.')) { body.push({ kind: 'control', directive: h, tokens: bt.slice(1), origin: o }); continue; }
    const inst = parseInstance(bt, h, o, diags);
    inst.lexicalScope = nameRaw.toLowerCase();
    body.push(inst);
  }

  diags.push(diag('SUBCKT_UNCLOSED', 'error', `.subckt ${nameRaw} 缺少 .ends`, origin, nameRaw));
  return {
    sub: {
      kind: 'subckt', nameRaw, nameKey: nameRaw.toLowerCase(), ports, params,
      paramsStyle, body, origin, endsOrigin: null,
    },
    nextLine: i,
  };
}

export function diag(
  code: string,
  severity: Diagnostic['severity'],
  message: string,
  origin: Origin | null,
  offendingRaw?: string,
): Diagnostic {
  return { code, severity, message, origin, offendingRaw };
}

export function parseSpine(file: SourceFile): SourceFile {
  return parseFile(file);
}
