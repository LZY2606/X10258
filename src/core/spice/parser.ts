import { contentId } from '../ids';
import { parseSpiceNumber } from './units';
import type {
  Diagnostic, Element, ElementKind, IncludeEdge, ModelCard, NetlistDoc,
  ParamAssign, ParamValue, Provenance, SubcktDef
} from './types';

export interface SourceFile { path: string; content: string; }

const KNOWN_LETTERS = new Set(['R','C','L','K','V','I','D','Q','M','J','B','E','F','G','H','S','W','X']);

interface LogicalLine { text: string; prov: Provenance; }

/** 行续接：以 '+' 开头的行并入上一逻辑行；原文（含续接行）原样保留。 */
export function joinContinuations(path: string, content: string): LogicalLine[] {
  const rawLines = content.split(/\r?\n/);
  const out: LogicalLine[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];
    const trimmed = raw.trim();
    if (trimmed.startsWith('+') && out.length > 0) {
      const prev = out[out.length - 1];
      prev.text += ' ' + trimmed.slice(1).trim();
      prev.prov.raw += '\n' + raw;
      prev.prov.endLine = i + 1;
    } else {
      out.push({ text: trimmed, prov: { file: path, line: i + 1, endLine: i + 1, raw } });
    }
  }
  return out;
}

/** 参数值：保留原始 token；表达式提取依赖；数字记录单位后缀。 */
export function parseParamValue(raw: string): ParamValue {
  const t = raw.trim();
  if (t.startsWith('{') && t.endsWith('}')) {
    const inner = t.slice(1, -1);
    const deps = [...inner.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)]
      .map(m => m[0])
      .filter(w => !/^(exp|log|sqrt|abs|sin|cos|tan|pow|min|max)$/i.test(w));
    return { raw: t, kind: 'expr', dependsOn: [...new Set(deps)] };
  }
  const num = parseSpiceNumber(t);
  if (num) {
    return { raw: t, kind: 'number', normalized: num.value, unit: num.suffix || undefined, dependsOn: [] };
  }
  if (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(t)) {
    return { raw: t, kind: 'identifier', dependsOn: [t] };
  }
  return { raw: t, kind: 'string', dependsOn: [], diagnostic: `无法规范化的值，保留原样: ${t}` };
}

function splitTokens(text: string): string[] {
  // 保护 { ... } 表达式不被空格切开
  const tokens: string[] = [];
  let cur = '';
  let depth = 0;
  for (const ch of text) {
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    if (/\s/.test(ch) && depth === 0) {
      if (cur) { tokens.push(cur); cur = ''; }
    } else cur += ch;
  }
  if (cur) tokens.push(cur);
  return tokens;
}

function parseParams(tokens: string[], prov: Provenance): { params: ParamAssign[]; rest: string[] } {
  const params: ParamAssign[] = [];
  const rest: string[] = [];
  for (const tok of tokens) {
    const eq = tok.indexOf('=');
    if (eq > 0) {
      const name = tok.slice(0, eq);
      const rawVal = tok.slice(eq + 1);
      params.push({ name, value: parseParamValue(rawVal), prov });
    } else rest.push(tok);
  }
  return { params, rest };
}

function parseElement(line: LogicalLine, sourceFile: string): Element | null {
  const tokens = splitTokens(line.text);
  if (tokens.length === 0) return null;
  const name = tokens[0];
  const letter = name[0].toUpperCase();
  const known = KNOWN_LETTERS.has(letter);
  const kind: ElementKind = known ? (letter as ElementKind) : 'UNKNOWN';
  const body = tokens.slice(1);
  const { params, rest } = parseParams(body, line.prov);

  let nodes: string[] = [];
  let subcktName: string | undefined;
  let modelName: string | undefined;
  let value: ParamValue | undefined;

  if (kind === 'X') {
    // Xname n1 n2 ... subname p=v ...
    if (rest.length >= 1) {
      subcktName = rest[rest.length - 1];
      nodes = rest.slice(0, -1);
    }
  } else if (kind === 'M') {
    // Mname d g s b model [params]
    if (rest.length >= 5) { nodes = rest.slice(0, 4); modelName = rest[4]; }
    else { nodes = rest.slice(0, -1); modelName = rest[rest.length - 1]; }
  } else if (kind === 'Q' || kind === 'D' || kind === 'J') {
    if (rest.length >= 2) { nodes = rest.slice(0, -1); modelName = rest[rest.length - 1]; }
    else nodes = rest;
  } else if (known) {
    if (rest.length >= 3) {
      nodes = rest.slice(0, 2);
      value = parseParamValue(rest[2]);
    } else nodes = rest;
  } else {
    // 未知元件：保留 opaque 连接（全部 token 原样挂接），不删除
    nodes = rest;
  }

  return {
    id: contentId('el', sourceFile, String(line.prov.line), line.text),
    name, kind, letter: name[0], nodes, subcktName, modelName, params, value,
    prov: line.prov,
    opaque: kind === 'UNKNOWN'
  };
}

