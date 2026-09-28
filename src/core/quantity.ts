import type { Quantity } from './types.js';
import { stableId } from './identifiers.js';

const prefixExponents: Record<string, number> = {
  T: 12,
  G: 9,
  MEG: 6,
  K: 3,
  M: -3,
  U: -6,
  N: -9,
  P: -12,
  F: -15,
};

const suffixAliases: Record<string, { prefix: string; unit: string | null }> = {
  T: { prefix: 'T', unit: null },
  G: { prefix: 'G', unit: null },
  MEG: { prefix: 'MEG', unit: null },
  K: { prefix: 'K', unit: null },
  M: { prefix: 'M', unit: null },
  MIL: { prefix: 'MIL', unit: null },
  U: { prefix: 'U', unit: null },
  N: { prefix: 'N', unit: null },
  P: { prefix: 'P', unit: null },
  F: { prefix: 'F', unit: null }
};

const quantityPattern = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)([A-Za-z]*)$/;

export function parseQuantity(rawInput: string, sourceLineId: string, name = 'value'): Quantity {
  const raw = rawInput.trim();
  const match = raw.match(quantityPattern);
  const base: Quantity = {
    raw,
    normalized: null,
    unit: null,
    scalePrefix: null,
    spiceUnit: null,
    basis: 'raw-only',
    diagnostic: null
  };
  if (!match) {
    return {
      ...base,
      diagnostic: `${name} keeps raw-only value because it is an expression or unsupported literal`
    };
  }

  const numeric = Number(match[1]);
  const suffix = (match[2] ?? '').toUpperCase();
  if (!suffix) {
    return { ...base, normalized: numeric, basis: 'SI', unit: null };
  }
  if (suffix === 'MIL') {
    return {
      ...base,
      normalized: numeric * 25.4e-6,
      unit: 'm',
      scalePrefix: 'MIL',
      basis: 'SI',
      diagnostic: 'SPICE MIL suffix normalized to metres'
    };
  }
  const known = suffixAliases[suffix];
  if (!known) {
    return {
      ...base,
      spiceUnit: suffix,
      diagnostic: `unknown SPICE unit/scale suffix ${suffix}; original representation retained at ${sourceLineId}`
    };
  }
  const exponent = prefixExponents[known.prefix];
  return {
    ...base,
    normalized: numeric * 10 ** (exponent ?? 0),
    scalePrefix: known.prefix,
    spiceUnit: null,
    unit: null,
    basis: 'SI'
  };
}

const identifierPattern = /[A-Za-z_][A-Za-z0-9_.]*/g;
const reserved = new Set(['PI', 'E', 'EXP', 'LOG', 'LN', 'SQRT', 'ABS', 'MIN', 'MAX', 'PWR']);

export function expressionDependencies(expression: string): string[] {
  return [...new Set(expression.match(identifierPattern) ?? [])].filter((name) => !reserved.has(name.toUpperCase())).sort();
}

export function evaluateExpression(
  expression: string,
  values: Record<string, number>,
): { ok: true; value: number } | { ok: false; diagnostic: string } {
  const dependencies = expressionDependencies(expression);
  for (const dependency of dependencies) {
    if (!Number.isFinite(values[dependency])) {
      return { ok: false, diagnostic: `unresolved dependency ${dependency}` };
    }
  }
  const names = Object.keys(values);
  const args = names.map((name) => `__p_${name.replace(/[^A-Za-z0-9_]/g, '_')}`);
  const body = `return (${expression.replace(/\bPI\b/gi, 'Math.PI')});`;
  try {
    const fn = new Function(...args, body);
    const result = fn(...names.map((name) => values[name]));
    if (typeof result !== 'number' || !Number.isFinite(result)) {
      return { ok: false, diagnostic: 'expression did not produce a finite number' };
    }
    return { ok: true, value: result };
  } catch (error) {
    return { ok: false, diagnostic: error instanceof Error ? error.message : 'expression evaluation failed' };
  }
}

export function equivalentQuantity(left: Quantity, right: Quantity): boolean {
  if (left.normalized !== null && right.normalized !== null) {
    return Math.abs(left.normalized - right.normalized) <= Math.max(1e-18, Math.abs(left.normalized) * 1e-12);
  }
  return left.raw === right.raw;
}

export function quantityId(quantity: Quantity): string {
  return stableId('q', quantity.raw, quantity.normalized ?? 'raw', quantity.unit ?? '', quantity.diagnostic ?? '');
}
