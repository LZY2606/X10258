import { stableId, canonicalName } from "./ids.js";
import type { ImportedBundle } from "./importer.js";
import type { RawNetlist } from "./rawNetlist.js";
import type { ParamAssignment, SubcktDef, Diagnostic, SourceLoc } from "./types.js";
import { parseSpiceNumber, basisForContext } from "./units.js";
import { evaluateExpression, expressionVariables } from "./eval.js";

/** 展平后的节点（实例局部名 -> 全局路径化身份；alpha-rename 的对象）。 */
export interface FlatNode {
  id: string;
  /** 全局唯一路径，如 top/X1/X2/net3。 */
  path: string;
  /** 原始局部名（最近一层的拼写）。 */
  localNameRaw: string;
  /** 外部端口节点 / .global 节点标记，alpha-rename 时受限。 */
  kind: "internal" | "global" | "external";
  loc: SourceLoc | null;
}

export interface FlatParam {
  id: string;
  nameRaw: string;
  canonicalName: string;
  valueRaw: string;
  /** 来源链：default(形参默认) < instance-override < local .param。 */
  resolutionOrder: string[];
  /** 最终采用的来源 assignment id。 */
  sourceId: string;
  scopePath: string[];
  siValue: number | null;
  unitSuffix: string;
  basis: string;
  diagnostic: string | null;
  /** 表达式自由变量（canonical），不可压平的依赖。 */
  dependsOn: string[];
  /** 若为表达式依赖，记录求值时使用的上下文值。 */
  evaluatedFrom: Record<string, number> | null;
  loc: SourceLoc;
}

export interface FlatElement {
  id: string;
  /** 展平实例路径，如 top/Xdut/Xload/Rtail。 */
  instancePath: string;
  instNameRaw: string;
  classLetter: string;
  /** 端口连接：[flatNodeId]（顺序保留，unknown 元件也保留全部连接）。 */
  nodeIds: string[];
  nodeNamesRaw: string[];
  modelNameRaw: string | null;
  /** 数值型主参数的规范化（派生）结果，原值在 valueRaw。 */
  valueRaw: string | null;
  siValue: number | null;
  unitSuffix: string;
  basis: string;
  valueDiagnostic: string | null;
  params: string[];
  opaque: boolean;
  opaqueReason: string | null;
  /** 所属 subckt 定义 id 链（顶层为空数组）。 */
  subcktDefPath: string[];
  /** 对应的 hierarchy 实例 id。 */
  hierarchyInstanceId: string;
  loc: SourceLoc;
}

export interface HierarchyInstance {
  id: string;
  /** 实例路径。 */
  path: string;
  instNameRaw: string;
  subcktDefId: string;
  subcktNameRaw: string;
  parentId: string | null;
  /** 端口连接：外部节点路径 -> 形参端口名。 */
  portBindings: { portRaw: string; nodePath: string; nodeId: string }[];
  /** 采用的同名 subckt 定义版本；未决时为 null（需人工裁定）。 */
  boundVersionIndex: number | null;
  depth: number;
}

export interface HierarchyNode {
  id: string;
  label: "TOP" | string;
  subcktDefId: string | null;
  childrenIds: string[];
  parentId: string | null;
  instanceId: string | null;
}

export interface FlattenResult {
  side: "A" | "B";
  nodes: FlatNode[];
  elements: FlatElement[];
  params: FlatParam[];
  hierarchyInstances: HierarchyInstance[];
  hierarchy: HierarchyNode;
  externalNodes: string[];
  globalNodes: string[];
  diagnostics: Diagnostic[];
  /** 未决绑定（子电路重名）：实例 id -> 候选 defId 列表，顺序=版本顺序。 */
  pendingBindings: { instanceId: string; candidates: { defId: string; fileId: string; versionIndex: number }[] }[];
}

export interface BindingDecision {
  instancePath: string;
  subcktDefId: string;
}

export interface FlattenOptions {
  /** 已人工裁定的重名绑定（instancePath -> defId）；未提供则按 version 0 默认并产生 pending。 */
  bindings?: BindingDecision[];
  maxDepth?: number;
}

interface Frame {
  def: SubcktDef | null; // null = TOP
  instancePath: string;
  nodePathPrefix: string;
  parentInstanceId: string | null;
  /** 当前作用域形参/局部参数 canonical -> FlatParam（默认值已就位，实例覆盖已应用）。 */
  scopeParams: Map<string, FlatParam>;
  /** 与实例路径对应的 subckt 名链（TOP 为 []），用于精确定位体元件。 */
  ownerNamePath: string[];
}

