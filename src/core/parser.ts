import { stableId } from "./ids.js";
import { lexFile } from "./lexer.js";
import {
  KNOWN_CLASS_LETTERS,
  type RawElement, type RawNetlist
} from "./rawNetlist.js";
import type {
  RawFile, RawLogicalLine, RawModel, ParamAssignment, IncludeRef,
  SubcktDef, OpaqueElement, Diagnostic, SourceLoc
} from "./types.js";

let diagCounter = 0;
function diag(
  code: string, level: Diagnostic["level"], message: string,
  loc: SourceLoc | null, subjectId: string | null
): Diagnostic {
  diagCounter++;
  return { id: stableId("dg", [code, message, subjectId ?? "", diagCounter]), code, level, message, loc, subjectId };
}

/** 解析 “NAME=VALUE” 序列（.param / 实例 PARAMS: / .model 参数 / 子电路形参）。 */
export function parseParamPairs(
  tokens: string[], fromIndex: number, loc: SourceLoc, scopePath: string[], idScope: string
): { params: ParamAssignment[]; nextIndex: number; diagnostics: Diagnostic[] } {
  const params: ParamAssignment[] = [];
  const diagnostics: Diagnostic[] = [];
  let i = fromIndex;
  let pairCounter = 0;
  while (i < tokens.length) {
    const tok = tokens[i]!;
    const eq = tok.indexOf("=");
    if (eq <= 0) {
      // 裸 token：在 PARAMS 语境里非法；跳过并诊断
      diagnostics.push(diag("param-without-assignment", "warning",
        `ignored token in parameter list: ${tok}`, loc, null));
      i++;
      continue;
    }
    const nameRaw = tok.slice(0, eq);
    let valueRaw = tok.slice(eq + 1);
    // '=' 后可能为空，值在下一个 token
    if (valueRaw === "" && i + 1 < tokens.length && !tokens[i + 1]!.includes("=")) {
      valueRaw = tokens[i + 1]!;
      i++;
    }
    pairCounter++;
    params.push({
      id: stableId(idScope, [loc.fileId, loc.line, nameRaw, pairCounter]),
      nameRaw,
      valueRaw,
      loc,
      scopePath: [...scopePath]
    });
    i++;
  }
  return { params, nextIndex: i, diagnostics };
}

export interface ParseResult {
  netlist: RawNetlist;
  /** include 指令按出现顺序，供导入器解析文件。 */
  pendingIncludes: IncludeRef[];
}

