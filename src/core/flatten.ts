/** 层次展平：节点/实例可 alpha-rename；参数作用域、默认值与表达式依赖不可压平。 */
import type { Assembled, Card, ModelDef, SubcktDef } from './spice.js';
import type { DomainEvent } from './events.js';
import { EV } from './events.js';
import { evalParam, type Env } from './expr.js';

export interface ParamProvenance {
  scopeChain: string[];      // 作用域链（不可压平）：如 ['top', 'X1:diffpair']
  definedAt: string;         // 定义来源行 id，或 'default:<subckt>'
  exprRaw: string;           // 原始表达式（不改写）
  dependsOn: string[];       // 表达式依赖的名字
  overriddenBy: string[];    // 覆盖链
}

export interface ParamValue {
  raw: string;
  value: number | null;
  provenance: ParamProvenance;
  diagnostic?: string;
}

export interface FlatDevice {
  id: string;                // dev:<instPath.join('/')>  —— 稳定身份
  origName: string;          // 局部原名（alpha-renamename 只作用于此）
  instPath: string[];
  type: string;
  model: { name: string; modelType: string; version: string | null; sourceId: string } | null;
  nodes: string[];           // 展平后的网 id
  nodeNames: string[];       // 原始节点名（展示用）
  params: Record<string, ParamValue>;
  value: ParamValue | null;
  raw: string;
  sourceRef: string;         // 逻辑行 id
  opaque: boolean;
}

export interface FlatNetlist {
  devices: FlatDevice[];
  nets: string[];
  events: DomainEvent[];
  scopes: ScopeRecord[];
  cacheReport: CacheHit[];
}

export interface CacheHit { key: string; instPath: string; hit: boolean; reason: string; }

export interface InstanceCacheEntry { devices: FlatDevice[]; scopes: ScopeRecord[]; events: DomainEvent[]; }
export type InstanceCache = Map<string, InstanceCacheEntry>;

export interface ScopeRecord {
  scopeId: string;           // scope:<instPath>
  parent: string | null;
  subckt: string | null;
  params: Record<string, ParamValue>;
}

interface Ctx {
  events: DomainEvent[];
  scopes: ScopeRecord[];
  devices: FlatDevice[];
  subcktOf: Map<string, SubcktDef[]>;   // name -> defs（重名候选）
  adoptedDef: Map<string, string>;      // name -> adopted def id（可被裁定改选）
  models: ModelDef[];
  cache: InstanceCache | null;
  cacheReport: CacheHit[];
  defHashMemo: Map<string, string>;
}

export function hashStr(s: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16) + (h1 >>> 0).toString(16);
}

function evalParamsInto(
  rawParams: Record<string, string>,
  env: Env,
  scopeChain: string[],
  definedAt: string,
  ctx: Ctx,
  out: Record<string, ParamValue>,
): Map<string, number> {
  const local = new Map(env);
  for (const [k, rawExpr] of Object.entries(rawParams)) {
    const r = evalParam(rawExpr, local);
    const dependsOn = extractDeps(rawExpr);
    const pv: ParamValue = {
      raw: rawExpr, value: r.value,
      provenance: { scopeChain, definedAt, exprRaw: rawExpr, dependsOn, overriddenBy: [] },
      diagnostic: r.diagnostic,
    };
    if (r.diagnostic) {
      ctx.events.push({
        kind: EV.PARAM_UNCONVERTIBLE,
        summary: `参数无法转换，保留原值: ${k}=${rawExpr} @ ${definedAt}`,
        detail: { param: k, raw: rawExpr, scope: scopeChain, definedAt, diagnostic: r.diagnostic, action: 'kept-in-place' },
      });
    }
    out[k] = pv;
    if (r.value !== null) local.set(k, r.value);
  }
  return local;
}

export function extractDeps(rawExpr: string): string[] {
  const brace = /^\{([\s\S]*)\}$/.exec(rawExpr.trim());
  const src = brace ? brace[1]! : rawExpr;
  const ids = src.match(/[A-Za-z_][A-Za-z0-9_.$]*/g) ?? [];
  return [...new Set(ids.map(s => s.toLowerCase()))].filter(s => !/^\d/.test(s) && !/^[0-9.]/.test(s) && !/^\d+(?:\.\d*)?(?:e[+-]?\d+)?(t|g|meg|k|mil|m|u|n|p|f)?$/i.test(s));
}

