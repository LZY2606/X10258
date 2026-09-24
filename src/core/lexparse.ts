import { createHash } from 'node:crypto';
import { docId, logicalLineId } from './ids';
import type {
  BundleFile, RawFile, RawLine, ModelDef, SubcktDef, RawElement,
} from './types';
import type { Diagnostic } from './diagnostic';

export const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

export interface ParsedBundle {
  files: RawFile[];
  lines: RawLine[];
  includeEdges: {
    fromFileId: string; lineId: string; targetPath: string;
    targetFileId: string | null; cycle: string[] | null;
  }[];
  models: ModelDef[];
  subckts: SubcktDef[];
  elements: RawElement[];
  paramDecls: { scopePath: string; name: string; rawExpr: string; lineId: string; default?: boolean }[];
  globalNodes: string[];
  diagnostics: Diagnostic[];
}

const CONT = /^\s*\+/;
const isBlank = (s: string) => s.trim() === '';
const isComment = (s: string) => /^\s*\*/.test(s) || /^\s*\$/.test(s);

/** 逻辑行合并：以 + 开头的物理行续接到上一逻辑行（原文本逐字保留，物理行可回溯） */
export function splitLogicalLines(file: RawFile): RawLine[] {
  const physical = file.content.split('\n');
  const out: RawLine[] = [];
  let cur: { parts: string[]; phys: RawLine['physicalLines'] } | null = null;
  const flush = () => {
    if (!cur) return;
    out.push({
      id: logicalLineId(file.id, out.length),
      fileId: file.id,
      ordinal: out.length,
      text: cur.parts.join('\n'),
      physicalLines: cur.phys,
    });
    cur = null;
  };
  physical.forEach((text, ordinal) => {
    if (CONT.test(text) && cur) {
      cur.parts.push(text.replace(/^\s*\+/, ' '));
      cur.phys.push({ fileId: file.id, ordinal, text });
    } else {
      flush();
      if (isBlank(text) || isComment(text)) return;
      cur = { parts: [text], phys: [{ fileId: file.id, ordinal, text }] };
    }
  });
  flush();
  return out;
}

const stripInlineComment = (s: string): string => {
  const i = s.indexOf(';');
  return i >= 0 ? s.slice(0, i) : s;
};

export const tokenize = (lineText: string): string[] =>
  stripInlineComment(lineText).trim().split(/\s+/).filter(Boolean);

const MODEL_KIND: Record<string, ModelDef['kind']> = {
  r: 'resistor', c: 'capacitor', l: 'inductor',
  nmos: 'mosfet', pmos: 'mosfet',
  npn: 'bjt', pnp: 'bjt', d: 'diode',
  v: 'voltage', i: 'current',
};

export function parseParamPairs(s: string): [string, string][] {
  const out: [string, string][] = [];
  const re = /([a-zA-Z_][a-zA-Z0-9_.]*)\s*=\s*(\{[^{}]*\}|"[^"]*"|\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    out.push([m[1].toLowerCase(), m[2].replace(/^\{|\}$/g, '').replace(/^"|"$/g, '')]);
  }
  return out;
}

