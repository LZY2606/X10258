// 依赖图：源对象（文件行/参数/model/include）-> 派生对象（flat/参数求值/报告）。
// 源变更后沿边传播，只把受影响派生标记 stale；未受影响结果保持有效并可解释原因。

export type NodeKind =
  | "raw-file"
  | "raw-line"
  | "raw-param"
  | "raw-model"
  | "include"
  | "subckt-def"
  | "flat-node"
  | "flat-element"
  | "flat-param"
  | "report"
  | "witness";

export interface DepNode {
  id: string;
  kind: NodeKind;
  label: string;
  /** 该节点当前派生结果所属版本（内容版本号）。 */
  version: number;
}

export interface DerivationRecord {
  id: string;
  outputId: string;
  inputIds: string[];
  /** 规则版本：规则升级时即便输入未变也要重算。 */
  ruleVersion: string;
  /** 派生时输入的内容版本快照。 */
  inputVersions: Record<string, number>;
  createdAtEventSeq: number;
}

export interface RecomputePlan {
  /** 必须重算的输出。 */
  staleOutputs: string[];
  /** 仍然有效的输出及原因。 */
  stillValid: { outputId: string; reason: string }[];
  /** 传播路径（source -> ... -> output），供 UI 来源链展示。 */
  paths: Record<string, string[][]>;
}

export class DependencyGraph {
  readonly nodes = new Map<string, DepNode>();
  /** input -> set(output) */
  private readonly forward = new Map<string, Set<string>>();
  private readonly records = new Map<string, DerivationRecord>();

  addNode(n: DepNode) {
    const existing = this.nodes.get(n.id);
    if (!existing) this.nodes.set(n.id, n);
    else existing.version = n.version;
  }

  bump(id: string): boolean {
    const n = this.nodes.get(id);
    if (!n) return false;
    n.version++;
    return true;
  }

  record(rec: DerivationRecord) {
    this.records.set(rec.id, rec);
    for (const input of rec.inputIds) {
      const s = this.forward.get(input) ?? new Set<string>();
      s.add(rec.outputId);
      this.forward.set(input, s);
    }
  }

  /** 从变更源集合出发传播，返回重算计划。 */
  planRecompute(changedSourceIds: string[], currentRuleVersion: string): RecomputePlan {
    const affected = new Set<string>();
    const paths: Record<string, string[][]> = {};
    const queue: { id: string; path: string[] }[] =
      changedSourceIds.map((id) => ({ id, path: [id] }));
    while (queue.length) {
      const { id, path } = queue.shift()!;
      const outs = this.forward.get(id);
      if (!outs) continue;
      for (const out of outs) {
        const newPath = [...path, out];
        if (!affected.has(out)) {
          affected.add(out);
          (paths[out] ??= []).push(newPath);
          queue.push({ id: out, path: newPath });
        } else {
          (paths[out] ??= []).push(newPath);
        }
      }
    }
    const staleOutputs = [...affected].filter((out) => this.needsRecompute(out, changedSourceIds, currentRuleVersion));
    const stillValid: RecomputePlan["stillValid"] = [];
    for (const rec of this.records.values()) {
      if (staleOutputs.includes(rec.outputId)) continue;
      if (affected.has(rec.outputId)) {
        // 传播到了但输入快照仍匹配（例如变更落在注释行）——保持有效
        stillValid.push({
          outputId: rec.outputId,
          reason: "reachable but unchanged effective input versions (e.g. comment/whitespace-only edit)"
        });
      } else {
        stillValid.push({
          outputId: rec.outputId,
          reason: "not reachable from any changed source along the dependency graph"
        });
      }
    }
    return { staleOutputs: [...new Set(staleOutputs)], stillValid, paths };
  }

  private needsRecompute(out: string, changed: string[], ruleVersion: string): boolean {
    const rec = [...this.records.values()].find((r) => r.outputId === out);
    if (!rec) return true;
    if (rec.ruleVersion !== ruleVersion) return true;
    for (const inputId of Object.keys(rec.inputVersions)) {
      const node = this.nodes.get(inputId);
      if (node && rec.inputVersions[inputId] !== node.version) return true;
    }
    void changed;
    return false;
  }

  derivationOf(outputId: string): DerivationRecord | undefined {
    return [...this.records.values()].find((r) => r.outputId === outputId);
  }

  inputsOf(outputId: string): string[] {
    const rec = this.derivationOf(outputId);
    return rec ? [...rec.inputIds] : [];
  }
}
