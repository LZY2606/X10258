import {
  ModelVersion,
  ParamExpr,
  Statement,
  SubcktDef,
  SubcktParam
} from "../shared/types.ts";
import { makeParamExpr } from "./expr.ts";
import { cid, upperName } from "./util.ts";

/** 从 `PARAM1=1k PARAM2={2*R}` 形式的 token 序列解析键值参数（保留原始拼写）。 */
export function parseKeyValueTokens(
  tokens: string[]
): { name: string; rawName: string; expr: ParamExpr }[] {
  const out: { name: string; rawName: string; expr: ParamExpr }[] = [];
  for (const tk of tokens) {
    const eq = tk.indexOf("=");
    if (eq <= 0) continue;
    const rawName = tk.slice(0, eq);
    const rawVal = tk.slice(eq + 1);
    out.push({ name: upperName(rawName), rawName, expr: makeParamExpr(rawVal) });
  }
  return out;
}

/** 提取 .subckt 头部的节点与 PARAMS: 默认值；形参顺序保留。 */
export function parseSubcktHeader(stmt: Statement): {
  name: string;
  rawName: string;
  nodes: string[];
  params: SubcktParam[];
} {
  const tokens = stmt.tokens;
  // .SUBCKT NAME node1 node2 ... <PARAMS: A=1 B=2>
  const rawName = tokens[1] ?? "";
  const rest = tokens.slice(2);
  const paramsIdx = rest.findIndex((t) => t.toUpperCase().startsWith("PARAMS:"));
  const nodeTokens = paramsIdx >= 0 ? rest.slice(0, paramsIdx) : rest;
  const nodes = nodeTokens.map((n) => n);
  const params: SubcktParam[] = [];
  if (paramsIdx >= 0) {
    const p0 = rest[paramsIdx];
    const headVal = p0.slice("PARAMS:".length);
    const ptokens = [...(headVal.length > 0 ? [headVal] : []), ...rest.slice(paramsIdx + 1)];
    const kvs = parseKeyValueTokens(ptokens);
    kvs.forEach((kv, i) =>
      params.push({
        name: kv.name,
        rawName: kv.rawName,
        def: kv.expr,
        statementId: stmt.id,
        order: i
      })
    );
  }
  return { name: upperName(rawName), rawName, nodes, params };
}

/** 在全部文件的语句集合中抽取子电路定义。重名定义保留为不同 id（候选）。 */
export function collectSubckts(statements: Statement[]): SubcktDef[] {
  const defs: SubcktDef[] = [];
  let current:
    | { head: Statement; body: Statement[]; name: string; rawName: string; nodes: string[]; params: SubcktParam[] }
    | null = null;

  for (const stmt of statements) {
    if (stmt.kind === "subckt") {
      if (current) {
        // 嵌套 .subckt 不合法但不丢弃：作为 body 一部分保留并诊断
        current.body.push(stmt);
        continue;
      }
      const h = parseSubcktHeader(stmt);
      current = { head: stmt, body: [], ...h };
      continue;
    }
    if (stmt.kind === "ends") {
      if (current) {
        const material = JSON.stringify({
          name: current.name,
          nodes: current.nodes,
          params: current.params.map((p) => [p.rawName, p.def?.raw ?? null]),
          body: current.body.map((b) => b.tokens)
        });
        defs.push({
          id: cid("SUB", `${current.head.fileId}|${current.name}|${material}`),
          name: current.name,
          rawName: current.rawName,
          nodes: current.nodes,
          params: current.params,
          body: current.body,
          fileId: current.head.fileId,
          statementId: current.head.id
        });
        current = null;
      }
      continue;
    }
    if (current) current.body.push(stmt);
  }
  return defs;
}

/** 抽取 .MODEL 版本：同名不同参/不同来源为不同版本。 */
export function collectModels(statements: Statement[]): ModelVersion[] {
  const out: ModelVersion[] = [];
  for (const stmt of statements) {
    if (stmt.kind !== "model") continue;
    const rawName = stmt.tokens[1] ?? "";
    const type = (stmt.tokens[2] ?? "").toUpperCase();
    const rawParams = stmt.tokens.slice(3);
    out.push({
      id: cid("MOD", `${stmt.fileId}|${upperName(rawName)}|${type}|${rawParams.join("|")}`),
      name: upperName(rawName),
      rawName,
      type,
      rawParams,
      fileId: stmt.fileId,
      statementId: stmt.id
    });
  }
  return out;
}

/** 顶层 .PARAM（非子电路内）参数收集（作用域解析阶段使用）。 */
export function topLevelParams(statements: Statement[]): {
  name: string;
  rawName: string;
  expr: ParamExpr;
  statementId: string;
}[] {
  let depth = 0;
  const out: {
    name: string;
    rawName: string;
    expr: ParamExpr;
    statementId: string;
  }[] = [];
  for (const stmt of statements) {
    if (stmt.kind === "subckt") depth++;
    else if (stmt.kind === "ends") depth = Math.max(0, depth - 1);
    if (depth === 0 && stmt.kind === "param") {
      const kvs = parseKeyValueTokens(stmt.tokens.slice(1));
      for (const kv of kvs) out.push({ ...kv, statementId: stmt.id });
    }
  }
  return out;
}
