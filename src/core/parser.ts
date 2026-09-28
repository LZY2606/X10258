import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type {
  Diagnostic, IncludeStatement, InstanceCall, LogicalLine, ModelDefinition, ModelStatement,
  ParamStatement, ParameterSpec, ParsedSide, PhysicalLine, PrimitiveStatement, SourceFile,
  Statement, SubcktDefinition, UnknownStatement, Side
} from './types.js';
import { stableHash, stableId } from './identifiers.js';
import { parseQuantity } from './quantity.js';

const knownPrefixes = new Set(['R','C','L','D','Q','M','V','I','G','E','H','F','J','B','K','S','W','T','O','U','Y','Z']);

function diagnostic(severity: Diagnostic['severity'], code: string, message: string, stableKey: string, sourceId?: string | null, lineId?: string | null, relatedSourceId?: string | null): Diagnostic {
  return { id: stableId('diag', severity, code, stableKey, sourceId, lineId, relatedSourceId), severity, code, message, sourceId: sourceId ?? null, lineId: lineId ?? null, relatedSourceId: relatedSourceId ?? null, stableKey };
}

function tokenize(raw: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; current += char; continue; }
    if (/\s/.test(char)) {
      if (current) tokens.push(current);
      current = '';
    } else current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

export function splitLogicalLines(file: SourceFile): { physical: PhysicalLine[]; logical: LogicalLine[] } {
  const physical: PhysicalLine[] = [];
  const logical: LogicalLine[] = [];
  const rawLines = file.rawText.split(/\r\n|\n|\r/);
  let group: PhysicalLine[] = [];
  const flush = () => {
    if (!group.length) return;
    const physicalLineIds = group.map((line) => line.id);
    const rawText = group.map((line) => line.rawText).join('\n');
    logical.push({
      id: stableId('logline', file.id, group[0]!.lineNumber, rawText),
      sourceId: file.id,
      startLine: group[0]!.lineNumber,
      endLine: group[group.length - 1]!.lineNumber,
      rawText,
      continuationText: group.slice(1).map((line) => line.rawText.trimStart()).join('\n'),
      physicalLineIds
    });
    group = [];
  };
  rawLines.forEach((rawText, zeroIndex) => {
    const lineNumber = zeroIndex + 1;
    const continuation = rawText.trimStart().startsWith('+');
    const line: PhysicalLine = { id: stableId('physline', file.id, lineNumber, rawText), sourceId: file.id, lineNumber, rawText, continuation };
    physical.push(line);
    if (continuation && group.length) group.push(line);
    else {
      flush();
      group = [line];
    }
  });
  flush();
  return { physical, logical };
}

function parseParamToken(token: string, sourceLineId: string): ParameterSpec | null {
  const eq = token.indexOf('=');
  if (eq <= 0) return null;
  const name = token.slice(0, eq);
  const rawValue = token.slice(eq + 1);
  const quoted = (rawValue.startsWith('"') && rawValue.endsWith('"')) || (rawValue.startsWith("'") && rawValue.endsWith("'"));
  const expressionText = quoted ? rawValue.slice(1, -1) : rawValue;
  return { id: stableId('paramspec', sourceLineId, name, token), name, rawValue, expressionText, quoted, sourceLineId };
}

function parseParams(tokens: string[], sourceLineId: string, start: number): { params: ParameterSpec[]; freeTokens: string[] } {
  const params: ParameterSpec[] = [];
  const freeTokens: string[] = [];
  tokens.slice(start).forEach((token) => {
    const spec = parseParamToken(token, sourceLineId);
    if (spec) params.push(spec);
    else freeTokens.push(token);
  });
  return { params, freeTokens };
}

function modelFromTokens(tokens: string[], sourceId: string, line: LogicalLine): ModelDefinition | null {
  if (tokens[0]?.toUpperCase() !== '.MODEL') return null;
  const name = tokens[1];
  const kind = tokens[2]?.toUpperCase();
  if (!name || !kind) return null;
  const rawFields: Record<string, string> = {};
  const normalizedFields: Record<string, ReturnType<typeof parseQuantity>> = {};
  tokens.slice(3).forEach((token) => {
    const spec = parseParamToken(token, line.id);
    if (spec) { rawFields[spec.name.toUpperCase()] = spec.rawValue; normalizedFields[spec.name.toUpperCase()] = parseQuantity(spec.expressionText, line.id, spec.name); }
  });
  return {
    id: stableId('model', sourceId, name, kind, line.id), name, kind, sourceId, sourceLineId: line.id,
    rawFields, normalizedFields, version: rawFields.VERSION ?? rawFields.VERSION_NAME ?? null
  };
}

function stripComment(text: string): string {
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) { if (char === quote) quote = null; continue; }
    if (char === '"' || char === "'") quote = char;
    if (char === ';') return text.slice(0, index);
  }
  return text;
}
