import type {
  ResultSetHeader,
  RowDataPacket,
} from "mysql2/promise";
import type { CanvasEdge, CanvasNode, KernelNodeOutput } from "../types";
import { mysqlTransaction } from "./mysql";
import { roleForNode } from "./node-role";

type PersistedKernelNodeOutput = KernelNodeOutput & { result?: string };

interface CanvasRevisionRow extends RowDataPacket {
  revision: number;
}

interface PersistenceMarkerRow extends RowDataPacket {
  id: string;
}

export interface KernelRunCanvasTask {
  nodeId: string;
  status: string;
  outputJson: string | null;
  executor: string | null;
  error: string | null;
}

interface RuntimeGraph {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

function parseRuntimeGraph(graphJson: string): RuntimeGraph {
  const parsed = JSON.parse(graphJson) as Partial<RuntimeGraph>;
  return {
    nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
    edges: Array.isArray(parsed.edges) ? parsed.edges : [],
  };
}

function parseTaskOutput(outputJson: string | null) {
  if (!outputJson) return null;
  try {
    return JSON.parse(outputJson) as PersistedKernelNodeOutput;
  } catch {
    return null;
  }
}

function outputResult(output: PersistedKernelNodeOutput | null) {
  if (typeof output?.result === "string" && output.result.trim()) {
    return output.result.trim();
  }
  if (typeof output?.text === "string" && output.text.trim()) {
    return output.text.trim();
  }
  return undefined;
}

export function materializeKernelRunResultGraph(input: {
  runId: string;
  graphJson: string;
  tasks: KernelRunCanvasTask[];
}) {
  const graph = parseRuntimeGraph(input.graphJson);
  const taskMap = new Map(input.tasks.map((task) => [task.nodeId, task]));
  const nodes = graph.nodes.flatMap((node) => {
    if (roleForNode(node) !== "result") return [];
    const task = taskMap.get(node.id);
    if (!task) return [];
    const output = parseTaskOutput(task.outputJson);
    const parameters = {
      ...node.parameters,
      kernelRunId: input.runId,
      ...(output ? { kernelOutput: output } : {}),
      ...(task.executor ? { kernelExecutor: task.executor } : {}),
    };
    const result =
      outputResult(output) ??
      (task.error ? `执行失败：${task.error}` : node.result);
    return [
      {
        ...node,
        status: task.status as CanvasNode["status"],
        progress: ["succeeded", "failed", "skipped", "canceled"].includes(
          task.status,
        )
          ? 100
          : (node.progress ?? 0),
        ...(result ? { result } : {}),
        parameters,
      },
    ];
  });
  const resultIds = new Set(nodes.map((node) => node.id));
  const edges = graph.edges.filter((edge) => resultIds.has(edge.target));
  return { nodes, edges };
}

/**
 * Persists terminal result nodes independently from the browser autosave.
 *
 * The marker makes this a one-time merge: if a user later deletes a result
 * asset, merely reading the historical run must not recreate it.
 */
export async function persistKernelRunResultGraph(input: {
  runId: string;
  canvasId: string;
  graphJson: string;
  tasks: KernelRunCanvasTask[];
}) {
  const resultGraph = materializeKernelRunResultGraph(input);
  return mysqlTransaction(async (connection) => {
    const [canvasRows] = await connection.execute<CanvasRevisionRow[]>(
      `SELECT revision
       FROM xiaoluo_v2_canvases
       WHERE id = ? AND deleted_at IS NULL
       FOR UPDATE`,
      [input.canvasId],
    );
    const canvas = canvasRows[0];
    if (!canvas) return null;

    const [markers] = await connection.execute<PersistenceMarkerRow[]>(
      `SELECT id
       FROM xiaoluo_v2_run_events
       WHERE run_id = ? AND event_type = 'run.canvas_results_persisted'
       LIMIT 1`,
      [input.runId],
    );
    if (markers.length) return Number(canvas.revision);

    let changed = false;
    for (const node of resultGraph.nodes) {
      const [saved] = await connection.execute<ResultSetHeader>(
        `INSERT INTO xiaoluo_v2_canvas_nodes (
           id, canvas_id, kind, node_role, title, prompt, status,
           capability_id, model_id, x, y, progress, result,
           parameters_json, client_created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           status = VALUES(status),
           progress = VALUES(progress),
           result = VALUES(result),
           parameters_json = VALUES(parameters_json)`,
        [
          node.id,
          input.canvasId,
          node.kind,
          node.role ?? "result",
          node.title,
          node.prompt,
          node.status,
          node.capabilityId,
          node.modelId,
          node.x,
          node.y,
          node.progress ?? null,
          node.result ?? null,
          JSON.stringify(node.parameters ?? {}),
          node.createdAt ?? null,
        ],
      );
      changed ||= saved.affectedRows > 0;
    }

    for (const edge of resultGraph.edges) {
      const [saved] = await connection.execute<ResultSetHeader>(
        `INSERT INTO xiaoluo_v2_canvas_edges (
           id, canvas_id, source_node_id, target_node_id,
           source_port_id, target_port_id, data_type
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           source_node_id = VALUES(source_node_id),
           target_node_id = VALUES(target_node_id),
           source_port_id = VALUES(source_port_id),
           target_port_id = VALUES(target_port_id),
           data_type = VALUES(data_type)`,
        [
          edge.id,
          input.canvasId,
          edge.source,
          edge.target,
          edge.sourcePort,
          edge.targetPort,
          edge.dataType,
        ],
      );
      changed ||= saved.affectedRows > 0;
    }

    const nextRevision = Number(canvas.revision) + (changed ? 1 : 0);
    if (changed) {
      await connection.execute(
        `UPDATE xiaoluo_v2_canvases
         SET revision = ?, updated_at = CURRENT_TIMESTAMP(3)
         WHERE id = ?`,
        [nextRevision, input.canvasId],
      );
    }
    await connection.execute(
      `INSERT INTO xiaoluo_v2_run_events (
         id, run_id, event_type, node_id, payload_json, created_at
       ) VALUES (?, ?, 'run.canvas_results_persisted', NULL, ?, CURRENT_TIMESTAMP(3))`,
      [
        `event_${crypto.randomUUID()}`,
        input.runId,
        JSON.stringify({
          canvasId: input.canvasId,
          nodes: resultGraph.nodes.map((node) => node.id),
          changed,
          revision: nextRevision,
        }),
      ],
    );
    return nextRevision;
  });
}