export interface ParseResult { doc: NetlistDoc; }

/** 解析一组文件为 NetlistDoc。include 图保留来源；循环 include 只诊断、不改写。 */
export function parseNetlist(title: string, files: SourceFile[]): ParseResult {
  const byPath = new Map(files.map(f => [f.path, f.content]));
  const diagnostics: Diagnostic[] = [];
  const includes: IncludeEdge[] = [];
  const globals: ParamAssign[] = [];
  const models: ModelCard[] = [];
  const subckts: SubcktDef[] = [];
  const topElements: Element[] = [];
  const usedFiles: string[] = [];

  const fileHash = contentId('doc', ...files.map(f => f.path + ':' + f.content));

  const visit = (path: string, stack: string[]) => {
    const content = byPath.get(path);
    if (content === undefined) {
      diagnostics.push({
        id: contentId('diag', 'missing', path),
        severity: 'error', code: 'INCLUDE_MISSING',
        message: `include 来源缺失: ${path}`, related: []
      });
      return;
    }
    if (stack.includes(path)) {
      diagnostics.push({
        id: contentId('diag', 'cycle', stack.join('>') + '>' + path),
        severity: 'warn', code: 'INCLUDE_CYCLE',
        message: `循环 include: ${[...stack, path].join(' -> ')}（保留来源，不再展开）`,
        related: []
      });
      return;
    }
    if (usedFiles.includes(path)) return;
    usedFiles.push(path);

    let cur: SubcktDef | null = null;
    for (const line of joinContinuations(path, content)) {
      const t = line.text;
      if (!t || t.startsWith('*')) continue;
      const lower = t.toLowerCase();
      if (lower.startsWith('.include') || lower.startsWith('.inc')) {
        const m = /["']?([^"'\s]+)["']?/.exec(t.slice(t.indexOf(' ')).trim());
        const target = m ? m[1] : '';
        includes.push({ from: path, to: target, prov: line.prov });
        visit(target, [...stack, path]);
        continue;
      }
      if (lower.startsWith('.subckt')) {
        const tokens = splitTokens(t);
        const name = tokens[1] ?? '';
        const { params, rest } = parseParams(tokens.slice(2), line.prov);
        cur = {
          id: contentId('sub', path, String(line.prov.line), name),
          name, ports: rest, defaults: params, elements: [], models: [], params: [],
          prov: line.prov, sourceFile: path
        };
        subckts.push(cur);
        continue;
      }
      if (lower.startsWith('.ends')) { cur = null; continue; }
      if (lower.startsWith('.model')) {
        const tokens = splitTokens(t);
        const name = tokens[1] ?? '';
        const type = tokens[2] ?? '';
        const { params } = parseParams(tokens.slice(3), line.prov);
        const card: ModelCard = {
          id: contentId('mdl', path, String(line.prov.line), name),
          name, type, versionTag: fileHash.slice(0, 12), params, prov: line.prov
        };
        (cur ? cur.models : models).push(card);
        continue;
      }
      if (lower.startsWith('.param')) {
        const { params } = parseParams(splitTokens(t).slice(1), line.prov);
        (cur ? cur.params : globals).push(...params);
        continue;
      }
      if (lower.startsWith('.')) continue; // 其它控制卡不影响连接语义
      const el = parseElement(line, path);
      if (el) (cur ? cur.elements : topElements).push(el);
    }
  };

  const roots = files.filter(f => !files.some(g => g.path !== f.path && g.content.includes(f.path)));
  for (const r of roots.length ? roots : files.slice(0, 1)) visit(r.path, []);

  // 子电路重名：全部保留，诊断记录候选集合（不吞掉多解）
  const byName = new Map<string, SubcktDef[]>();
  for (const s of subckts) {
    const list = byName.get(s.name) ?? [];
    list.push(s);
    byName.set(s.name, list);
  }
  for (const [name, list] of byName) {
    if (list.length > 1) {
      diagnostics.push({
        id: contentId('diag', 'subckt-collision', name, list.map(s => s.id).join(',')),
        severity: 'warn', code: 'SUBCKT_NAME_COLLISION',
        message: `子电路重名 "${name}"：${list.map(s => s.sourceFile).join(' 与 ')}，候选全部保留`,
        related: list.map(s => s.id)
      });
    }
  }
  for (const el of [...topElements, ...subckts.flatMap(s => s.elements)]) {
    if (el.opaque) {
      diagnostics.push({
        id: contentId('diag', 'opaque', el.id),
        severity: 'info', code: 'UNKNOWN_ELEMENT',
        message: `未知元件 ${el.name}（首字母 ${el.letter}）：保留 opaque 连接而不删除`,
        prov: el.prov, related: [el.id]
      });
    }
  }

  return {
    doc: {
      id: fileHash, title, files: usedFiles, includes, globals, models, subckts,
      topElements, diagnostics
    }
  };
}
