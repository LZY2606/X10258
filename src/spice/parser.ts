import type {
  Diagnostic, LogicalLine, ModelDef, Origin, ParamDef, ParsedFile,
  SourceFile, Token,
} from '../shared/types';
import { fileIdFor, logicalLines, splitPhysicalLines, tokenizeLogical } from './lexer';
import { stableId } from './ident';
import { DEVICE_TABLE, deviceMeta } from './devices';

function originShift(base: Origin, tok: Token): Origin {
  return { ...base, start: tok.start, end: tok.end };
}

/** 合并 A '=' B 形式的 token 对，返回 name=value 片段序列 */
function collectParams(tokens: Token[], base: Origin): { pairs: ParamLinePair[]; loose: Token[] } {
  const pairs: ParamLinePair[] = [];
  const loose: Token[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (i + 2 < tokens.length && tokens[i + 1].text === '=') {
      const name = tokens[i]; const value = tokens[i + 2];
      pairs.push({ rawName: name.text, rawValue: value.text, start: name.start });
      i += 2;
      continue;
    }
    if (tokens[i].text.includes('=')) {
      const idx = tokens[i].text.indexOf('=');
      pairs.push({ rawName: tokens[i].text.slice(0, idx), rawValue: tokens[i].text.slice(idx + 1), start: tokens[i].start });
      continue;
    }
    loose.push(tokens[i]);
  }
  void base;
  return { pairs, loose };
}

interface ParamLinePair { rawName: string; rawValue: string; start: { line: number; column: number } }

function paramDefsFrom(tokens: Token[], base: Origin): ParamDef[] {
  const defs: ParamDef[] = [];
  for (let i = 0; i < tokens.length; i++) {
    let nameTok: Token | undefined;
    let rawValue: string | undefined;
    if (i + 2 < tokens.length && tokens[i + 1].text === '=') {
      nameTok = tokens[i]; rawValue = tokens[i + 2].text; i += 2;
    } else if (tokens[i].text.includes('=')) {
      const idx = tokens[i].text.indexOf('=');
      nameTok = { ...tokens[i], text: tokens[i].text.slice(0, idx) };
      rawValue = tokens[i].text.slice(idx + 1);
    }
    if (nameTok && rawValue !== undefined) {
      defs.push({
        name: nameTok.text.toUpperCase(),
        rawName: nameTok.text,
        defaultExpr: { raw: rawValue, origin: originShift(base, nameTok) },
        origin: originShift(base, nameTok),
      });
    }
  }
  return defs;
}

export interface ParseResult extends ParsedFile {}