export function flatten(
  asm: Assembled,
  opts: { adoptedDef?: Map<string, string>; label?: string; cache?: InstanceCache } = {},
): FlatNetlist {
  const ctx: Ctx = {
    events: [...asm.events], scopes: [], devices: [],
    subcktOf: asm.subcktIndex,
    adoptedDef: opts.adoptedDef ?? new Map([...asm.subcktIndex].map(([n, defs]) => [n, defs[0]!.id])),
    models: asm.models,
    cache: opts.cache ?? null,
    cacheReport: [],
    defHashMemo: new Map(),
  };
  const globalEnv = new Map<string, number>();
  const globalParams: Record<string, ParamValue> = {};
  evalParamsInto(
    Object.assign({}, ...asm.topCards.filter(c => c.kind === 'param').map(c => (c as Extract<Card, { kind: 'param' }>).paramsRaw)),
    globalEnv, ['top'], 'top', ctx, globalParams,
  );
  ctx.scopes.push({ scopeId: 'scope:top', parent: null, subckt: null, params: globalParams });

  const topNodeMap = new Map<string, string>();
  const topMap = (n: string) => {
    const key = n.toLowerCase();
    if (key === '0' || key === 'gnd') return 'net:0';
    let v = topNodeMap.get(key);
    if (!v) { v = `net:${key}`; topNodeMap.set(key, v); }
    return v;
  };

  for (const card of asm.topCards) {
    if (card.kind === 'element') emitDevice(card, [], topMap, globalEnv, ['top'], ctx);
    else if (card.kind === 'xinstance') expandInstance(card, [], topMap, globalEnv, ['top'], ctx);
  }

  const nets = [...new Set(ctx.devices.flatMap(d => d.nodes))].sort();
  return { devices: ctx.devices, nets, events: ctx.events, scopes: ctx.scopes, cacheReport: ctx.cacheReport };
}

/** 子电路定义的内容哈希：含自身文本与传递引用的子定义，任一变化即失效。 */
function defHash(ctx: Ctx, def: SubcktDef): string {
  const memo = ctx.defHashMemo.get(def.id);
  if (memo) return memo;
  const own = def.lineRef + '|' + def.ports.join(',') + '|' + JSON.stringify(def.paramsRaw) + '|' +
    def.cards.map(c => c.line.raw).join('\n');
  const nested: string[] = [];
  for (const c of def.cards) {
    if (c.kind === 'xinstance') {
      const d = resolveDef(ctx, c.subcktRef);
      nested.push(d ? defHash(ctx, d) : `undef:${c.subcktRef}`);
    }
  }
  const h = hashStr(own + '|' + nested.sort().join('|'));
  ctx.defHashMemo.set(def.id, h);
  return h;
}

function resolveDef(ctx: Ctx, name: string): SubcktDef | null {
  const defs = ctx.subcktOf.get(name);
  if (!defs || defs.length === 0) return null;
  const adoptedId = ctx.adoptedDef.get(name);
  return defs.find(d => d.id === adoptedId) ?? defs[0]!;
}