export function flattenBundle(
  side: "A" | "B",
  bundle: ImportedBundle,
  options: FlattenOptions = {}
): FlattenResult {
  const { netlist } = bundle;
  const maxDepth = options.maxDepth ?? 100;
  const bindingByPath = new Map(options.bindings?.map((b) => [b.instancePath, b.subcktDefId]));

  const nodes = new Map<string, FlatNode>();
  const elements: FlatElement[] = [];
  const params: FlatParam[] = [];
  const hierarchyInstances: HierarchyInstance[] = [];
  const pendingBindings: FlattenResult["pendingBindings"] = [];
  const diagnostics: Diagnostic[] = [];

  const subByName = new Map<string, SubcktDef[]>();
  for (const sub of netlist.subckts) {
    const key = canonicalName(sub.nameRaw);
    const arr = subByName.get(key) ?? [];
    arr.push(sub);
    subByName.set(key, arr);
  }
  const modelNames = new Set(netlist.models.map((m) => canonicalName(m.nameRaw)));
  const globalNames = new Set(netlist.globalNodes.map((g) => canonicalName(g.nameRaw)));

  const hierarchyRoot: HierarchyNode = {
    id: "hier_top", label: "TOP", subcktDefId: null, childrenIds: [], parentId: null, instanceId: null
  };

  function findDefs(nameRaw: string): SubcktDef[] {
    return subByName.get(canonicalName(nameRaw)) ?? [];
  }

  function internNode(localNameRaw: string, frame: Frame, kind: FlatNode["kind"], loc: SourceLoc | null): FlatNode {
    const isGlobal = globalNames.has(canonicalName(localNameRaw));
    if (isGlobal) {
      const id = stableId("ng", ["global", canonicalName(localNameRaw)]);
      const existing = nodes.get(id);
      if (existing) return existing;
      const n: FlatNode = {
        id, path: `GLOBAL:${canonicalName(localNameRaw)}`, localNameRaw, kind: "global", loc
      };
      nodes.set(id, n);
      return n;
    }
    const path = frame.nodePathPrefix === "" ? localNameRaw : `${frame.nodePathPrefix}/${localNameRaw}`;
    const id = stableId("n", [side, path]);
    const existing = nodes.get(id);
    if (existing) return existing;
    const n: FlatNode = { id, path, localNameRaw, kind, loc };
    nodes.set(id, n);
    return n;
  }

  /** 计算一个作用域内的参数快照：形参默认值 + 局部 .param，再叠加实例覆盖。 */
  function buildScope(
    def: SubcktDef | null,
    frame: Frame | null,
    overrides: ParamAssignment[],
    instancePath: string
  ): Map<string, FlatParam> {
    const scope = new Map<string, FlatParam>();
    // 1) 形参默认值
    if (def) {
      for (const pa of def.params) {
        putParam(scope, pa, ["default"], instancePath, def);
      }
    }
    // 2) 该 subckt 体内 .param（netlist.paramAssignments 中 scopePath 匹配）
    for (const pa of netlist.paramAssignments) {
      if (def && pa.scopePath.length > 0 &&
          pa.scopePath[pa.scopePath.length - 1]?.toLowerCase() === canonicalName(def.nameRaw)) {
        putParam(scope, pa, ["local-param"], instancePath, def);
      }
    }
    // 3) 实例覆盖（最高优先级）
    for (const pa of overrides) {
      putParam(scope, pa, ["instance-override"], instancePath, def);
    }
    return scope;
  }

  function putParam(
    scope: Map<string, FlatParam>,
    pa: ParamAssignment,
    resolutionOrder: string[],
    instancePath: string,
    def: SubcktDef | null
  ): FlatParam {
    const key = canonicalName(pa.nameRaw);
    const idPath = def ? `${instancePath}:${key}` : `top:${key}`;
    const dependsOn = expressionVariables(pa.valueRaw).filter((v) => v !== key);
    const isLiteral = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?/.test(pa.valueRaw.trim())
      && !/[a-zA-Z_]/.test(pa.valueRaw.trim().replace(/^(meg|[tgkmunpf])/i, "").replace(/^[0-9.eE+\-]+/, ""));
    let siValue: number | null = null;
    let unitSuffix = "";
    let basis = basisForContext("");
    let diagnostic: string | null = null;
    if (dependsOn.length === 0) {
      const parsed = parseSpiceNumber(pa.valueRaw);
      siValue = parsed.siValue;
      unitSuffix = parsed.unitSuffix;
      diagnostic = parsed.diagnostic;
    } else {
      diagnostic = "expression-deferred";
    }
    const fp: FlatParam = {
      id: stableId("fp", [side, idPath]),
      nameRaw: pa.nameRaw,
      canonicalName: key,
      valueRaw: pa.valueRaw,
      resolutionOrder,
      sourceId: pa.id,
      scopePath: pa.scopePath,
      siValue, unitSuffix, basis, diagnostic,
      dependsOn,
      evaluatedFrom: null,
      loc: pa.loc
    };
    scope.set(key, fp);
    return fp;
  }

  /** 依赖图传播求值：只对表达式参数，在其依赖已知时尝试；未知则保留原文与诊断。 */
  function resolveExpressions(scope: Map<string, FlatParam>, framePath: string) {
    // 拓扑迭代直到不动点
    let changed = true;
    const guard = 0;
    void guard;
    let rounds = 0;
    while (changed && rounds < 64) {
      changed = false;
      rounds++;
      for (const fp of scope.values()) {
        if (fp.dependsOn.length === 0 || fp.siValue !== null) continue;
        const ctx = new Map<string, number>();
        let allKnown = true;
        for (const dep of fp.dependsOn) {
          const d = scope.get(dep);
          if (d && d.siValue !== null) ctx.set(dep, d.siValue);
          else { allKnown = false; break; }
        }
        if (!allKnown) continue;
        const r = evaluateExpression(fp.valueRaw, ctx);
        if (r.ok && r.value !== undefined) {
          fp.siValue = r.value;
          fp.diagnostic = null;
          fp.evaluatedFrom = Object.fromEntries(ctx);
          changed = true;
        } else {
          fp.diagnostic = `expression-unresolved: ${r.reason ?? ""} @${framePath}`;
        }
      }
    }
  }

  function emitElement(rawEl: RawNetlist["elements"][number], frame: Frame) {
    const instancePath = frame.instancePath === "top"
      ? rawEl.instNameRaw
      : `${frame.instancePath}/${rawEl.instNameRaw}`;
    const nodeIds: string[] = [];
    for (const nn of rawEl.nodesRaw) {
      const n = internNode(nn, frame, frame.def ? "internal" : "external", rawEl.loc);
      nodeIds.push(n.id);
    }
    const scope = frame.scopeParams;
    const flatParams: FlatParam[] = rawEl.instanceParams.map((pa) => {
      const fp = putParam(new Map(), pa, ["inline-instance"], instancePath, frame.def);
      return fp;
    });
    // 内联参数也要做表达式解析（依赖同作用域）
    for (const fp of flatParams) {
      if (fp.dependsOn.length > 0) {
        const ctx = new Map<string, number>();
        let ok = true;
        for (const dep of fp.dependsOn) {
          const d = scope.get(dep);
          if (d && d.siValue !== null) ctx.set(dep, d.siValue); else { ok = false; break; }
        }
        if (ok) {
          const r = evaluateExpression(fp.valueRaw, ctx);
          if (r.ok && r.value !== undefined) {
            fp.siValue = r.value; fp.diagnostic = null; fp.evaluatedFrom = Object.fromEntries(ctx);
          }
        }
      }
    }
    for (const fp of flatParams) { params.push(fp); }

    let valueRaw = rawEl.modelOrValue;
    let modelNameRaw: string | null = null;
    // model 引用：M/Q/D/J 等带 model 名；R/C/L 若 token 命中 model 名则为 model 引用，否则为数值
    if (valueRaw !== null && modelNames.has(canonicalName(valueRaw))) {
      modelNameRaw = valueRaw;
      valueRaw = null;
    }
    const basisLetter = rawEl.classLetter;
    let siValue: number | null = null;
    let unitSuffix = "";
    let valueDiagnostic: string | null = null;
    if (valueRaw !== null) {
      // 可能是局部参数名引用
      const refParam = scope.get(canonicalName(valueRaw.replace(/^{|}$/g, "")));
      if (refParam) {
        siValue = refParam.siValue;
        unitSuffix = refParam.unitSuffix;
        valueDiagnostic = refParam.diagnostic ?? `alias-of:${refParam.id}`;
      } else {
        const deps = expressionVariables(valueRaw);
        if (deps.length === 0) {
          const parsed = parseSpiceNumber(valueRaw);
          siValue = parsed.siValue;
          unitSuffix = parsed.unitSuffix;
          valueDiagnostic = parsed.diagnostic;
        } else {
          const ctx = new Map<string, number>();
          let ok = true;
          for (const dep of deps) {
            const d = scope.get(dep);
            if (d && d.siValue !== null) ctx.set(dep, d.siValue); else { ok = false; break; }
          }
          if (ok) {
            const r = evaluateExpression(valueRaw, ctx);
            if (r.ok && r.value !== undefined) {
              siValue = r.value;
              valueDiagnostic = null;
            } else valueDiagnostic = r.reason ?? "expression-failed";
          } else {
            valueDiagnostic = `expression-deferred(deps=${deps.join(",")})`;
          }
        }
      }
    }

    const el: FlatElement = {
      id: stableId("fe", [side, instancePath]),
      instancePath,
      instNameRaw: rawEl.instNameRaw,
      classLetter: rawEl.classLetter,
      nodeIds,
      nodeNamesRaw: [...rawEl.nodesRaw],
      modelNameRaw,
      valueRaw: valueRaw ?? (modelNameRaw ? null : rawEl.modelOrValue),
      siValue,
      unitSuffix,
      basis: basisForContext(basisLetter),
      valueDiagnostic,
      params: flatParams.map((p) => p.id),
      opaque: !rawEl.known,
      opaqueReason: rawEl.opaqueReason,
      subcktDefPath: frame.def ? [frame.def.id] : [],
      hierarchyInstanceId: stableId("hi", [side, frame.instancePath]),
      loc: rawEl.loc
    };
    elements.push(el);
  }

  function instantiate(
    def: SubcktDef | null,
    frame: Frame,
    parentHierNode: HierarchyNode,
    depth: number
  ) {
    if (depth > maxDepth) {
      diagnostics.push({
        id: stableId("dg", ["depth", frame.instancePath]),
        code: "flatten-depth-exceeded",
        level: "error",
        message: `max instantiation depth exceeded at ${frame.instancePath}`,
        loc: null, subjectId: null
      });
      return;
    }
    // 找本层体元件：按 subckt 名链精确匹配（同名嵌套也不会串）。
    const wantPath = def ? frame.ownerNamePath.map(canonicalName) : [];
    const bodyElems = netlist.elements.filter((e) => {
      const owner = e.ownerPath.map(canonicalName);
      if (owner.length !== wantPath.length) return false;
      return owner.every((name, i) => name === wantPath[i]);
    });

    for (const rawEl of bodyElems) {
      if (rawEl.classLetter === "x") {
        const subName = rawEl.subcktNameRaw!;
        const candidates = findDefs(subName);
        if (candidates.length === 0) {
          diagnostics.push({
            id: stableId("dg", ["missing-sub", frame.instancePath, rawEl.instNameRaw]),
            code: "subckt-unresolved",
            level: "error",
            message: `instance ${rawEl.instNameRaw} references unknown subckt '${subName}'`,
            loc: rawEl.loc, subjectId: rawEl.id
          });
          // 作为 opaque 黑盒保留其外部连接，不删除
          emitOpaqueX(rawEl, frame, `subckt-unresolved:${subName}`);
          continue;
        }
        const childPath = frame.instancePath === "top"
          ? rawEl.instNameRaw
          : `${frame.instancePath}/${rawEl.instNameRaw}`;
        const chosenId = bindingByPath.get(childPath);
        let chosen: SubcktDef;
        if (chosenId) {
          const found = candidates.find((c) => c.id === chosenId);
          if (!found) {
            diagnostics.push({
              id: stableId("dg", ["bad-binding", childPath]),
              code: "binding-invalid",
              level: "error",
              message: `binding for ${childPath} does not match any candidate`,
              loc: rawEl.loc, subjectId: rawEl.id
            });
            chosen = candidates[0]!;
          } else chosen = found;
        } else {
          chosen = candidates[0]!;
        }
        const bound = chosenId ? chosen.versionIndex : (candidates.length > 1 ? null : 0);
        if (candidates.length > 1 && !chosenId) {
          pendingBindings.push({
            instanceId: stableId("hi", [side, childPath]),
            candidates: candidates.map((c) => ({
              defId: c.id, fileId: c.fileId, versionIndex: c.versionIndex
            }))
          });
        }

        // 端口绑定
        const portBindings: HierarchyInstance["portBindings"] = [];
        const childScope = buildScope(chosen, frame, rawEl.instanceParams, childPath);
        resolveExpressions(childScope, childPath);
        for (const p of childScope.values()) params.push(p);

        // 子帧节点路径前缀
        const childFrame: Frame = {
          def: chosen,
          instancePath: childPath,
          nodePathPrefix: childPath,
          parentInstanceId: stableId("hi", [side, frame.instancePath]),
          scopeParams: childScope,
          ownerNamePath: [...frame.ownerNamePath, chosen.nameRaw]
        };

        chosen.ports.forEach((port, i) => {
          const externalRaw = rawEl.nodesRaw[i];
          if (externalRaw === undefined) {
            diagnostics.push({
              id: stableId("dg", ["port-arity", childPath, port.nameRaw]),
              code: "port-arity-mismatch",
              level: "error",
              message: `instance ${childPath} missing connection for port ${port.nameRaw}`,
              loc: rawEl.loc, subjectId: rawEl.id
            });
            return;
          }
          const externalNode = internNode(externalRaw, frame, frame.def ? "internal" : "external", rawEl.loc);
          // 子电路内引用该端口的节点，直接与外部节点合一（端口别名）
          const aliasId = stableId("n", [side, `${childPath}/${port.nameRaw}`]);
          if (!nodes.has(aliasId)) {
            nodes.set(aliasId, {
              id: externalNode.id, path: externalNode.path, localNameRaw: port.nameRaw,
              kind: externalNode.kind, loc: port.loc
            });
          }
          portBindings.push({ portRaw: port.nameRaw, nodePath: externalNode.path, nodeId: externalNode.id });
        });

        const hiId = stableId("hi", [side, childPath]);
        const hi: HierarchyInstance = {
          id: hiId, path: childPath, instNameRaw: rawEl.instNameRaw,
          subcktDefId: chosen.id, subcktNameRaw: chosen.nameRaw,
          parentId: stableId("hi", [side, frame.instancePath]),
          portBindings, boundVersionIndex: bound, depth
        };
        hierarchyInstances.push(hi);
        const hNode: HierarchyNode = {
          id: stableId("hn", [side, childPath]), label: `${rawEl.instNameRaw}: ${chosen.nameRaw}`,
          subcktDefId: chosen.id, childrenIds: [], parentId: parentHierNode.id, instanceId: hiId
        };
        parentHierNode.childrenIds.push(hNode.id);
        instantiate(chosen, childFrame, hNode, depth + 1);
      } else {
        emitElement(rawEl, frame);
      }
    }
  }

  function emitOpaqueX(
    rawEl: RawNetlist["elements"][number],
    frame: Frame,
    reason: string
  ) {
    const instancePath = frame.instancePath === "top"
      ? rawEl.instNameRaw
      : `${frame.instancePath}/${rawEl.instNameRaw}`;
    const nodeIds = rawEl.nodesRaw.map((nn) =>
      internNode(nn, frame, frame.def ? "internal" : "external", rawEl.loc).id);
    elements.push({
      id: stableId("fe", [side, instancePath]),
      instancePath,
      instNameRaw: rawEl.instNameRaw,
      classLetter: rawEl.classLetter,
      nodeIds,
      nodeNamesRaw: [...rawEl.nodesRaw],
      modelNameRaw: null,
      valueRaw: null, siValue: null, unitSuffix: "",
      basis: basisForContext(""),
      valueDiagnostic: reason,
      params: [],
      opaque: true,
      opaqueReason: reason,
      subcktDefPath: frame.def ? [frame.def.id] : [],
      hierarchyInstanceId: stableId("hi", [side, frame.instancePath]),
      loc: rawEl.loc
    });
  }

  const topScope = buildScope(null, null, [], "top");
  resolveExpressions(topScope, "top");
  for (const p of topScope.values()) params.push(p);
  const topFrame: Frame = {
    def: null, instancePath: "top", nodePathPrefix: "", parentInstanceId: null,
    scopeParams: topScope, ownerNamePath: []
  };
  instantiate(null, topFrame, hierarchyRoot, 0);

  // 顶层外部节点（顶层元件引用且非 global）
  const externalNodes = [...nodes.values()]
    .filter((n) => n.kind === "external")
    .map((n) => n.id);
  const globalNodeIds = [...nodes.values()].filter((n) => n.kind === "global").map((n) => n.id);

  return {
    side,
    nodes: [...nodes.values()],
    elements,
    params,
    hierarchyInstances,
    hierarchy: hierarchyRoot,
    externalNodes,
    globalNodes: globalNodeIds,
    diagnostics,
    pendingBindings
  };
}
