import type {
  ParsedBundle } from './lexparse';
import { tokenize } from './lexparse';
import { elementId, nodeId } from './ids';
import { parseExpr, evalExpr, refsOf } from './expr';
import { quantity } from './units';
import type {
  FlatNetlist, FlatElement, FlatNode, HierNode, ParamResolution,
  ParamOrigin, Quantity, SubcktDef, Diagnostic,
} from './types';

/** 各元件的节点数与“值”出现位置（token 下标，去掉实例名） */
interface DeviceSchema {
  nodes: number;
  valueStart?: number;
  unit?: string;
  /** 对称置换：可交换的引脚下标集合（展平图同构时使用） */
  symmetric?: number[][];
}

const SCHEMAS: Record<string, DeviceSchema> = {
  R: { nodes: 2, valueStart: 2, unit: 'ohm', symmetric: [[0, 1]] },
  C: { nodes: 2, valueStart: 2, unit: 'F', symmetric: [[0, 1]] },
  L: { nodes: 2, valueStart: 2, unit: 'H', symmetric: [[0, 1]] },
  D: { nodes: 2 },
  V: { nodes: 2, valueStart: 2, unit: 'V' },
  I: { nodes: 2, valueStart: 2, unit: 'A' },
  G: { nodes: 4, valueStart: 4, unit: 'S' },
  E: { nodes: 4 },
  H: { nodes: 4 },
  F: { nodes: 2 },
  Q: { nodes: 3, symmetric: [] },
  J: { nodes: 3 },
  M: { nodes: 4 },
};

/** 内部参数（非几何/器件值）关键字，不参与器件量值 */
const VALUED_KINDS = new Set(['R', 'C', 'L', 'V', 'I']);

interface Frame {
  path: string;
  subName: string | null;
  /** 局部参数：name → 原始表达式与来源 */
  params: Map<string, { rawExpr: string; origin: ParamOrigin }>;
  /** 局部节点名：sub 内部名 → 展平节点唯一路径 */
  nodeMap: Map<string, string>;
}

