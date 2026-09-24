import {
  Diagnostic,
  FlatDevice,
  FlatNetlist,
  HierarchyNode,
  IncludeEdge,
  ModelVersion,
  ParamFrame,
  SourceFile,
  Statement,
  SubcktDef
} from "../shared/types.ts";
import { evalAst, makeParamExpr } from "./expr.ts";
import { parseKeyValueTokens } from "./parser.ts";
import { cid, groupBy, upperName } from "./util.ts";

interface FlatInput {
  side: "A" | "B";
  rootFileId: string;
  files: SourceFile[];
  statements: Statement[];
  subckts: SubcktDef[];
  models: ModelVersion[];
  topParams: { name: string; rawName: string; expr: ReturnType<typeof makeParamExpr>; statementId: string }[];
  edges: IncludeEdge[];
  diagnostics: Diagnostic[];
}

const KNOWN_LETTERS = new Set([
  "R", "C", "L", "D", "Q", "M", "J", "V", "I", "E", "G", "H", "F", "S", "W", "T", "K", "B", "O", "P", "N", "Z", "Y", "A", "U"
]);

/** 每个字母代表的引脚数（用于在缺省时保留连接顺序；不猜测多余引脚）。 */
const PIN_COUNTS: Record<string, number | ((toks: string[]) => number)> = {
  R: 2, C: 2, L: 2, D: 2,
  Q: (t) => (t[3] && !t[3].includes("=") ? 4 : 3),
  M: (t) => (t[4] && !t[4].includes("=") ? 4 : 3),
  J: (t) => (t[3] && !t[3].includes("=") ? 4 : 3),
  V: 2, I: 2, E: 4, G: 4, H: 2, F: 2, S: 2, W: 2,
  T: (t) => (t[4] && !t[4].includes("=") ? 4 : 3),
  K: 0
};

function pinCount(letter: string, toks: string[]): number {
  const spec = PIN_COUNTS[letter];
  if (spec === undefined) return Math.max(0, toks.length);
  if (typeof spec === "function") return spec(toks);
  return spec;
}

interface ScopeEntry {
  raw: string;
  rawName: string;
  value: number | null;
  unit: string;
  unitSuffix: string | null;
  deps: string[];
  origin: "default" | "instance" | "param";
  sourceStatementId: string;
  diagnostic: string | null;
}

/** 在帧链上按依赖拓扑求值；无法解析的表达式保留 null + 诊断（不压平依赖）。 */
function evaluateFrame(
  entries: Map<string, ScopeEntry>
): Record<string, ScopeEntry> {
  const result: Record<string, ScopeEntry> = {};
  const visiting = new Set<string>();
  const done = new Set<string>();

  const lookup = (name: string): number | undefined => {
    const e = entries.get(name);
    if (!e) return undefined;
    resolve(name);
    return entries.get(name)!.value ?? undefined;
  };

  const resolve = (name: string) => {
    if (done.has(name)) return;
    if (visiting.has(name)) {
      const e = entries.get(name)!;
      e.value = null;
      e.diagnostic = `参数依赖存在环（涉及 ${name}），保留表达式原值`;
      done.add(name);
      return;
    }
    visiting.add(name);
    const e = entries.get(name)!;
    if (e.value !== null) {
      done.add(name);
      return;
    }
    if (e.deps.length === 0) {
      done.add(name);
      return;
    }
    try {
      e.value = evalAst(makeParamExpr(e.raw).expr, lookup);
      e.diagnostic = null;
    } catch (err) {
      e.value = null;
      e.diagnostic = `${(err as Error).message}；表达式 "${e.raw}" 保留原位置`;
    }
    done.add(name);
  };

  for (const name of entries.keys()) resolve(name);
  for (const [name, e] of entries) result[name] = e;
  return result;
}

