import { tokenize } from './lexer';
import { stableId } from './ids';
import type {
  Diagnostic,
  ElementCard,
  ModelDef,
  NetlistUnit,
  ParsedCard,
  RawLine,
  Side,
  SubcktDef,
  Token,
} from './types';

/** 各元件族的最小节点数与典型节点数；X 单独处理 */
const ELEMENT_NODE_ARITY: Record<string, { min: number; typical: number }> = {
  R: { min: 2, typical: 2 },
  C: { min: 2, typical: 2 },
  L: { min: 2, typical: 2 },
  D: { min: 2, typical: 2 },
  J: { min: 3, typical: 3 },
  Q: { min: 3, typical: 4 },
  M: { min: 4, typical: 5 },
  V: { min: 2, typical: 2 },
  I: { min: 2, typical: 2 },
  G: { min: 4, typical: 4 },
  E: { min: 4, typical: 4 },
  F: { min: 2, typical: 2 },
  H: { min: 2, typical: 2 },
  K: { min: 2, typical: 2 },
  S: { min: 4, typical: 4 },
  W: { min: 4, typical: 4 },
  T: { min: 4, typical: 4 },
  O: { min: 4, typical: 4 },
  U: { min: 1, typical: 4 },
  Y: { min: 3, typical: 3 },
  Z: { min: 3, typical: 3 },
};

const KNOWN_PREFIXES = new Set(Object.keys(ELEMENT_NODE_ARITY).concat(['X']));

function diag(
  list: Diagnostic[],
  severity: Diagnostic['severity'],
  code: string,
  message: string,
  sourceId: string,
  lineId: string | null,
  subjectId: string | null,
): ID {
  const id = stableId('diag', code, message, sourceId, lineId ?? '', subjectId ?? '');
  list.push({ id, severity, code, message, sourceId, lineId, subjectId });
  return id;
}

type ID = string;

function classify(line: RawLine): ParsedCard['kind'] {
  const t = line.joined.trim();
  if (t === '') return 'comment';
  if (line.rawSegments[0].startsWith('*')) return 'comment';
  const up = t.toUpperCase();
  if (up.startsWith('.SUBCKT')) return 'subckt';
  if (up.startsWith('.ENDS')) return 'ends';
  if (up.startsWith('.MODEL')) return 'model';
  if (up.startsWith('.PARAM')) return 'param';
  if (up.startsWith('.INC')) return 'include';
  if (up.startsWith('.LIB')) return 'include';
  if (up.startsWith('.')) return 'control';
  return 'element';
}