export function flatten(
  branch: string,
  parsed: ParsedBundle,
): FlatNetlist {
  const diagnostics: Diagnostic[] = [...parsed.diagnostics];
  const elements: FlatElement[] = [];
  const nodes: FlatNode[] = [];
  const hierarchy: HierNode[] = [];
  const scopeResolved: { scopePath: string; resolved: Record<string, ParamResolution> }[] = [];
  const nodeSeen = new Set<string>();
  const hierSeen = new Set<string>();

  const subByName = new Map<string, SubcktDef[]>();
  for (const s of parsed.subckts) {
    const arr = subByName.get(s.name) ?? [];
    arr.push(s);
    subByName.set(s.name, arr);
  }

  // 全局参数帧
  const globalParams = new Map<string, { rawExpr: string; origin: ParamOrigin }>();
  for (const d of parsed.paramDecls) {
    if (d.scopePath === '@global') {
      globalParams.set(d.name, {
        rawExpr: d.rawExpr,
        origin: { kind: 'global', lineId: d.lineId, scopePath: '@global' },
      });
    }
  }

  const ensureNode = (path: string, local: string, external: boolean) => {
    const id = nodeId(branch, path, local);
    if (!nodeSeen.has(id)) {
      nodeSeen.add(id);
      nodes.push({ id, branch, path, local, external });
    }
    return id;
  };
  const ensureHier = (path: string, subName: string | null, parentPath: string | null, lineId: string) => {
    if (hierSeen.has(path)) return;
    hierSeen.add(path);
    hierarchy.push({
      id: `hr:${branch}:${path}`, branch, instancePath: path,
      subcktName: subName, parentPath, sourceLineId: lineId, childPaths: [],
    });
    if (parentPath) {
      const p = hierarchy.find((h) => h.instancePath === parentPath);
      if (p) p.childPaths.push(path);
    }
  };

  /**
   * 作用域链参数求值（不可压平）：
   * 实例覆盖 > 子电路默认 > 全局；表达式依赖按引用静态收集，按帧动态解析。
   */
  const resolveParam = (
    name: string,
    frames: Frame[],
    stack: string[] = [],
  ): ParamResolution => {
    const lookup = (): { rawExpr: string; origin: ParamOrigin } | null => {
      for (let i = frames.length - 1; i >= 0; i--) {
        const hit = frames[i].params.get(name);
        if (hit) return hit;
      }
      return globalParams.get(name) ?? null;
    };
    const hit = lookup();
    if (!hit) {
      return {
        value: null, status: 'unresolved', reason: `unresolved-param: ${name}`,
        deps: [], expressionText: name,
        origin: { kind: 'unresolved', lineId: '', scopePath: frames[frames.length - 1]?.path ?? '@top' },
      };
    }
    if (stack.includes(name)) {
      return {
        value: null, status: 'unresolved', reason: `cyclic-param: ${stack.concat(name).join('->')}`,
        deps: [], expressionText: hit.rawExpr, origin: hit.origin,
      };
    }
    const expr = parseExpr(hit.rawExpr);
    const refs = [...refsOf(expr)];
    const deps = refs.map((r) => ({ name: r, origin: lookupOrigin(r, frames) }));
    const env = (r: string) => {
      if (r === name) return undefined ?? null;
      const sub = resolveParam(r, frames, stack.concat(name));
      return sub.value;
    };
    const value = evalExpr(expr, env);
    return {
      value,
      status: value === null ? 'unresolved' : 'ok',
      reason: value === null ? `expression-unresolved: ${hit.rawExpr}` : undefined,
      deps, expressionText: hit.rawExpr, origin: hit.origin,
    };
  };

  const lookupOrigin = (name: string, frames: Frame[]): ParamOrigin => {
    for (let i = frames.length - 1; i >= 0; i--) {
      const hit = frames[i].params.get(name);
      if (hit) return hit.origin;
    }
    const g = globalParams.get(name);
    if (g) return g.origin;
    return { kind: 'unresolved', lineId: '', scopePath: frames[frames.length - 1]?.path ?? '@top' };
  };

  /** 实例化一个子电路定义（defChoices 保留重名候选；调用方负责候选分叉） */
  const instantiate = (
    def: SubcktDef,
    instancePath: string,
    portNodes: string[],
    frames: Frame[],
    lineId: string,
  ) => {
    ensureHier(instancePath, def.name, frames[frames.length - 1]?.path ?? null, lineId);
    const frame: Frame = {
      path: instancePath,
      subName: def.name,
      params: new Map(),
      nodeMap: new Map(),
    };
    // 子电路默认参数
    for (const d of parsed.paramDecls) {
      if (d.scopePath === `@subckt:${def.name}` && d.default) {
        frame.params.set(d.name, {
          rawExpr: d.rawExpr,
          origin: { kind: 'subckt-default', lineId: d.lineId, scopePath: instancePath },
        });
      }
    }
    // 端口绑定
    def.ports.forEach((p, i) => {
      frame.nodeMap.set(p, portNodes[i] ?? ensureNode(instancePath, `__floating_${p}`, false));
    });
    // 局部节点（来自子电路体内元件）按需创建
    const childFrames = [...frames, frame];
    processScopeLines(def, instancePath, frame, childFrames);
    return frame;
  };

  const processScopeLines = (
    def: SubcktDef | null,
    path: string,
    frame: Frame | null,
    frames: Frame[],
  ) => {
    const raws = def
      ? parsed.elements.filter((e) => e.scopePath === `@subckt:${def.name}`)
      : parsed.elements.filter((e) => e.scopePath === '@top');
    for (const raw of raws) {
      const toks = raw.tokens;
      const instLocal = toks[0];
      const childPath = path === '@top' ? instLocal : `${path}/${instLocal}`;
      if (raw.kindLetter === 'X') {
        emitSubInstance(toks, childPath, raw.lineId, frames, def?.name ?? null, frame);
      } else {
        emitDevice(toks, childPath, raw.lineId, frames, def, frame);
      }
    }
    if (frame) {
      const resolved: Record<string, ParamResolution> = {};
      for (const name of frame.params.keys()) resolved[name] = resolveParam(name, frames);
      scopeResolved.push({ scopePath: path, resolved });
    }
  };

  const emitSubInstance = (
    toks: string[], instancePath: string, lineId: string,
    frames: Frame[], parentSubName: string | null, parentFrame: Frame | null,
  ) => {
    // XNAME n1 n2 ... SUBMODEL <PARAMS: ...>
    const pi = toks.findIndex((t) => /^[a-zA-Z_][\w.]*$/.test(t) && subByName.has(t.toLowerCase()));
    // 更稳健：在非节点段找第一个命中的子电路名
    let subIdx = -1;
    for (let i = 1; i < toks.length; i++) {
      if (subByName.has(toks[i].toLowerCase())) { subIdx = i; break; }
    }
    void pi;
    if (subIdx < 0) {
      // 未知子电路：保留为 opaque 元件，不删除
      emitOpaque(toks, instancePath, lineId, frames, 'unknown-subckt', parentFrame);
      return;
    }
    const subName = toks[subIdx].toLowerCase();
    const nodeToks = toks.slice(1, subIdx).map((s) => s.toLowerCase());
    const defs = subByName.get(subName)!;
    const def0 = defs[0];
    const portNodes = nodeToks.map((n) => bindNode(n, frames, parentFrame));
    const frame = instantiateFrame(def0, instancePath, portNodes, frames, lineId, toks, subIdx, parentSubName);
    void frame;
    if (defs.length > 1) {
      diagnostics.push({
        code: 'subckt-collision-candidate', level: 'warn',
        message: `实例 ${instancePath} 命中重名子电路 ${subName} 的 ${defs.length} 个定义，已保留全部候选`,
        at: lineId,
      });
    }
  };

  const instantiateFrame = (
    def: SubcktDef, instancePath: string, portNodes: string[], frames: Frame[],
    lineId: string, toks: string[], subIdx: number, _parentSubName: string | null,
  ): Frame => {
    ensureHier(instancePath, def.name, frames[frames.length - 1]?.path ?? null, lineId);
    const frame: Frame = {
      path: instancePath, subName: def.name, params: new Map(), nodeMap: new Map(),
    };
    for (const d of parsed.paramDecls) {
      if (d.scopePath === `@subckt:${def.name}` && d.default) {
        frame.params.set(d.name, {
          rawExpr: d.rawExpr,
          origin: { kind: 'subckt-default', lineId: d.lineId, scopePath: instancePath },
        });
      }
    }
    def.ports.forEach((p, i) => {
      frame.nodeMap.set(p, portNodes[i] ?? ensureNode(instancePath, `__floating_${p}`, false));
    });
    // 实例参数覆盖（局部；不压平到默认/全局）
    const rest = toks.slice(subIdx + 1).join(' ');
    const { parseParamPairs } = requirePairs();
    for (const [pn, pe] of parseParamPairs(rest)) {
      frame.params.set(pn, {
        rawExpr: pe,
        origin: { kind: 'instance-override', lineId, scopePath: instancePath },
      });
    }
    const childFrames = [...frames, frame];
    processScopeLines(def, instancePath, frame, childFrames);
    return frame;
  };

  const bindNode = (local: string, frames: Frame[], frame: Frame | null): string => {
    if (parsed.globalNodes.includes(local) || local === '0') {
      return ensureNode('@global', local, true);
    }
    for (let i = frames.length - 1; i >= 0; i--) {
      const hit = frames[i].nodeMap.get(local);
      if (hit) return hit;
    }
    if (frame) {
      const id = ensureNode(frame.path, local, false);
      frame.nodeMap.set(local, id);
      return id;
    }
    return ensureNode('@top', local, false);
  };