export function parseFile(file: SourceFile): ParseResult {
  const fileId = file.fileId || fileIdFor(file.path);
  const withId: SourceFile = { ...file, fileId };
  const lines = splitPhysicalLines(withId);
  const { raws } = logicalLines(withId, lines, []);
  const diagnostics: Diagnostic[] = [];
  const directives: LogicalLine[] = [];

  // 每个逻辑行的 token（列基于 joined 文本，行号取首物理行）
  const rows = raws.map((r) => ({ r, tokens: tokenizeLogical(r.joined, r.start.start.line) }));

  // 第一遍：子电路签名（名字 -> 端口数与定义）
  const subcktSignatures = new Map<string, { ports: string[]; def?: LogicalLine }>();
  const subDepth: string[] = [];
  for (const { r, tokens } of rows) {
    const head = tokens[0]?.text.toLowerCase();
    if (head === '.subckt' && tokens.length >= 2) {
      const nameTok = tokens[1];
      const rest = tokens.slice(2);
      const ports: string[] = [];
      for (const t of rest) {
        if (t.text === '=' || (rest.indexOf(t) > 0 && rest[rest.indexOf(t) - 1]?.text === '=')) continue;
        if (/^[A-Za-z_]/.test(t.text) && t.text.toUpperCase() === 'PARAMS') break;
        if (t.text.includes('=')) break;
        ports.push(t.text);
      }
      subcktSignatures.set(nameTok.text.toUpperCase(), { ports });
      subDepth.push(nameTok.text.toUpperCase());
    } else if (head === '.ends') {
      subDepth.pop();
    }
  }

  // 第二遍：构造指令
  const openSubckts: { def: Extract<LogicalLine, { kind: 'subckt' }>; depth: number }[] = [];
  let depth = 0;
  for (const { r, tokens } of rows) {
    const base = r.start;
    const head0 = tokens[0]?.text ?? '';
    const head = head0.toLowerCase();

    if (head === '.subckt' && tokens.length >= 2) {
      const nameTok = tokens[1];
      const rest = tokens.slice(2);
      const ports: string[] = [];
      let i = 0;
      for (; i < rest.length; i++) {
        const t = rest[i];
        if (t.text.toUpperCase() === 'PARAMS') { i++; break; }
        if (t.text.includes('=') || t.text === '=') break;
        ports.push(t.text);
      }
      const paramTokens: Token[] = [];
      for (; i < rest.length; i++) paramTokens.push(rest[i]);
      const def: Extract<LogicalLine, { kind: 'subckt' }> = {
        id: stableId('sub', withId.fileId, nameTok.text, ports.join(','), r.physicalIds.join('|')),
        kind: 'subckt',
        name: nameTok.text.toUpperCase(),
        rawName: nameTok.text,
        ports: ports.map((p) => p.toUpperCase()),
        params: paramDefsFrom(paramTokens, base),
        body: [],
        origin: originShift(base, nameTok),
      };
      directives.push(def);
      openSubckts.push({ def, depth: depth++ });
      continue;
    }
    if (head === '.ends') {
      const open = openSubckts.pop();
      depth--;
      directives.push({ kind: 'ends', name: tokens[1]?.text.toUpperCase(), origin: base });
      if (open) open.def.endOrigin = base;
      else diagnostics.push({ code: 'SPICE_ENDS_WITHOUT_SUBCKT', message: '.ends without matching .subckt', severity: 'warning', origin: base });
      continue;
    }

    const line: LogicalLine | undefined = (() => {
      if (head === '.model' && tokens.length >= 3) {
        const nameTok = tokens[1]; const typeTok = tokens[2];
        const { pairs } = collectParams(tokens.slice(3), base);
        const model: ModelDef = {
          id: stableId('model', withId.fileId, nameTok.text, typeTok.text, pairs.map((p) => `${p.rawName}=${p.rawValue}`).join(',')),
          kind: 'model',
          name: nameTok.text.toUpperCase(),
          rawName: nameTok.text,
          type: typeTok.text.replace(/[()]/g, ''),
          versionKey: stableId('mver', withId.fileId, r.physicalIds.join('|'), pairs.map((p) => `${p.rawName}=${p.rawValue}`).join(',')),
          params: pairs.map((p) => ({ rawName: p.rawName, rawValue: p.rawValue })),
          origin: originShift(base, nameTok),
        };
        return model;
      }
      if (head === '.include' || head === '.inc') {
        return { kind: 'include', target: stripQuotes(tokens[1]?.text ?? ''), origin: base } as LogicalLine;
      }
      if (head === '.lib') {
        const target = stripQuotes(tokens[1]?.text ?? '');
        const section = tokens[2] ? stripQuotes(tokens[2].text) : undefined;
        return { kind: 'lib', target, section, origin: base } as LogicalLine;
      }
      if (head === '.param') {
        return { kind: 'param', params: paramDefsFrom(tokens.slice(1), base), origin: base } as LogicalLine;
      }
      if (head === '.global' || head === '.globals') {
        return { kind: 'globals', tokens: tokens.slice(1), origin: base } as LogicalLine;
      }
      if (head.startsWith('.') ) {
        return { kind: 'control', tokens, origin: base } as LogicalLine;
      }
      // 实例
      if (/^[A-Za-z]/.test(head0) && head0.length > 0) {
        return parseInstance(withId.fileId, tokens, base, subcktSignatures, diagnostics, r.physicalIds);
      }
      return { kind: 'unknown', tokens, origin: base } as LogicalLine;
    })();

    if (line) {
      if (openSubckts.length) openSubckts[openSubckts.length - 1].def.body.push(line);
      directives.push(line);
    }
  }

  if (openSubckts.length) {
    for (const o of openSubckts) diagnostics.push({ code: 'SPICE_UNCLOSED_SUBCKT', message: `unclosed .subckt ${o.def.rawName}`, severity: 'warning', origin: o.def.origin });
  }

  return { file: withId, lines, directives, diagnostics };
}