/** 解析元件行：节点按族规则切，剩余 token 分 name=value / 位置参数 */
export function parseElement(cardId: string, tokens: Token[]): { element: ElementCard; diagnostic: string | null } {
  const nameTok = tokens[0];
  const name = nameTok.text;
  const prefix = name[0]?.toUpperCase() ?? '';
  const opaque = !KNOWN_PREFIXES.has(prefix);

  let nodeCount = 0;
  let refName: string | null = null;
  if (prefix === 'X') {
    // Xname n1 n2 ... <subname> <params...>
    // 子电路名取“最后一段非 name=value、非节点的 token”中节点序列后的第一个非参数 token。
    // 规则：节点从 token[1] 开始连续读取，直到遇到一个不是节点的 token（没有 = 且不像节点无法区分）。
    // SPICE X 行：X<name> <nodes>* <subname> [<param>=<val>]*，节点数由被引用 subckt 决定，
    // 因此词法层无法确定节点边界——约定：子电路名 = 最后一个不含 '=' 的 token，
    // 其之前的全部非 '=' token 都是节点。
    let lastPlain = -1;
    for (let i = tokens.length - 1; i >= 1; i--) {
      if (tokens[i].text !== '=' && !isParamPairAt(tokens, i)) {
        lastPlain = i;
        break;
      }
    }
    nodeCount = lastPlain >= 1 ? lastPlain - 1 : 0;
    refName = lastPlain >= 1 ? tokens[lastPlain].text : null;
  } else {
    const arity = ELEMENT_NODE_ARITY[prefix] ?? { min: 1, typical: 2 };
    // 多端子（Q/M）：尽可能吃到典型节点数；不足则按最小值，剩余进 positional
    nodeCount = Math.min(arity.typical, Math.max(arity.min, tokens.length - 1));
    // 非 X 元件 refName：D/Q/M/J 节点后的 model 名（第一个非参数 token）
    if (['D', 'Q', 'M', 'J'].includes(prefix)) {
      let idx = 1 + nodeCount;
      while (idx < tokens.length && isParamPairAt(tokens, idx)) idx++;
      if (idx < tokens.length && tokens[idx].text !== '=') {
        refName = tokens[idx].text;
      }
    }
  }

  const nodeTokens = tokens.slice(1, 1 + nodeCount);
  const rest = tokens.slice(1 + nodeCount);
  const paramTokens: { name: Token; value: Token }[] = [];
  const positional: Token[] = [];
  let diagnostic: string | null = null;

  if (prefix === 'X') {
    // 去掉子电路名本身
    let skipped = false;
    for (let i = 0; i < rest.length; i++) {
      if (!skipped && rest[i].text === refName) { skipped = true; continue; }
      if (isParamPairAt(rest, i)) {
        paramTokens.push({ name: rest[i], value: rest[i + 2] });
        i += 2;
      } else {
        positional.push(rest[i]);
      }
    }
  } else {
    let skippedRef = false;
    for (let i = 0; i < rest.length; i++) {
      if (refName && !skippedRef && rest[i].text === refName) { skippedRef = true; continue; }
      if (isParamPairAt(rest, i)) {
        paramTokens.push({ name: rest[i], value: rest[i + 2] });
        i += 2;
      } else {
        positional.push(rest[i]);
      }
    }
    if (['R', 'C', 'L', 'V', 'I'].includes(prefix) && positional.length > 1) {
      // R n1 n2 VALUE 后多余位置 token：保留并诊断
      diagnostic = `extra-positional-tokens: ${positional.slice(1).map((t) => t.text).join(' ')}`;
    }
  }

  if (opaque) {
    diagnostic = diagnostic
      ? `${diagnostic}; unknown-element-prefix:${prefix}`
      : `unknown-element-prefix:${prefix}`;
  }

  return {
    element: {
      cardId,
      name,
      typePrefix: prefix,
      nodeTokens,
      refName,
      paramTokens,
      positional,
      opaque,
    },
    diagnostic,
  };
}

function isParamPairAt(tokens: Token[], i: number): boolean {
  return (
    i + 2 < tokens.length &&
    tokens[i + 1].text === '=' &&
    /[A-Za-z_]/.test(tokens[i].text[0] ?? '')
  );
}

export interface ParseUnitInput {
  side: Side;
  sources: NetlistUnit['sources'];
  lines: RawLine[];
}

