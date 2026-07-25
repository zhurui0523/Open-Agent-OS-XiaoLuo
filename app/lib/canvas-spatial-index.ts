import type { CanvasEdge, CanvasNode } from "../types";
import type { WorldBounds } from "./canvas-geometry";

const DEFAULT_CELL_SIZE = 512;
const NODE_WIDTH = 264;
const DEFAULT_NODE_HEIGHT = 220;

function keysFor(bounds: WorldBounds, cellSize: number) {
  const keys: string[] = [];
  const minX = Math.floor(bounds.minX / cellSize);
  const maxX = Math.floor(bounds.maxX / cellSize);
  const minY = Math.floor(bounds.minY / cellSize);
  const maxY = Math.floor(bounds.maxY / cellSize);
  for (let x = minX; x <= maxX; x += 1) {
    for (let y = minY; y <= maxY; y += 1) keys.push(`${x}:${y}`);
  }
  return keys;
}

function addToCells(
  cells: Map<string, Set<string>>,
  id: string,
  bounds: WorldBounds,
  cellSize: number,
) {
  for (const key of keysFor(bounds, cellSize)) {
    const bucket = cells.get(key) ?? new Set<string>();
    bucket.add(id);
    cells.set(key, bucket);
  }
}

export class CanvasSpatialIndex {
  private readonly nodeCells = new Map<string, Set<string>>();
  private readonly edgeCells = new Map<string, Set<string>>();
  private readonly cellSize: number;
  readonly nodeById: Map<string, CanvasNode>;
  readonly edgeById: Map<string, CanvasEdge>;

  constructor(
    nodes: CanvasNode[],
    edges: CanvasEdge[],
    nodeHeights: Record<string, number> = {},
    cellSize = DEFAULT_CELL_SIZE,
  ) {
    this.cellSize = cellSize;
    this.nodeById = new Map(nodes.map((node) => [node.id, node]));
    this.edgeById = new Map(edges.map((edge) => [edge.id, edge]));
    for (const node of nodes) {
      addToCells(
        this.nodeCells,
        node.id,
        {
          minX: node.x,
          minY: node.y,
          maxX: node.x + NODE_WIDTH,
          maxY: node.y + (nodeHeights[node.id] ?? DEFAULT_NODE_HEIGHT),
        },
        cellSize,
      );
    }
    for (const edge of edges) {
      const source = this.nodeById.get(edge.source);
      const target = this.nodeById.get(edge.target);
      if (!source || !target) continue;
      const sourceX = source.x + NODE_WIDTH;
      const sourceY = source.y + (nodeHeights[source.id] ?? DEFAULT_NODE_HEIGHT) / 2;
      const targetX = target.x;
      const targetY = target.y + (nodeHeights[target.id] ?? DEFAULT_NODE_HEIGHT) / 2;
      addToCells(
        this.edgeCells,
        edge.id,
        {
          minX: Math.min(sourceX, targetX) - 96,
          minY: Math.min(sourceY, targetY) - 96,
          maxX: Math.max(sourceX, targetX) + 96,
          maxY: Math.max(sourceY, targetY) + 96,
        },
        cellSize,
      );
    }
  }

  private query(cells: Map<string, Set<string>>, bounds: WorldBounds) {
    const result = new Set<string>();
    for (const key of keysFor(bounds, this.cellSize)) {
      for (const id of cells.get(key) ?? []) result.add(id);
    }
    return result;
  }

  queryNodeIds(bounds: WorldBounds) {
    return this.query(this.nodeCells, bounds);
  }

  queryEdgeIds(bounds: WorldBounds) {
    return this.query(this.edgeCells, bounds);
  }
}