function expandInstance(
  card: Extract<Card, { kind: 'xinstance' }>,
  instPath: string[],
  parentMap: (n: string) => string,
  parentEnv: Env,
  parentChain: string[],
  ctx: Ctx,
): void {
  const path = [...instPath, card.name];
  const scopeId = `scope:${path.join('/')}`;
  const def = resolveDef(ctx, card.subcktRef);
  if (!def) {
    ctx.events.push({
      kind: 'subckt.undefined',
      summary: `未定义的子电路实例 ${card.name}: ${card.subcktRef}，保留为 opaque 实例`,
      detail: { instance: card.name, subcktRef: card.subcktRef, lineRef: card.line.id, action: 'kept-opaque-instance' },
    });
    ctx.devices.push({
      id: `dev:${path.join('/')}`, origName: card.name, instPath: path, type: 'X?' ,
      model: null, nodes: card.nodes.map(parentMap), nodeNames: card.nodes,
      params: {}, value: null, raw: card.line.raw, sourceRef: card.line.id, opaque: true,
    });
    return;
  }
  // 局部作用域：默认参数 + 实例覆盖。默认值与依赖不可压平。
  const chain = [...parentChain, `${card.name}:${def.name}`];
  const localParams: Record<string, ParamValue> = {};
  const envWithDefaults = evalParamsInto(def.paramsRaw, parentEnv, chain, def.lineRef, ctx, localParams);
  const overridden: string[] = [];
  for (const k of Object.keys(card.paramsRaw)) if (k in localParams) overridden.push(k);
  evalParamsInto(card.paramsRaw, envWithDefaults, chain, card.line.id, ctx, localParams);
  for (const k of overridden) {
    localParams[k]!.provenance.overriddenBy.push(card.line.id);
    ctx.events.push({
      kind: EV.PARAM_OVERRIDE,
      summary: `局部参数覆盖: ${k} @ ${path.join('/')}`,
      detail: { param: k, instance: path.join('/'), scopeChain: chain, defaultFrom: def.lineRef, overrideFrom: card.line.id },
    });
  }
  const env = new Map(envWithDefaults);
  for (const [k, pv] of Object.entries(localParams)) if (pv.value !== null) env.set(k, pv.value);

  const portMap = new Map<string, string>();
  def.ports.forEach((p, i) => { portMap.set(p.toLowerCase(), parentMap(card.nodes[i] ?? `${card.name}_dangling_${i}`)); });

  // —— 依赖图缓存键：实例路径 + 定义内容哈希 + 环境值 + 端口映射 ——
  const cacheKey = ctx.cache
    ? hashStr(JSON.stringify({ path, def: defHash(ctx, def), env: [...env.entries()].sort(), ports: [...portMap.entries()].sort() }))
    : null;
  if (ctx.cache && cacheKey) {
    const hit = ctx.cache.get(cacheKey);
    if (hit) {
      ctx.cacheReport.push({ key: cacheKey, instPath: path.join('/'), hit: true, reason: '定义内容、环境值与端口映射均未变，子树结果仍有效' });
      ctx.devices.push(...hit.devices);
      ctx.scopes.push(...hit.scopes);
      ctx.events.push(...hit.events);
      return;
    }
    ctx.cacheReport.push({ key: cacheKey, instPath: path.join('/'), hit: false, reason: '定义/环境/端口之一变化，子树需重算' });
  }
  const mark = { devices: ctx.devices.length, scopes: ctx.scopes.length, events: ctx.events.length };

  ctx.scopes.push({ scopeId, parent: `scope:${instPath.length ? instPath.join('/') : 'top'}`, subckt: def.id, params: localParams });

  const localMap = (n: string) => {
    const key = n.toLowerCase();
    if (key === '0' || key === 'gnd') return 'net:0';
    const mapped = portMap.get(key);
    if (mapped) return mapped;
    return `net:${path.join('/')}/${key}`;   // 局部节点：层次唯一，可 alpha-rename
  };

  for (const c of def.cards) {
    if (c.kind === 'element') emitDevice(c, path, localMap, env, chain, ctx);
    else if (c.kind === 'xinstance') expandInstance(c, path, localMap, env, chain, ctx);
  }

  if (ctx.cache && cacheKey) {
    ctx.cache.set(cacheKey, {
      devices: ctx.devices.slice(mark.devices),
      scopes: ctx.scopes.slice(mark.scopes),
      events: ctx.events.slice(mark.events),
    });
  }
}

function emitDevice(
  card: Extract<Card, { kind: 'element' }>,
  instPath: string[],
  mapNode: (n: string) => string,
  env: Env,
  chain: string[],
  ctx: Ctx,
): void {
  const path = [...instPath, card.name];
  const params: Record<string, ParamValue> = {};
  evalParamsInto(card.paramsRaw, env, chain, card.line.id, ctx, params);
  let value: ParamValue | null = null;
  if (card.valueRaw !== null) {
    const r = evalParam(card.valueRaw, env);
    value = {
      raw: card.valueRaw, value: r.value,
      provenance: { scopeChain: chain, definedAt: card.line.id, exprRaw: card.valueRaw, dependsOn: extractDeps(card.valueRaw), overriddenBy: [] },
      diagnostic: r.diagnostic,
    };
    if (r.diagnostic) {
      ctx.events.push({
        kind: EV.PARAM_UNCONVERTIBLE,
        summary: `器件值无法转换，保留原值: ${card.name}=${card.valueRaw}`,
        detail: { device: path.join('/'), raw: card.valueRaw, diagnostic: r.diagnostic, action: 'kept-in-place' },
      });
    }
  }
  if (card.opaque) {
    ctx.events.push({
      kind: EV.DEVICE_UNKNOWN,
      summary: `未知元件 ${card.name}（前缀 ${card.prefix}）：保留 opaque 连接，不删除`,
      detail: { device: path.join('/'), prefix: card.prefix, nodes: card.nodes, lineRef: card.line.id, action: 'kept-opaque' },
    });
  }
  let model: FlatDevice['model'] = null;
  if (card.modelRef) {
    const m = ctx.models.find(mm => mm.name.toLowerCase() === card.modelRef!.toLowerCase());
    if (m) model = { name: m.name, modelType: m.modelType, version: m.version, sourceId: m.sourceId };
    else ctx.events.push({
      kind: 'model.undefined',
      summary: `器件 ${card.name} 引用了未定义 model: ${card.modelRef}`,
      detail: { device: path.join('/'), modelRef: card.modelRef, lineRef: card.line.id, action: 'kept-without-model' },
    });
  }
  ctx.devices.push({
    id: `dev:${path.join('/')}`, origName: card.name, instPath: path, type: card.prefix,
    model, nodes: card.nodes.map(mapNode), nodeNames: card.nodes,
    params, value, raw: card.line.raw, sourceRef: card.line.id, opaque: card.opaque,
  });
}