/** 构造一个子电路调用帧：形参默认值 -> .PARAM 局部 -> 实例实参（实参最高优先）。 */
function buildFrame(
  scopePath: string,
  def: SubcktDef,
  instanceBindings: { formal: string; actual: ReturnType<typeof makeParamExpr>; sourceStatementId: string }[],
  instanceScopeLookup: (n: string) => number | undefined,
  diagnostics: Diagnostic[]
): ParamFrame {
  const map = new Map<string, ScopeEntry>();

  // 1) 默认值
  for (const p of def.params) {
    const pe = p.def;
    map.set(p.name, {
      raw: pe?.raw ?? "",
      rawName: p.rawName,
      value: pe?.value ?? null,
      unit: pe?.unit ?? "",
      unitSuffix: pe?.unitSuffix ?? null,
      deps: pe?.deps ?? [],
      origin: "default",
      sourceStatementId: p.statementId,
      diagnostic: pe?.diagnostic ?? (pe ? null : "形参无默认值且实例未提供")
    });
  }

  // 2) 体内 .PARAM（可引用形参或前序局部参数）
  for (const b of def.body) {
    if (b.kind !== "param") continue;
    for (const kv of parseKeyValueTokens(b.tokens.slice(1))) {
      const cur = map.get(kv.name);
      map.set(kv.name, {
        raw: kv.expr.raw,
        rawName: kv.rawName,
        value: kv.expr.value,
        unit: kv.expr.unit,
        unitSuffix: kv.expr.unitSuffix,
        deps: kv.expr.deps,
        origin: "param",
        sourceStatementId: b.id,
        diagnostic: cur?.diagnostic ?? null
      });
    }
  }

  // 3) 实例实参（在调用者作用域中求值，最高优先级）
  for (const bind of instanceBindings) {
    const pe = bind.actual;
    let value = pe.value;
    let diag = pe.diagnostic;
    if (value === null && pe.deps.length > 0) {
      try {
        value = evalAst(pe.expr, instanceScopeLookup);
        diag = null;
      } catch (err) {
        value = null;
        diag = `${(err as Error).message}；实参 "${pe.raw}" 保留原位置`;
      }
    }
    map.set(bind.formal, {
      raw: pe.raw,
      rawName: bind.formal,
      value,
      unit: pe.unit,
      unitSuffix: pe.unitSuffix,
      deps: pe.deps,
      origin: "instance",
      sourceStatementId: bind.sourceStatementId,
      diagnostic: diag
    });
  }

  const evaluated = evaluateFrame(map);
  const frame: ParamFrame = { scopePath, params: evaluated };
  for (const [name, e] of Object.entries(evaluated)) {
    if (e.diagnostic) {
      diagnostics.push({
        code: e.diagnostic.includes("单位") ? "unit-unconvertible" : "param-unresolved",
        message: `[${scopePath}] ${name}: ${e.diagnostic}`,
        statementId: e.sourceStatementId,
        objectId: `${scopePath}:${name}`
      });
    }
  }
  return frame;
}

/** 解析 X 实例的 `NAME n1 n2 ... SUBNAME PARAMS: A=1 ...`。 */
function parseXInstance(stmt: Statement) {
  const rawName = stmt.tokens[0];
  let i = 1;
  const nodeArgs: string[] = [];
  while (i < stmt.tokens.length && !stmt.tokens[i].includes("=") && !stmt.tokens[i].toUpperCase().startsWith("PARAMS:")) {
    nodeArgs.push(stmt.tokens[i]);
    i++;
  }
  let subcktRaw = "";
  if (nodeArgs.length > 0) {
    subcktRaw = nodeArgs.pop()!;
  }
  const bindTokens: string[] = [];
  if (i < stmt.tokens.length && stmt.tokens[i].toUpperCase().startsWith("PARAMS:")) {
    const head = stmt.tokens[i].slice("PARAMS:".length);
    if (head.length) bindTokens.push(head);
    i++;
    while (i < stmt.tokens.length) bindTokens.push(stmt.tokens[i++]);
  }
  const kvs = parseKeyValueTokens(bindTokens);
  return {
    rawName,
    nodeArgs,
    subcktRaw,
    subcktName: upperName(subcktRaw),
    bindings: kvs.map((kv, idx) => ({
      formal: kv.name,
      rawFormal: kv.rawName,
      actual: kv.expr,
      order: idx
    }))
  };
}

/** 普通器件：确定引脚 token 区间（model 名是引脚后的首个非 key=value token）。 */
function parseDevice(stmt: Statement): {
  letter: string;
  nodeTokens: string[];
  modelName: string | null;
  params: { name: string; expr: ReturnType<typeof makeParamExpr> }[];
  opaque: boolean;
} {
  const letter = stmt.tokens[0].charAt(0).toUpperCase();
  const opaque = !KNOWN_LETTERS.has(letter);
  const n = pinCount(letter, stmt.tokens.slice(1));
  const nodeTokens = stmt.tokens.slice(1, 1 + n);
  let modelName: string | null = null;
  const rest = stmt.tokens.slice(1 + n);
  const paramTokens: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const tk = rest[i];
    if (tk.toUpperCase().startsWith("PARAMS:")) {
      const head = tk.slice("PARAMS:".length);
      if (head.length) paramTokens.push(head);
      continue;
    }
    if (!tk.includes("=") && modelName === null) {
      modelName = tk;
      continue;
    }
    paramTokens.push(tk);
  }
  return {
    letter,
    nodeTokens,
    modelName,
    params: parseKeyValueTokens(paramTokens).map((kv) => ({ name: kv.name, expr: kv.expr })),
    opaque
  };
}