export function parseFile(file: RawFile): ParseResult {
  diagCounter = 0;
  const logicalLines = lexFile(file.id, file.content, [file.id]);
  const elements: RawElement[] = [];
  const subckts: SubcktDef[] = [];
  const models: RawModel[] = [];
  const includes: IncludeRef[] = [];
  const paramAssignments: ParamAssignment[] = [];
  const globalNodes: RawNetlist["globalNodes"] = [];
  const diagnostics: Diagnostic[] = [];
  const pendingIncludes: IncludeRef[] = [];

  // 同名 subckt/model 版本计数
  const subcktVersions = new Map<string, number>();
  const modelVersions = new Map<string, number>();

  // 子电路栈：记录当前 subckt 定义体
  interface OpenSub { def: SubcktDef; }
  const stack: OpenSub[] = [];

  let elemCounter = 0;

  for (const line of logicalLines) {
    if (line.kind === "blank" || line.kind === "comment") continue;

    if (line.kind === "control") {
      const name = line.controlName!;
      const toks = line.tokens;

      if (name === ".subckt") {
        if (stack.length > 0) {
          diagnostics.push(diag("nested-subckt", "error",
            ".subckt inside another .subckt body", line.loc, null));
        }
        // .subckt NAME p1 p2 ... [params: ...]
        const subName = toks[1] ?? "";
        let j = 2;
        const ports: SubcktDef["ports"] = [];
        while (j < toks.length) {
          const t = toks[j]!;
          if (t.toLowerCase() === "params" && j + 1 < toks.length && toks[j + 1] === ":") { j += 2; break; }
          if (t === ":") { j++; break; }
          ports.push({ nameRaw: t, loc: line.loc });
          j++;
        }
        const { params } = parseParamPairs(toks, j, line.loc, [subName], "sp");
        const ver = (subcktVersions.get(subName.toLowerCase()) ?? 0);
        subcktVersions.set(subName.toLowerCase(), ver + 1);
        const def: SubcktDef = {
          id: stableId("sub", [file.id, subName.toLowerCase(), ver]),
          nameRaw: subName,
          ports,
          params,
          bodyLineIds: [],
          loc: line.loc,
          fileId: file.id,
          versionIndex: ver
        };
        subckts.push(def);
        stack.push({ def });
        continue;
      }

      if (name === ".ends") {
        const open = stack.pop();
        if (!open) {
          diagnostics.push(diag("unmatched-ends", "error", ".ends without .subckt", line.loc, null));
        } else if (toks.length > 1 && toks[1]!.toLowerCase() !== open.def.nameRaw.toLowerCase()) {
          diagnostics.push(diag("ends-name-mismatch", "warning",
            `.ends ${toks[1]} does not match .subckt ${open.def.nameRaw}`, line.loc, open.def.id));
        }
        continue;
      }

      if (name === ".include" || name === ".inc" || name === ".lib") {
        // .lib [path] [section]；.include path
        const mode = name === ".lib" ? "lib" : "include";
        const arg = toks[1] ?? "";
        const sectionRaw = mode === "lib" && toks.length > 2 ? toks.slice(2).join(" ") : null;
        const ref: IncludeRef = {
          id: stableId("inc", [file.id, line.loc.line, arg]),
          pathRaw: arg,
          loc: line.loc,
          resolvedFileId: null,
          mode,
          sectionRaw,
          diagnostic: null
        };
        includes.push(ref);
        pendingIncludes.push(ref);
        continue;
      }

      if (name === ".param" || name === ".parameters") {
        // 允许可选 PARAMS:
        let start = 1;
        if (toks[start]?.toLowerCase() === "params" && toks[start + 1] === ":") start += 2;
        const scope = stack.map((s) => s.def.nameRaw);
        const { params, diagnostics: pd } =
          parseParamPairs(toks, start, line.loc, scope, "pa");
        paramAssignments.push(...params);
        diagnostics.push(...pd);
        if (stack.length > 0) stack[stack.length - 1]!.def.params.push(...params);
        continue;
      }

      if (name === ".model") {
        // .model MNAME TYPE (p1=v1 p2=v2) [p3=v3]
        const mName = toks[1] ?? "";
        const mType = toks[2] ?? "";
        const bare: string[] = [];
        for (let j = 3; j < toks.length; j++) {
          let t = toks[j]!;
          if (t.startsWith("(")) t = t.slice(1);
          if (t.endsWith(")")) t = t.slice(0, -1);
          if (t !== "") bare.push(t);
        }
        const { params } = parseParamPairs(bare, 0, line.loc, [], "mp");
        const ver = modelVersions.get(mName.toLowerCase()) ?? 0;
        modelVersions.set(mName.toLowerCase(), ver + 1);
        const model: RawModel = {
          id: stableId("mdl", [file.id, mName.toLowerCase(), ver]),
          nameRaw: mName,
          typeRaw: mType,
          paramsRaw: params.map((p) => ({ nameRaw: p.nameRaw, valueRaw: p.valueRaw, loc: p.loc })),
          loc: line.loc,
          originFileId: file.id,
          versionIndex: ver
        };
        models.push(model);
        continue;
      }

      if (name === ".global") {
        for (let j = 1; j < toks.length; j++) globalNodes.push({ nameRaw: toks[j]!, loc: line.loc });
        continue;
      }

      if (name === ".end") { continue; }

      // 其它控制行（.options/.tran/.dc …）登记但不展开：记诊断为 info
      diagnostics.push(diag("control-ignored", "info", `control line retained but not interpreted: ${name}`, line.loc, null));
      continue;
    }

    // element line
    const toks = line.tokens;
    const instNameRaw = toks[0]!;
    const classLetter = instNameRaw[0]!.toLowerCase();
    elemCounter++;

    if (classLetter === "x") {
      // XNAME n1 n2 ... SUBNAME [PARAMS: k=v ...] [PARAMS k=v]
      let j = 1;
      const nodesRaw: string[] = [];
      while (j < toks.length && !isSubNameToken(toks[j]!, j, toks, nodesRaw.length)) j++;
      // 节点收集：直到遇到一个“非节点样式” token —— SPICE 中节点可任意命名，
      // 因此约定：subckt 名是 PARAMS 关键字前的最后一个裸 token。
      const nodes: string[] = [];
      j = 1;
      while (j < toks.length) {
        const t = toks[j]!;
        if (t.toLowerCase() === "params") break;
        nodes.push(t);
        j++;
      }
      const subcktNameRaw = nodes.pop() ?? null;
      void nodesRaw;
      let instParams: ParamAssignment[] = [];
      if (j < toks.length && toks[j]!.toLowerCase() === "params") {
        j++; // skip params
        if (toks[j] === ":") j++;
        const r = parseParamPairs(toks, j, line.loc, stack.map((s) => s.def.nameRaw), "ip");
        instParams = r.params;
      }
      const scope = stack.map((s) => s.def.nameRaw);
      const el: RawElement = {
        id: stableId("el", [file.id, line.loc.line, instNameRaw, elemCounter]),
        instNameRaw, classLetter, nodesRaw: nodes, modelOrValue: null,
        restTokens: [], instanceParams: instParams, subcktNameRaw,
        loc: line.loc, ownerPath: scope, known: true, opaqueReason: null
      };
      elements.push(el);
      if (stack.length > 0) stack[stack.length - 1]!.def.bodyLineIds.push(line.id);
      continue;
    }

    // 常规元件：R n1 n2 VALUE/MODEL ...；M n1 n2 n3 n4 MODEL ...
    const arity = NODE_ARITY[classLetter];
    const known = KNOWN_CLASS_LETTERS.has(classLetter);
    const nodeCount = arity ?? 0;
    const nodesRaw = toks.slice(1, 1 + nodeCount);
    const rest = toks.slice(1 + nodeCount);
    const scope = stack.map((s) => s.def.nameRaw);
    let modelOrValue: string | null = rest[0] ?? null;
    let instanceParams: ParamAssignment[] = [];
    let restTokens = rest.slice(1);
    // 参数可能内联在尾部（R1 n1 n2 1k tc=... 等），提取 name=token
    const kept: string[] = [];
    for (let k = 0; k < restTokens.length; k++) {
      const t = restTokens[k]!;
      if (t.toLowerCase() === "params") {
        let start = k + 1;
        if (restTokens[start] === ":") start++;
        const r = parseParamPairs(restTokens, start, line.loc, scope, "ip");
        instanceParams = r.params;
        break;
      }
      if (t.includes("=")) {
        const r = parseParamPairs(restTokens, k, line.loc, scope, "ip");
        instanceParams.push(...r.params);
        break;
      }
      kept.push(t);
    }
    restTokens = kept;
    const el: RawElement = {
      id: stableId("el", [file.id, line.loc.line, instNameRaw, elemCounter]),
      instNameRaw, classLetter, nodesRaw, modelOrValue,
      restTokens, instanceParams, subcktNameRaw: null,
      loc: line.loc, ownerPath: scope,
      known,
      opaqueReason: known ? null : `unknown-element-class: ${classLetter}`
    };
    elements.push(el);
    if (!known) {
      diagnostics.push(diag("opaque-element", "warning",
        `element ${instNameRaw} has unknown class letter '${classLetter}'; retained as opaque`,
        line.loc, el.id));
    }
    if (stack.length > 0) stack[stack.length - 1]!.def.bodyLineIds.push(line.id);
  }

  if (stack.length > 0) {
    diagnostics.push(diag("unterminated-subckt", "error",
      `.subckt ${stack.map((s) => s.def.nameRaw).join(",")} missing .ends`,
      stack[stack.length - 1]!.def.loc, stack[stack.length - 1]!.def.id));
  }

  return {
    netlist: {
      logicalLines, elements, subckts, models, includes,
      paramAssignments, globalNodes, diagnostics
    },
    pendingIncludes
  };
}

const NODE_ARITY: Record<string, number> = {
  r: 2, c: 2, l: 2, d: 2, v: 2, i: 2,
  e: 4, g: 4, f: 2, h: 2,
  q: 3, j: 3, z: 3, m: 4,
  k: 2, s: 4, w: 4, o: 4, u: 0, t: 0, p: 0
};

function isSubNameToken(_t: string, _j: number, _toks: string[], _n: number): boolean {
  // 占位：真正解析在下方循环（节点名可为任意 token，约定 subckt 名为 PARAMS 前最后一个）。
  return false;
}

export type { OpaqueElement };
