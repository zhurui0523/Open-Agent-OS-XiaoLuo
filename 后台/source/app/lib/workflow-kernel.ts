import type { CanvasEdge, CanvasNode } from "../types";

export interface CompiledWorkflow {
  levels: string[][];
  dependencies: Record<string, string[]>;
  dependents: Record<string, string[]>;
}

export class WorkflowCompileError extends Error {
  readonly code:
    | "EMPTY_WORKFLOW"
    | "INVALID_EDGE"
    | "SELF_REFERENCE"
    | "DUPLICATE_EDGE"
    | "CYCLE_DETECTED";

  constructor(
    code: WorkflowCompileError["code"],
    message: string,
  ) {
    super(message);
    this.name = "WorkflowCompileError";
    this.code = code;
  }
}

export function compileWorkflow(
  nodes: Pick<CanvasNode, "id">[],
  edges: CanvasEdge[],
): CompiledWorkflow {
  if (!nodes.length) {
    throw new WorkflowCompileError("EMPTY_WORKFLOW", "画布中没有可执行节点");
  }

  const nodeIds = new Set(nodes.map((node) => node.id));
  const dependencies: Record<string, string[]> = {};
  const dependents: Record<string, string[]> = {};
  const seenEdges = new Set<string>();
  nodes.forEach((node) => {
    dependencies[node.id] = [];
    dependents[node.id] = [];
  });

  edges.forEach((edge) => {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
      throw new WorkflowCompileError(
        "INVALID_EDGE",
        `连线 ${edge.id} 引用了不存在的节点`,
      );
    }
    if (edge.source === edge.target) {
      throw new WorkflowCompileError(
        "SELF_REFERENCE",
        `节点 ${edge.source} 不能连接自身`,
      );
    }
    const key = `${edge.source}\u0000${edge.target}`;
    if (seenEdges.has(key)) {
      throw new WorkflowCompileError(
        "DUPLICATE_EDGE",
        `节点 ${edge.source} 到 ${edge.target} 存在重复连线`,
      );
    }
    seenEdges.add(key);
    dependencies[edge.target].push(edge.source);
    dependents[edge.source].push(edge.target);
  });

  const remainingDependencies = new Map(
    Object.entries(dependencies).map(([id, incoming]) => [id, incoming.length]),
  );
  let ready = nodes
    .map((node) => node.id)
    .filter((id) => remainingDependencies.get(id) === 0);
  const levels: string[][] = [];
  let visited = 0;

  while (ready.length) {
    const level = [...ready];
    levels.push(level);
    visited += level.length;
    const next: string[] = [];
    level.forEach((id) => {
      dependents[id].forEach((targetId) => {
        const remaining = (remainingDependencies.get(targetId) ?? 0) - 1;
        remainingDependencies.set(targetId, remaining);
        if (remaining === 0) next.push(targetId);
      });
    });
    ready = next;
  }

  if (visited !== nodes.length) {
    throw new WorkflowCompileError(
      "CYCLE_DETECTED",
      "工作流存在循环依赖，请删除形成闭环的连线",
    );
  }

  return { levels, dependencies, dependents };
}

export function wouldCreateCycle(
  nodes: Pick<CanvasNode, "id">[],
  edges: CanvasEdge[],
  source: string,
  target: string,
) {
  if (source === target) return true;
  const dependents = new Map<string, string[]>(
    nodes.map((node) => [node.id, []]),
  );
  edges.forEach((edge) => {
    dependents.get(edge.source)?.push(edge.target);
  });
  const pending = [target];
  const visited = new Set<string>();
  while (pending.length) {
    const current = pending.pop() as string;
    if (current === source) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    pending.push(...(dependents.get(current) ?? []));
  }
  return false;
}

export function upstreamResults(
  nodeId: string,
  workflow: CompiledWorkflow,
  outputs: Map<string, unknown>,
) {
  return workflow.dependencies[nodeId].map((sourceId) => ({
    nodeId: sourceId,
    output: outputs.get(sourceId) ?? null,
  }));
}