interface ExpandCtx {
  subcktsByName: Map<string, SubcktDef[]>;
  modelsByName: Map<string, ModelVersion[]>;
  globals: Set<string>;
  devices: FlatDevice[];
  frames: ParamFrame[];
  diagnostics: Diagnostic[];
  globalNodes: Map<string, string>;
  deviceCounter: Map<string, number>;
}

function globalNodeId(raw: string): string {
  return `G:${upperName(raw)}`;
}

/** 展平节点：全局节点（0/.GLOBAL）保持同名；其余加层次前缀（alpha-rename 安全）。 */
function mapNode(ctx: ExpandCtx, raw: string, path: string): string {
  if (raw === "0") return "G:0";
  if (ctx.globals.has(upperName(raw))) return globalNodeId(raw);
  return `${path}/${upperName(raw)}`;
}

function registerGlobal(ctx: ExpandCtx, raw: string) {
  const id = globalNodeId(raw);
  if (!ctx.globalNodes.has(id)) ctx.globalNodes.set(id, raw);
}

function expandSubckt(
  ctx: ExpandCtx,
  def: SubcktDef | null,
  candidateDefs: SubcktDef[],
  path: string,
  externalNodes: { formal: string; actualRaw: string; actualFlat: string }[],
  instanceBindings: { formal: string; actual: ReturnType<typeof makeParamExpr>; sourceStatementId: string }[],
  parentLookup: (n: string) => number | undefined,
  stmt: Statement,
  hierarchyOut: HierarchyNode[]
): HierarchyNode {
  const node = externalNodes[0] ? externalNodes : [];
  const formalToFlat = new Map<string, string>();
  for (const n of node) formalToFlat.set(upperName(n.formal), n.actualFlat);

  const frame = def
    ? buildFrame(
        path,
        def,
        instanceBindings,
        parentLookup,
        ctx.diagnostics
      )
    : { scopePath: path, params: {} };
  ctx.frames.push(frame);
  const localLookup = (n: string): number | undefined => {
    const local = frame.params[n];
    if (local && local.value !== null) return local.value;
    return parentLookup(n);
  };

  const hnode: HierarchyNode = {
    path,
    rawName: path.split("/").pop() ?? path,
    subcktName: def?.name ?? candidateDefs[0]?.name ?? "?",
    subcktDefId: def?.id ?? null,
    candidateDefIds: candidateDefs.map((d) => d.id),
    nodeMap: node.map((n) => ({ formal: n.formal, actualRaw: n.actualRaw })),
    bindings: instanceBindings.map((b, i) => ({
      formal: b.formal,
      rawFormal: b.formal,
      actual: b.actual,
      order: i
    })),
    children: [],
    statementId: stmt.id,
    diagnostic: def ? null : `子电路 ${candidateDefs[0]?.name ?? "?"} 重名/缺失，无法唯一展开`
  };
  hierarchyOut.push(hnode);
  if (!def) return hnode;

  for (const bstmt of def.body) {
    if (bstmt.kind === "param" || bstmt.kind === "comment" || bstmt.kind === "control") continue;
    if (bstmt.kind === "subckt" || bstmt.kind === "ends") continue;
    if (bstmt.kind === "model" || bstmt.kind === "include" || bstmt.kind === "lib" || bstmt.kind === "global") continue;

    if (bstmt.tokens[0]?.toUpperCase().startsWith("X")) {
      const parsed = parseXInstance(bstmt);
      const childPath = `${path}/${parsed.rawName.toUpperCase()}`;
      const childNodeMap = parsed.nodeArgs.map((actualRaw, idx) => {
        const formal = def.nodes[idx] ?? actualRaw;
        // 实例实参在本帧解析：形式端口 -> 外部；其它名字按局部/全局节点处理
        let actualFlat: string;
        if (formalToFlat.has(upperName(actualRaw))) {
          actualFlat = formalToFlat.get(upperName(actualRaw))!;
        } else {
          actualFlat = mapNode(ctx, actualRaw, path);
        }
        return { formal, actualRaw, actualFlat };
      });
      const cands = ctx.subcktsByName.get(parsed.subcktName) ?? [];
      const childDef = cands.length === 1 ? cands[0] : null;
      if (cands.length === 0) {
        ctx.diagnostics.push({
          code: "subckt-missing",
          message: `[${childPath}] 子电路 ${parsed.subcktName} 无定义`,
          statementId: bstmt.id,
          objectId: childPath
        });
      } else if (cands.length > 1) {
        ctx.diagnostics.push({
          code: "subckt-ambiguous",
          message: `[${childPath}] 子电路名 ${parsed.subcktName} 有 ${cands.length} 个重名定义，全部保留为候选`,
          statementId: bstmt.id,
          objectId: childPath
        });
      }
      const childBindings = parsed.bindings.map((b) => ({
        formal: b.formal,
        actual: b.actual,
        sourceStatementId: bstmt.id
      }));
      const child = expandSubckt(
        ctx,
        childDef,
        cands,
        childPath,
        childNodeMap,
        childBindings,
        localLookup,
        bstmt,
        hnode.children
      );
      void child;
      continue;
    }

    // 顶层器件
    const parsed = parseDevice(bstmt);
    const counter = ctx.deviceCounter.get(parsed.letter) ?? 0;
    ctx.deviceCounter.set(parsed.letter, counter + 1);
    const devId = `${path}/${bstmt.tokens[0].toUpperCase()}`;
    const flatNodes = parsed.nodeTokens.map((raw) => {
      if (formalToFlat.has(upperName(raw))) return formalToFlat.get(upperName(raw))!;
      const f = mapNode(ctx, raw, path);
      if (raw !== "0" && !ctx.globals.has(upperName(raw))) return f;
      return f;
    });
    for (const raw of parsed.nodeTokens) registerGlobal(ctx, raw === "0" ? "0" : raw);
    const modelVersions = parsed.modelName
      ? (ctx.modelsByName.get(upperName(parsed.modelName)) ?? []).map((m) => m.id)
      : [];
    if (parsed.modelName && modelVersions.length === 0) {
      ctx.diagnostics.push({
        code: "model-missing",
        message: `[${devId}] model ${parsed.modelName} 无定义（器件保留）`,
        statementId: bstmt.id,
        objectId: devId
      });
    }
    if (parsed.modelName && modelVersions.length > 1) {
      ctx.diagnostics.push({
        code: "model-ambiguous",
        message: `[${devId}] model ${parsed.modelName} 有 ${modelVersions.length} 个版本候选`,
        statementId: bstmt.id,
        objectId: devId
      });
    }
    if (parsed.opaque) {
      ctx.diagnostics.push({
        code: "unknown-element",
        message: `[${devId}] 未知元件首字母 ${parsed.letter}，按 opaque 保留连接与原行`,
        statementId: bstmt.id,
        objectId: devId
      });
    }
    ctx.devices.push({
      id: devId,
      letter: parsed.opaque ? `U?${parsed.letter}` : parsed.letter,
      opaque: parsed.opaque,
      nodes: flatNodes,
      nodeRawChain: parsed.nodeTokens,
      params: parsed.params.map((p) => ({
        name: p.name,
        expr: { ...p.expr, value: p.expr.value ?? tryResolve(p.expr, localLookup) }
      })),
      modelVersionIds: modelVersions,
      modelName: parsed.modelName ? upperName(parsed.modelName) : null,
      sourceStatementId: bstmt.id,
      diagnostic: parsed.opaque ? "opaque 未知元件：连接保留，不参与参数语义判定" : null
    });
  }
  return hnode;
}