function stripQuotes(s: string): string {
  return s.replace(/^["']|["']$/g, '');
}

function parseInstance(
  fileId: string,
  tokens: Token[],
  base: Origin,
  subSignatures: Map<string, { ports: string[] }>,
  diagnostics: Diagnostic[],
  physicalIds: string[],
): LogicalLine {
  const nameTok = tokens[0];
  const letter = nameTok.text[0].toUpperCase();
  const rest = tokens.slice(1);

  if (letter === 'X') {
    // 子电路实例：先找子名（其前端口数 = 被引用 subckt 的端口数）。
    // 允许在缺签名时回退：最后一个非 '=' 相关 token 视为子名。
    let subIndex = -1;
    for (let i = 0; i < rest.length; i++) {
      const t = rest[i];
      if (t.text === '=' || t.text.includes('=')) break;
      const sig = subSignatures.get(t.text.toUpperCase());
      if (sig) {
        // 候选：端口数需等于 i
        if (sig.ports.length === i) { subIndex = i; break; }
      }
    }
    let subName: string | undefined;
    let nodeTokens: Token[] = [];
    let after: Token[] = [];
    if (subIndex >= 0) {
      subName = rest[subIndex].text;
      nodeTokens = rest.slice(0, subIndex);
      after = rest.slice(subIndex + 1);
    } else {
      // 回退：子名是第一个"其后出现 name=value"的 token；否则取最后一个裸 token。
      let cut = -1;
      for (let i = 0; i < rest.length; i++) {
        if (i + 2 < rest.length && rest[i + 1].text === '=') { cut = i - 1; break; }
      }
      if (cut < 0) cut = rest.length - 1;
      nodeTokens = rest.slice(0, Math.max(0, cut));
      subName = rest[cut]?.text;
      after = rest.slice(cut + 1);
      diagnostics.push({ code: 'SPICE_X_UNRESOLVED_SUBNAME', message: `X instance ${nameTok.text}: subckt signature not found, inferred subname ${subName ?? '?'}`, severity: 'warning', origin: base });
    }
    const { pairs } = collectParams(after, base);
    return {
      kind: 'instance',
      id: stableId('inst', fileId, nameTok.text, physicalIds.join('|')),
      letter,
      name: nameTok.text.toUpperCase(),
      rawName: nameTok.text,
      nodes: nodeTokens.map((t) => t.text.toUpperCase()),
      subName,
      positional: nodeTokens.map((t) => t.text),
      params: pairs.map((p) => ({ rawName: p.rawName, rawValue: p.rawValue, start: p.start })),
      rest: after,
      opaque: false,
      origin: originShift(base, nameTok),
    };
  }

  const meta = deviceMeta(letter);
  const known = DEVICE_TABLE[letter] !== undefined;
  if (!known) {
    // 未知元件：opaque。保留所有引脚（按位置）与全部 token，不删除。
    const { pairs, loose } = collectParams(rest, base);
    const pinTokens = loose.slice();
    diagnostics.push({ code: 'SPICE_UNKNOWN_ELEMENT', message: `unknown element letter '${letter}' in ${nameTok.text}; kept opaque`, severity: 'warning', origin: base });
    return {
      kind: 'instance',
      id: stableId('inst', fileId, nameTok.text, physicalIds.join('|')),
      letter,
      name: nameTok.text.toUpperCase(),
      rawName: nameTok.text,
      nodes: pinTokens.map((t) => t.text.toUpperCase()),
      positional: pinTokens.map((t) => t.text),
      params: pairs.map((p) => ({ rawName: p.rawName, rawValue: p.rawValue, start: p.start })),
      rest,
      opaque: true,
      origin: originShift(base, nameTok),
    };
  }

  const nodeTokens = rest.slice(0, meta.arity);
  const after = rest.slice(meta.arity);
  const { pairs, loose } = collectParams(after, base);
  // loose[0] 通常是 model 名（D/Q/M/J），其余为无法成对解释的 token
  if (loose.length > 1) diagnostics.push({ code: 'SPICE_LOOSE_TOKENS', message: `${nameTok.text}: ${loose.length - 1} unparsed token(s) retained`, severity: 'info', origin: base });
  return {
    kind: 'instance',
    id: stableId('inst', fileId, nameTok.text, physicalIds.join('|')),
    letter,
    name: nameTok.text.toUpperCase(),
    rawName: nameTok.text,
    nodes: nodeTokens.map((t) => t.text.toUpperCase()),
    positional: nodeTokens.map((t) => t.text),
    params: pairs.map((p) => ({ rawName: p.rawName, rawValue: p.rawValue, start: p.start })),
    rest: loose,
    opaque: false,
    origin: originShift(base, nameTok),
  };
}
