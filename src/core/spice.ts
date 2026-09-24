/** SPICE 网表词法与结构解析。原则：原文本、行续接、参数表达式、单位后缀均不改写。 */
import type { DomainEvent } from './events.js';
import { EV } from './events.js';

export interface SourceDoc { id: string; path: string; text: string; }

export interface PhysicalLine {
  id: string;            // line:<sourceId>:<lineNo> —— 稳定身份
  sourceId: string;
  lineNo: number;
  raw: string;           // 原文，逐字节保留
  isContinuation: boolean;
}

export interface LogicalLine {
  id: string;            // ll:<sourceId>:<startLine>
  sourceId: string;
  startLine: number;
  endLine: number;
  raw: string;           // 含续行符的原始拼接
  text: string;          // 续行合并后的文本（仅供解析，展示仍用 raw）
  physical: PhysicalLine[];
}

export function lexSpice(doc: SourceDoc): LogicalLine[] {
  const physicalLines = doc.text.split(/\r?\n/);
  const out: LogicalLine[] = [];
  let cur: LogicalLine | null = null;
  physicalLines.forEach((rawLine, idx) => {
    const lineNo = idx + 1;
    const ph: PhysicalLine = {
      id: `line:${doc.id}:${lineNo}`, sourceId: doc.id, lineNo, raw: rawLine,
      isContinuation: rawLine.startsWith('+'),
    };
    if (ph.isContinuation && cur) {
      cur.physical.push(ph);
      cur.endLine = lineNo;
      cur.raw += '\n' + rawLine;
      cur.text += ' ' + rawLine.slice(1);
    } else {
      cur = {
        id: `ll:${doc.id}:${lineNo}`, sourceId: doc.id, startLine: lineNo, endLine: lineNo,
        raw: rawLine, text: rawLine, physical: [ph],
      };
      out.push(cur);
    }
  });
  return out;
}

/** 空白分词，但 { ... } 表达式保持为一个 token。 */
export function tokenize(text: string): string[] {
  const toks: string[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (/\s|,/.test(c)) { i++; continue; }
    if (c === '{') {
      let depth = 0; let j = i;
      while (j < text.length) { if (text[j] === '{') depth++; if (text[j] === '}') { depth--; if (depth === 0) { j++; break; } } j++; }
      toks.push(text.slice(i, j)); i = j; continue;
    }
    let j = i;
    while (j < text.length && !/[\s,]/.test(text[j]!)) j++;
    toks.push(text.slice(i, j)); i = j;
  }
  return toks;
}

export function splitParams(toks: string[]): { positional: string[]; params: Record<string, string> } {
  const positional: string[] = [];
  const params: Record<string, string> = {};
  for (const t of toks) {
    const eq = t.indexOf('=');
    if (eq > 0) params[t.slice(0, eq).toLowerCase()] = t.slice(eq + 1);
    else positional.push(t);
  }
  return { positional, params };
}

export type Card =
  | { kind: 'comment' | 'blank' | 'control'; line: LogicalLine }
  | { kind: 'element'; line: LogicalLine; name: string; prefix: string; nodes: string[]; modelRef: string | null; valueRaw: string | null; paramsRaw: Record<string, string>; opaque: boolean; restRaw: string }
  | { kind: 'xinstance'; line: LogicalLine; name: string; nodes: string[]; subcktRef: string; paramsRaw: Record<string, string> }
  | { kind: 'subckt'; line: LogicalLine; name: string; ports: string[]; paramsRaw: Record<string, string> }
  | { kind: 'ends'; line: LogicalLine; name: string | null }
  | { kind: 'model'; line: LogicalLine; name: string; modelType: string; version: string | null; paramsRaw: Record<string, string> }
  | { kind: 'include'; line: LogicalLine; path: string }
  | { kind: 'param'; line: LogicalLine; paramsRaw: Record<string, string> }
  | { kind: 'end'; line: LogicalLine };