function tryResolve(
  expr: ReturnType<typeof makeParamExpr>,
  lookup: (n: string) => number | undefined
): number | null {
  if (expr.value !== null) return expr.value;
  if (expr.deps.length === 0) return null;
  try {
    return evalAst(expr.expr, lookup);
  } catch {
    return null;
  }
}

export function flatten(input: FlatInput): FlatNetlist {
  const subcktsByName = groupBy(input.subckts, (s) => s.name);
  const modelsByName = groupBy(input.models, (m) => m.name);
  const globals = new Set<string>(["0"]);
  for (const st of input.statements) {
    if (st.kind === "global") {
      for (const n of st.tokens.slice(1)) globals.add(upperName(n));
    }
  }

  const ctx: ExpandCtx = {
    subcktsByName,
    modelsByName,
    globals,
    devices: [],
    frames: [],
    diagnostics: [...input.diagnostics],
    globalNodes: new Map<string, string>(),
    deviceCounter: new Map<string, number>()
  };
  ctx.globalNodes.set("G:0", "0");

  // 顶层作用域帧（.PARAM 全局参数，依赖保留）
  const topEntries = new Map<string, ScopeEntry>();
  for (const tp of input.topParams) {
    topEntries.set(tp.name, {
      raw: tp.expr.raw,
      rawName: tp.rawName,
      value: tp.expr.value,
      unit: tp.expr.unit,
      unitSuffix: tp.expr.unitSuffix,
      deps: tp.expr.deps,
      origin: "param",
      sourceStatementId: tp.statementId,
      diagnostic: tp.expr.diagnostic
    });
  }
  const topFrame: ParamFrame = { scopePath: "$", params: evaluateFrame(topEntries) };
  ctx.frames.push(topFrame);

  const hierarchy: HierarchyNode[] = [];
  const topLookup = (n: string): number | undefined => {
    const e = topFrame.params[n];
    return e && e.value !== null ? e.value : undefined;
  };

  // 仅处理顶层语句（子电路内部语句由 expandSubckt 处理）
  let depth = 0;
  for (const st of input.statements) {
    if (st.kind === "subckt") {
      depth++;
      continue;
    }
    if (st.kind === "ends") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth > 0) continue;
    if (
      st.kind === "comment" ||
      st.kind === "control" ||
      st.kind === "model" ||
      st.kind === "include" ||
      st.kind === "lib" ||
      st.kind === "param"
    )
      continue;
    if (st.kind === "global") continue;

    if (st.kind === "instance" && st.tokens[0]?.toUpperCase().startsWith("X")) {
      const parsed = parseXInstance(st);
      const path = `/${parsed.rawName.toUpperCase()}`;
      const cands = subcktsByName.get(parsed.subcktName) ?? [];
      if (cands.length === 0) {
        ctx.diagnostics.push({
          code: "subckt-missing",
          message: `[${path}] 子电路 ${parsed.subcktName} 无定义`,
          statementId: st.id,
          objectId: path
        });
      } else if (cands.length > 1) {
        ctx.diagnostics.push({
          code: "subckt-ambiguous",
          message: `[${path}] 子电路名 ${parsed.subcktName} 有 ${cands.length} 个重名定义`,
          statementId: st.id,
          objectId: path
        });
      }
      const nodeMap = parsed.nodeArgs.map((actualRaw, idx) => {
        const formal = cands[0]?.nodes[idx] ?? actualRaw;
        return { formal, actualRaw, actualFlat: mapNode(ctx, actualRaw, "$") };
      });
      const bindings = parsed.bindings.map((b) => ({
        formal: b.formal,
        actual: b.actual,
        sourceStatementId: st.id
      }));
      expandSubckt(ctx, cands.length === 1 ? cands[0] : null, cands, path, nodeMap, bindings, topLookup, st, hierarchy);
      continue;
    }

    if (st.kind === "instance" || st.kind === "unknown") {
      const parsed = parseDevice(st);
      const devId = `/${st.tokens[0].toUpperCase()}`;
      if (parsed.opaque) {
        ctx.diagnostics.push({
          code: "unknown-element",
          message: `[${devId}] 未知元件首字母 ${parsed.letter}，按 opaque 保留`,
          statementId: st.id,
          objectId: devId
        });
      }
      const modelVersions = parsed.modelName
        ? (modelsByName.get(upperName(parsed.modelName)) ?? []).map((m) => m.id)
        : [];
      ctx.devices.push({
        id: devId,
        letter: parsed.opaque ? `U?${parsed.letter}` : parsed.letter,
        opaque: parsed.opaque,
        nodes: parsed.nodeTokens.map((raw) => mapNode(ctx, raw, "$")),
        nodeRawChain: parsed.nodeTokens,
        params: parsed.params.map((p) => ({
          name: p.name,
          expr: { ...p.expr, value: p.expr.value ?? tryResolve(p.expr, topLookup) }
        })),
        modelVersionIds: modelVersions,
        modelName: parsed.modelName ? upperName(parsed.modelName) : null,
        sourceStatementId: st.id,
        diagnostic: parsed.opaque ? "opaque 未知元件：连接保留，不参与参数语义判定" : null
      });
      continue;
    }
  }

  return {
    side: input.side,
    globalNodes: [...ctx.globalNodes.entries()].map(([id, raw]) => ({ id, raw })),
    devices: ctx.devices,
    hierarchy,
    frames: ctx.frames,
    subckts: input.subckts,
    models: input.models,
    includes: input.edges,
    files: input.files,
    diagnostics: ctx.diagnostics
  };
}