/** 将已加载（include 已解析）的源集合解析成卡/元件/子电路/model */
export function parseUnit(input: ParseUnitInput): Omit<NetlistUnit, 'includes'> {
  const { side, sources, lines } = input;
  const cards: ParsedCard[] = [];
  const elements: Record<string, ElementCard> = {};
  const subckts: Record<string, SubcktDef[]> = {};
  const models: Record<string, ModelDef[]> = {};
  const diagnostics: Diagnostic[] = [];

  // 子电路体内卡归属：栈
  const stack: { def: SubcktDef; nameKey: string }[] = [];
  let order = 0;

  for (const line of lines) {
    const kind = classify(line);
    if (kind === 'comment') continue;
    const cardId = stableId('card', line.id, line.joined);
    const { tokens } = tokenize(line.joined);
    const card: ParsedCard = {
      id: cardId,
      sourceId: line.sourceId,
      lineId: line.id,
      kind,
      tokens,
      order: order++,
      diagnostic: null,
    };

    if (kind === 'subckt') {
      if (stack.length > 0) {
        card.diagnostic = 'nested-subckt-not-supported';
        diag(diagnostics, 'error', 'NESTED_SUBCKT', '嵌套 .SUBCKT 不被支持，按平铺定义保留', line.sourceId, line.id, cardId);
      }
      const name = tokens[1]?.text ?? '';
      const rest = tokens.slice(2);
      const ports: string[] = [];
      const formalDefaults: { name: string; raw: string }[] = [];
      for (let i = 0; i < rest.length; i++) {
        if (isParamPairAt(rest, i)) {
          formalDefaults.push({ name: rest[i].text, raw: rest[i + 2].text });
          i += 2;
        } else {
          // 排除 params: 关键字
          if (rest[i].text.toUpperCase() === 'PARAMS' && rest[i + 1]?.text === ':') { i++; continue; }
          if (rest[i].text === ':') continue;
          ports.push(rest[i].text);
        }
      }
      const identity = stableId('subdef', name, line.sourceId, line.id);
      const def: SubcktDef = { cardId, name, ports, formalDefaults, bodyCardIds: [], identity };
      stack.push({ def, nameKey: name });
      cards.push(card);
      (subckts[name] ??= []).push(def);
      continue;
    }

    if (kind === 'ends') {
      const top = stack.pop();
      if (!top) {
        card.diagnostic = 'ends-without-subckt';
        diag(diagnostics, 'warning', 'ENDS_WITHOUT_SUBCKT', '.ENDS 没有匹配的 .SUBCKT', line.sourceId, line.id, cardId);
      } else {
        const named = tokens[1]?.text;
        if (named && named !== top.name) {
          card.diagnostic = `ends-name-mismatch:${named}`;
          diag(diagnostics, 'warning', 'ENDS_MISMATCH', `.ENDS ${named} 与 .SUBCKT ${top.name} 不一致`, line.sourceId, line.id, cardId);
        }
      }
      cards.push(card);
      continue;
    }

    if (kind === 'model') {
      // .MODEL name type (param=val ...) 或 type param=val
      const name = tokens[1]?.text ?? '';
      const type = tokens[2]?.text ?? '';
      const params: { name: string; raw: string }[] = [];
      for (let i = 3; i < tokens.length; i++) {
        if (tokens[i].text === '(' || tokens[i].text === ')') continue;
        if (isParamPairAt(tokens, i)) {
          params.push({ name: tokens[i].text, raw: tokens[i + 2].text });
          i += 2;
        }
      }
      const existing = models[name] ?? [];
      const def: ModelDef = {
        cardId,
        name,
        type,
        params,
        version: existing.length + 1,
        identity: stableId('modeldef', name, type, line.sourceId, line.id),
      };
      existing.push(def);
      models[name] = existing;
      cards.push(card);
      continue;
    }

    if (kind === 'param') {
      // .PARAM name=value ...（可能多个）
      cards.push(card);
      if (stack.length > 0) stack[stack.length - 1].def.bodyCardIds.push(cardId);
      continue;
    }

    if (kind === 'element') {
      const { element, diagnostic } = parseElement(cardId, tokens);
      if (diagnostic) {
        card.diagnostic = diagnostic;
        if (element.opaque) {
          diag(diagnostics, 'warning', 'UNKNOWN_ELEMENT', `未知元件 ${element.name} 保留为 opaque，不删除`, line.sourceId, line.id, cardId);
        }
      }
      elements[cardId] = element;
      cards.push(card);
      if (stack.length > 0) stack[stack.length - 1].def.bodyCardIds.push(cardId);
      continue;
    }

    // include/control
    cards.push(card);
  }

  if (stack.length > 0) {
    for (const s of stack) {
      diag(diagnostics, 'error', 'SUBCKT_UNCLOSED', `.SUBCKT ${s.def.name} 缺少 .ENDS`, '', null, s.def.identity);
    }
  }

  return { side, sources, lines, cards, elements, subckts, models, diagnostics };
}