export function parseBundle(
  branch: string,
  revisionId: string,
  inputs: BundleFile[],
): ParsedBundle {
  const files: RawFile[] = inputs.map((f) => ({
    id: docId(revisionId, f.path, f.content),
    revisionId, path: f.path, content: f.content,
  }));
  const fileById = new Map(files.map((f) => [f.id, f]));
  const fileIdByPath = new Map<string, string>();
  for (const f of files) {
    fileIdByPath.set(f.path, f.id);
    fileIdByPath.set(basename(f.path), f.id);
  }
  const linesByFile = new Map(files.map((f) => [f.id, splitLogicalLines(f)]));

  const includeEdges: ParsedBundle['includeEdges'] = [];
  const diagnostics: Diagnostic[] = [];

  // —— 第一遍：include 解析（含循环检测），确定文件展开顺序 ——
  const orderedFileIds: string[] = [];
  const visited = new Set<string>();
  const resolveIncludeTarget = (toks: string[], head: string): string => {
    let target = toks[1] ?? '';
    if (head === '.lib') {
      // .lib <file> [<section>]；无 = 的两段式时取第一段
      if (toks.length >= 2 && toks[1]) target = toks[1];
    }
    return target.replace(/^["'<]|["'>]$/g, '');
  };
  const walk = (fid: string, chain: string[]) => {
    if (visited.has(fid) || chain.includes(fid)) return;
    const nextChain = [...chain, fid];
    orderedFileIds.push(fid);
    for (const ln of linesByFile.get(fid)!) {
      const toks = tokenize(ln.text);
      const head = (toks[0] ?? '').toLowerCase();
      if (head !== '.include' && head !== '.inc' && head !== '.lib' && head !== '.library') continue;
      const target = resolveIncludeTarget(toks, head);
      const childId = fileIdByPath.get(target) ?? null;
      let cycle: string[] | null = null;
      if (!childId) {
        diagnostics.push({ code: 'include-missing', level: 'error', message: `include 未在集合中找到: ${target}`, at: ln.id });
      } else if (nextChain.includes(childId)) {
        cycle = [...nextChain.slice(nextChain.indexOf(childId)), childId];
        diagnostics.push({
          code: 'include-cycle', level: 'warn',
          message: `循环 include 已阻断: ${cycle.map((x) => fileById.get(x)?.path).join(' -> ')}`,
          at: ln.id,
        });
      }
      includeEdges.push({ fromFileId: fid, lineId: ln.id, targetPath: target, targetFileId: childId, cycle });
      if (childId && !cycle) walk(childId, nextChain);
    }
    visited.add(fid);
  };
  for (const f of files) walk(f.id, []);

  // —— 第二遍：按展开顺序抽取 model/subckt/element/param ——
  const models: ModelDef[] = [];
  const subckts: SubcktDef[] = [];
  const elements: RawElement[] = [];
  const paramDecls: ParsedBundle['paramDecls'] = [];
  const globalNodes: string[] = [];
  const modelSeen = new Map<string, ModelDef[]>();
  const subcktSeen = new Map<string, SubcktDef[]>();

  for (const fid of orderedFileIds) {
    let active: { name: string; ports: string[]; body: string[]; ids: string[] } | null = null;
    for (const ln of linesByFile.get(fid)!) {
      const toks = tokenize(ln.text);
      const head = (toks[0] ?? '').toLowerCase();

      if (active) {
        active.body.push(ln.text);
        active.ids.push(ln.id);
        if (head === '.ends') {
          const bodySha = sha(active.body.join('\n'));
          const def: SubcktDef = {
            id: `sx:${branch}:${active.name}:${bodySha.slice(0, 16)}`,
            branch, name: active.name, ports: active.ports,
            bodyLines: active.body, bodySha,
            lineIds: active.ids, endsLineId: ln.id,
          };
          subckts.push(def);
          (subcktSeen.get(active.name) ?? subcktSeen.set(active.name, []).get(active.name)!).push(def);
          active = null;
        } else if (head === '.param' || head === '.parameters' || head === '.par') {
          for (const [pn, pe] of parseParamPairs(toks.slice(1).join(' '))) {
            paramDecls.push({ scopePath: `@subckt:${active.name}`, name: pn, rawExpr: pe, lineId: ln.id, default: true });
          }
        } else if (head === 'x' || /^x/i.test(toks[0] ?? '')) {
          collectSubElement(active.name, ln, toks, elements, paramDecls);
        } else if (toks.length > 0 && /^[a-zA-Z]/.test(toks[0][0])) {
          collectSubElement(active.name, ln, toks, elements, paramDecls);
        }
        continue;
      }

      if (head === '.subckt') {
        const name = (toks[1] ?? '').toLowerCase();
        if (!name) {
          diagnostics.push({ code: 'subckt-no-name', level: 'error', message: '.subckt 缺少名称', at: ln.id });
          continue;
        }
        const rest = toks.slice(2);
        const paramIdx = rest.findIndex((t) => /^params?\s*:/i.test(t));
        const ports = (paramIdx >= 0 ? rest.slice(0, paramIdx) : rest).map((s) => s.toLowerCase());
        active = { name, ports, body: [ln.text], ids: [ln.id] };
        if (paramIdx >= 0) {
          for (const [pn, pe] of parseParamPairs(rest.slice(paramIdx).join(' ').replace(/^params?\s*:\s*/i, ''))) {
            paramDecls.push({ scopePath: `@subckt:${name}`, name: pn, rawExpr: pe, lineId: ln.id, default: true });
          }
        }
        continue;
      }

      if (head === '.model') {
        const name = (toks[1] ?? '').toLowerCase();
        const kindTok = (toks[2] ?? '').toLowerCase();
        const bodySha = sha(ln.text);
        const params = toks.slice(3)
          .filter((t) => t.includes('='))
          .map((kv) => {
            const eq = kv.indexOf('=');
            return { raw: kv, value: kv.slice(eq + 1) };
          });
        const levelRaw = params.find((p) => p.raw.toLowerCase().startsWith('level='));
        const def: ModelDef = {
          id: `md:${branch}:${name}:${bodySha.slice(0, 16)}`,
          branch, name,
          kind: MODEL_KIND[kindTok] ?? 'unknown',
          level: levelRaw ? levelRaw.value : null,
          params, bodyText: ln.text, bodySha, lineIds: [ln.id],
        };
        models.push(def);
        (modelSeen.get(name) ?? modelSeen.set(name, []).get(name)!).push(def);
        continue;
      }

      if (head === '.param' || head === '.parameters' || head === '.par') {
        for (const [pn, pe] of parseParamPairs(toks.slice(1).join(' '))) {
          paramDecls.push({ scopePath: '@global', name: pn, rawExpr: pe, lineId: ln.id });
        }
        continue;
      }

      if (head === '.global' || head === '.global_node') {
        for (const n of toks.slice(1)) globalNodes.push(n.toLowerCase());
        continue;
      }

      if (head.startsWith('.')) continue; // 其它点控指令保留原文（仍在 lines 中可回溯）

      if (toks.length > 0 && /^[a-zA-Z][a-zA-Z0-9_$]*$/.test(toks[0])) {
        elements.push({
          kindLetter: toks[0][0].toUpperCase(),
          instanceName: toks[0], tokens: toks, lineId: ln.id, scopePath: '@top',
        });
      }
    }
    if (active) {
      diagnostics.push({ code: 'subckt-unclosed', level: 'error', message: `.subckt ${active.name} 缺少 .ends`, at: active.ids[0] });
    }
  }

  for (const [name, defs] of subcktSeen) {
    if (new Set(defs.map((d) => d.bodySha)).size > 1) {
      diagnostics.push({
        code: 'subckt-collision', level: 'warn',
        message: `子电路重名且定义不一致: ${name}（${defs.length} 个定义全部保留为候选）`,
        at: defs[0].lineIds[0],
      });
    }
  }
  for (const [name, defs] of modelSeen) {
    if (new Set(defs.map((d) => d.bodySha)).size > 1) {
      diagnostics.push({
        code: 'model-version', level: 'warn',
        message: `model 多版本: ${name}（${defs.map((d) => `level=${d.level ?? '?'}`).join(', ')}）`,
        at: defs[0].lineIds[0],
      });
    }
  }
  if (inputs.length !== new Set(orderedFileIds).size) {
    diagnostics.push({ code: 'include-orphan', level: 'info', message: '部分输入文件未从 include 图到达（仍原样保留）' });
  }

  return {
    files,
    lines: orderedFileIds.flatMap((fid) => linesByFile.get(fid)!),
    includeEdges, models, subckts, elements, paramDecls, globalNodes, diagnostics,
  };
}

function collectSubElement(
  subName: string,
  ln: RawLine,
  toks: string[],
  elements: RawElement[],
  paramDecls: ParsedBundle['paramDecls'],
) {
  const scopePath = `@subckt:${subName}`;
  elements.push({
    kindLetter: toks[0][0].toUpperCase(),
    instanceName: toks[0], tokens: toks, lineId: ln.id, scopePath,
  });
  const pi = toks.findIndex((t) => /^params?\s*:/i.test(t));
  if (pi >= 0) {
    for (const [pn, pe] of parseParamPairs(toks.slice(pi).join(' ').replace(/^params?\s*:\s*/i, ''))) {
      paramDecls.push({ scopePath: `${scopePath}:${toks[0]}`, name: pn, rawExpr: pe, lineId: ln.id });
    }
  }
}

const basename = (p: string) => p.split(/[/\\]/).pop() ?? p;