export const KNOWN_PREFIXES = new Set(['R', 'L', 'C', 'V', 'I', 'M', 'D', 'Q', 'J', 'E', 'G', 'F', 'H', 'B', 'S', 'W', 'K', 'T']);
const FIXED_NODE_MODEL: Record<string, number> = { M: 4, D: 2, Q: 3, J: 2 };

export function parseCard(line: LogicalLine): Card {
  const text = line.text.trim();
  if (text.length === 0) return { kind: 'blank', line };
  if (text.startsWith('*')) return { kind: 'comment', line };
  if (text.startsWith('.')) {
    const toks = tokenize(text);
    const kw = toks[0]!.toLowerCase();
    if (kw === '.subckt') {
      const name = toks[1] ?? '?';
      const { positional, params } = splitParams(toks.slice(2));
      return { kind: 'subckt', line, name, ports: positional, paramsRaw: params };
    }
    if (kw === '.ends') return { kind: 'ends', line, name: toks[1] ?? null };
    if (kw === '.end') return { kind: 'end', line };
    if (kw === '.include' || kw === '.inc') {
      const p = (toks[1] ?? '').replace(/^["']|["']$/g, '');
      return { kind: 'include', line, path: p };
    }
    if (kw === '.param') return { kind: 'param', line, paramsRaw: splitParams(toks.slice(1)).params };
    if (kw === '.model') {
      const name = toks[1] ?? '?';
      const modelType = (toks[2] ?? '?').toLowerCase();
      const { params } = splitParams(toks.slice(3).map(t => t.replace(/^\(|\)$/g, '')));
      const version = params['version'] ?? params['level'] ?? null;
      return { kind: 'model', line, name, modelType, version, paramsRaw: params };
    }
    return { kind: 'control', line };
  }
  const toks = tokenize(text);
  const name = toks[0]!;
  const prefix = name[0]!.toUpperCase();
  if (prefix === 'X') {
    const { positional, params } = splitParams(toks.slice(1));
    const subcktRef = positional[positional.length - 1] ?? '?';
    return { kind: 'xinstance', line, name, nodes: positional.slice(0, -1), subcktRef, paramsRaw: params };
  }
  if (!KNOWN_PREFIXES.has(prefix)) {
    // 未知元件：保留 opaque 连接，不删除。
    return { kind: 'element', line, name, prefix, nodes: toks.slice(1), modelRef: null, valueRaw: null, paramsRaw: {}, opaque: true, restRaw: toks.slice(1).join(' ') };
  }
  const fixed = FIXED_NODE_MODEL[prefix];
  if (fixed !== undefined) {
    const nodes = toks.slice(1, 1 + fixed);
    const modelRef = toks[1 + fixed] ?? null;
    const { params } = splitParams(toks.slice(2 + fixed));
    return { kind: 'element', line, name, prefix, nodes, modelRef, valueRaw: null, paramsRaw: params, opaque: false, restRaw: toks.slice(1).join(' ') };
  }
  const nodes = toks.slice(1, 3);
  const rest = toks.slice(3);
  const { positional, params } = splitParams(rest);
  return { kind: 'element', line, name, prefix, nodes, modelRef: null, valueRaw: positional.join(' ') || null, paramsRaw: params, opaque: false, restRaw: rest.join(' ') };
}

export interface SubcktDef {
  id: string;            // subckt:<sourceId>:<startLine>
  name: string;
  ports: string[];
  paramsRaw: Record<string, string>;
  cards: Card[];         // 体内元素与嵌套 X
  sourceId: string;
  lineRef: string;
}

export interface NetlistDoc {
  sourceId: string;
  logical: LogicalLine[];
  topCards: Card[];      // 顶层卡（含 .param / .model / .include / 元素 / X）
  subckts: SubcktDef[];  // 本文件内定义的子电路（重名各自保留）
}

export function parseNetlist(doc: SourceDoc): NetlistDoc {
  const logical = lexSpice(doc);
  const topCards: Card[] = [];
  const subckts: SubcktDef[] = [];
  let cur: SubcktDef | null = null;
  for (const line of logical) {
    const card = parseCard(line);
    if (card.kind === 'subckt') {
      cur = { id: `subckt:${doc.id}:${line.startLine}`, name: card.name, ports: card.ports, paramsRaw: card.paramsRaw, cards: [], sourceId: doc.id, lineRef: line.id };
      subckts.push(cur);
      continue;
    }
    if (card.kind === 'ends') { cur = null; continue; }
    if (cur) cur.cards.push(card);
    else topCards.push(card);
  }
  return { sourceId: doc.id, logical, topCards, subckts };
}

export interface Assembled {
  docs: NetlistDoc[];
  topCards: Card[];            // include 已按来源展开拼接（保留 include 卡本身与来源链）
  subcktIndex: Map<string, SubcktDef[]>; // name -> 全部候选定义（重名不覆盖）
  models: ModelDef[];
  events: DomainEvent[];
}

export interface ModelDef {
  id: string;                  // model:<sourceId>:<line>
  name: string;
  modelType: string;
  version: string | null;
  paramsRaw: Record<string, string>;
  sourceId: string;
  lineRef: string;
}

/** 按 include 边把多个来源装配为一个网表空间；循环 include 记录事件并剪断。 */
export function assemble(sources: SourceDoc[]): Assembled {
  const byId = new Map(sources.map(s => [s.id, s] as const));
  const byPath = new Map(sources.map(s => [s.path, s] as const));
  const events: DomainEvent[] = [];
  const docs: NetlistDoc[] = [];
  const topCards: Card[] = [];
  const subcktIndex = new Map<string, SubcktDef[]>();
  const models: ModelDef[] = [];
  const visited = new Set<string>();

  function walk(src: SourceDoc, chain: string[]): void {
    if (visited.has(src.id)) return;
    visited.add(src.id);
    const doc = parseNetlist(src);
    docs.push(doc);
    for (const card of doc.topCards) {
      topCards.push(card);
      if (card.kind === 'include') {
        const target = byPath.get(card.path) ?? byId.get(card.path);
        if (!target) {
          events.push({ kind: 'include.missing', summary: `include 未找到: ${card.path}`, detail: { lineRef: card.line.id, path: card.path } });
          continue;
        }
        if (chain.includes(target.id)) {
          // 循环 include：剪断该边，其余继续。
          events.push({
            kind: EV.INCLUDE_CYCLE,
            summary: `循环 include 已剪断: ${[...chain, target.id].join(' -> ')}`,
            detail: { chain: [...chain, target.id], cutAt: card.line.id, action: 'cut-edge-continue' },
          });
          continue;
        }
        walk(target, [...chain, target.id]);
      } else if (card.kind === 'model') {
        models.push({ id: `model:${src.id}:${card.line.startLine}`, name: card.name, modelType: card.modelType, version: card.version, paramsRaw: card.paramsRaw, sourceId: src.id, lineRef: card.line.id });
      }
    }
    for (const def of doc.subckts) {
      const arr = subcktIndex.get(def.name) ?? [];
      arr.push(def);
      subcktIndex.set(def.name, arr);
    }
  }

  const roots = sources.filter(s => s.path.endsWith('.sp') || s.path.endsWith('.cir'));
  for (const r of roots) walk(r, [r.id]);
  for (const s of sources) if (!visited.has(s.id)) walk(s, [s.id]);

  for (const [name, defs] of subcktIndex) {
    if (defs.length > 1) {
      events.push({
        kind: EV.SUBCKT_DUPLICATE,
        summary: `子电路重名 ${name}: ${defs.length} 个定义，采用第一个，其余保留为候选`,
        detail: { name, candidates: defs.map(d => d.id), adopted: defs[0]!.id, rule: 'first-definition-wins; alternates-preserved' },
      });
    }
  }
  return { docs, topCards, subcktIndex, models, events };
}
