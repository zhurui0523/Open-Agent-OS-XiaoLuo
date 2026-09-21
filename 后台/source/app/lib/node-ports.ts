import type {
  CanvasEdge,
  CanvasNode,
  NodePort,
  PortDataType,
} from "../types";
import { roleForNode } from "./node-role.ts";
import { normalizeModelInputConstraints } from "./model-input-constraints.ts";

const REFERENCE_ASSET_TYPES: PortDataType[] = [
  "image",
  "video",
  "audio",
  "document",
];

const PLUGIN_REFERENCE_TYPES: PortDataType[] = [
  "image",
  "video",
  "audio",
  "document",
  "asset",
  "asset_list",
  "collection",
];

export const DEFAULT_NODE_PORTS: Record<CanvasNode["kind"], NodePort[]> = {
  text: [
    {
      id: "context",
      label: "上下文",
      direction: "input",
      dataTypes: ["text", "document", "json"],
    },
    {
      id: "reference",
      label: "参考素材",
      direction: "input",
      dataTypes: [...REFERENCE_ASSET_TYPES],
    },
    {
      id: "text",
      label: "文本",
      direction: "output",
      dataTypes: ["text"],
    },
  ],
  image: [
    {
      id: "prompt",
      label: "提示词",
      direction: "input",
      dataTypes: ["text", "document", "json"],
    },
    {
      id: "reference",
      label: "参考素材",
      direction: "input",
      dataTypes: [...REFERENCE_ASSET_TYPES],
    },
    {
      id: "image",
      label: "图像",
      direction: "output",
      dataTypes: ["image"],
    },
  ],
  video: [
    {
      id: "prompt",
      label: "提示词",
      direction: "input",
      dataTypes: ["text", "document", "json"],
    },
    {
      id: "reference",
      label: "参考素材",
      direction: "input",
      dataTypes: [...REFERENCE_ASSET_TYPES],
    },
    {
      id: "video",
      label: "视频",
      direction: "output",
      dataTypes: ["video"],
    },
  ],
  audio: [
    {
      id: "prompt",
      label: "提示词",
      direction: "input",
      dataTypes: ["text", "document", "json"],
    },
    {
      id: "reference",
      label: "参考素材",
      direction: "input",
      dataTypes: [...REFERENCE_ASSET_TYPES],
    },
    {
      id: "audio",
      label: "音频",
      direction: "output",
      dataTypes: ["audio"],
    },
  ],
  document: [
    {
      id: "content",
      label: "内容",
      direction: "input",
      dataTypes: ["text", "image", "document", "json"],
    },
    {
      id: "document",
      label: "文档",
      direction: "output",
      dataTypes: ["document"],
    },
  ],
};

type PortAwareNode = Pick<CanvasNode, "kind"> &
  Partial<Pick<CanvasNode, "role" | "parameters">>;

const ALL_CONTENT_TYPES: PortDataType[] = [
  "text",
  "image",
  "video",
  "audio",
  "document",
  "json",
  "asset",
  "asset_list",
  "collection",
];

function rolePorts(
  node: PortAwareNode,
  hasSnapshotPorts = false,
): NodePort[] | null {
  const role = roleForNode(node);
  if (role === "material") {
    return [
      {
        id: "material_input",
        label: "素材输入",
        direction: "input",
        dataTypes: ["image", "video", "audio", "document", "asset"],
        cardinality: "many",
      },
      {
        id: "material",
        label: "素材",
        direction: "output",
        dataTypes: [node.kind, "asset"],
        cardinality: "many",
      },
    ];
  }
  if (role === "plugin") {
    if (hasSnapshotPorts) return null;
    return [
      {
        id: "prompt",
        label: "文本",
        direction: "input",
        dataTypes: ["text"],
        cardinality: "many",
      },
      {
        id: "materials",
        label: "多媒体参考",
        direction: "input",
        dataTypes: [...PLUGIN_REFERENCE_TYPES],
        cardinality: "many",
      },
      {
        id: "plugin_output",
        label: "插件结果",
        direction: "output",
        dataTypes: ALL_CONTENT_TYPES,
        cardinality: "many",
      },
    ];
  }
  if (role === "result") {
    return [
      {
        id: "result",
        label: "结果",
        direction: "input",
        dataTypes: ALL_CONTENT_TYPES,
        required: true,
        cardinality: "one",
        maxConnections: 1,
      },
      {
        id: "result_output",
        label: "结果输出",
        direction: "output",
        dataTypes: [node.kind],
        cardinality: "many",
      },
    ];
  }
  return null;
}

function snapshotPorts(node: PortAwareNode) {
  const snapshot = node.parameters?.capabilitySnapshot;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return [];
  }
  const ports = (snapshot as { ports?: unknown }).ports;
  if (!Array.isArray(ports)) return [];
  return ports.filter((port): port is NodePort => {
    if (!port || typeof port !== "object" || Array.isArray(port)) return false;
    const candidate = port as Partial<NodePort>;
    return (
      typeof candidate.id === "string" &&
      typeof candidate.label === "string" &&
      (candidate.direction === "input" || candidate.direction === "output") &&
      Array.isArray(candidate.dataTypes) &&
      candidate.dataTypes.length > 0
    );
  });
}

function withReferenceAssetPort(node: PortAwareNode, ports: NodePort[]) {
  if (roleForNode(node) !== "execution" || node.kind === "document") {
    return ports;
  }

  // 仅音乐节点：默认不提供参考素材端口（连线随端口失效而不再渲染），约束快照明确支持时才保留；其他节点不受影响
  const snapshot = node.parameters?.inputConstraints;
  const referenceAllowed =
    Boolean(snapshot) &&
    typeof snapshot === "object" &&
    !Array.isArray(snapshot) &&
    normalizeModelInputConstraints(snapshot, node.kind).maxTotal > 0;
  if (node.kind === "audio" && !referenceAllowed) {
    return ports.filter(
      (port) => !(port.direction === "input" && port.id === "reference"),
    );
  }

  if (
    ports.some(
      (port) => port.direction === "input" && port.id === "reference",
    )
  ) {
    return ports;
  }

  const referencePort: NodePort = {
    id: "reference",
    label: "参考素材",
    direction: "input",
    dataTypes: [...REFERENCE_ASSET_TYPES],
    cardinality: "many",
  };
  const firstOutput = ports.findIndex((port) => port.direction === "output");
  if (firstOutput < 0) return [...ports, referencePort];
  return [
    ...ports.slice(0, firstOutput),
    referencePort,
    ...ports.slice(firstOutput),
  ];
}

/**
 * Every canvas plugin exposes two stable inputs even when the package ships
 * its own capability port snapshot: blue `prompt` for text and green
 * `materials` for image/video/audio/document references. Package-defined
 * ports remain intact and legacy `materials`/`reference` edges keep working.
 */
function withPluginReferencePort(
  node: PortAwareNode,
  ports: NodePort[],
): NodePort[] {
  if (roleForNode(node) !== "plugin") return ports;

  let resolved = ports.map((port) =>
    port.direction === "input" &&
    (port.id === "materials" || port.id === "reference")
      ? {
          ...port,
          label: "多媒体参考",
          dataTypes: [...PLUGIN_REFERENCE_TYPES],
          cardinality: "many" as const,
          maxConnections: undefined,
        }
      : port,
  );

  const hasTextInput = resolved.some(
    (port) =>
      port.direction === "input" &&
      port.dataTypes.includes("text"),
  );
  const hasReferenceInput = resolved.some(
    (port) =>
      port.direction === "input" &&
      (port.id === "materials" || port.id === "reference"),
  );
  const additions: NodePort[] = [];
  if (!hasTextInput) {
    additions.push({
      id: resolved.some((port) => port.id === "prompt")
        ? "plugin_text"
        : "prompt",
      label: "文本",
      direction: "input",
      dataTypes: ["text"],
      cardinality: "many",
    });
  }
  if (!hasReferenceInput) {
    additions.push({
      id: "materials",
      label: "多媒体参考",
      direction: "input",
      dataTypes: [...PLUGIN_REFERENCE_TYPES],
      cardinality: "many",
    });
  }
  if (!additions.length) return resolved;

  const firstOutput = resolved.findIndex(
    (port) => port.direction === "output",
  );
  if (firstOutput < 0) return [...resolved, ...additions];
  resolved = [
    ...resolved.slice(0, firstOutput),
    ...additions,
    ...resolved.slice(firstOutput),
  ];
  return resolved;
}

export function portsForNode(
  node: PortAwareNode,
  direction?: NodePort["direction"],
) {
  const ports = snapshotPorts(node);
  const resolved =
    rolePorts(node, ports.length > 0) ??
    (ports.length
      ? ports.map((port) =>
          port.direction === "input"
            ? { ...port, cardinality: port.cardinality ?? "many" }
            : port,
        )
      : DEFAULT_NODE_PORTS[node.kind].map((port) =>
          port.direction === "input"
            ? { ...port, cardinality: port.cardinality ?? "many" }
            : port,
        ));
  const withPluginReferences = withPluginReferencePort(node, resolved);
  const withReferences = withReferenceAssetPort(node, withPluginReferences);
  return direction
    ? withReferences.filter((port) => port.direction === direction)
    : withReferences;
}

export function portForNode(
  node: PortAwareNode,
  portId: string,
  direction: NodePort["direction"],
) {
  return portsForNode(node, direction).find((port) => port.id === portId);
}

export function defaultOutputPort(node: PortAwareNode) {
  return portsForNode(node, "output")[0];
}

export function compatibleInputPorts(
  node: PortAwareNode,
  outputType: PortDataType,
) {
  return portsForNode(node, "input").filter((port) =>
    port.dataTypes.includes(outputType),
  );
}

export function resolveEdgePorts(
  edge: Pick<
    CanvasEdge,
    "sourcePort" | "targetPort" | "dataType"
  >,
  source: PortAwareNode,
  target: PortAwareNode,
) {
  const sourcePort =
    portForNode(source, edge.sourcePort, "output") ??
    defaultOutputPort(source);
  const explicitTargetPort = edge.targetPort
    ? portForNode(target, edge.targetPort, "input")
    : undefined;
  // 显式指定的端口已不存在（如模型不再支持参考素材）：不静默改道到其他端口
  if (edge.targetPort && !explicitTargetPort) {
    return { sourcePort, targetPort: undefined, dataType: edge.dataType };
  }
  const targetPort =
    explicitTargetPort ??
    compatibleInputPorts(target, edge.dataType ?? sourcePort.dataTypes[0])[0];
  const dataType =
    edge.dataType ??
    sourcePort.dataTypes.find((type) => targetPort?.dataTypes.includes(type));
  return { sourcePort, targetPort, dataType };
}

export function normalizeEdgePorts(
  edge: Pick<CanvasEdge, "id" | "source" | "target"> &
    Partial<Pick<CanvasEdge, "sourcePort" | "targetPort" | "dataType">>,
  source: PortAwareNode,
  target: PortAwareNode,
): CanvasEdge {
  const sourcePort =
    (edge.sourcePort &&
      portForNode(source, edge.sourcePort, "output")) ||
    defaultOutputPort(source);
  const preferredType =
    edge.dataType && sourcePort.dataTypes.includes(edge.dataType)
      ? edge.dataType
      : sourcePort.dataTypes[0];
  const targetPort =
    (edge.targetPort &&
      portForNode(target, edge.targetPort, "input")) ||
    compatibleInputPorts(target, preferredType)[0];
  const dataType =
    sourcePort.dataTypes.find((type) => targetPort?.dataTypes.includes(type)) ??
    preferredType;
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourcePort: sourcePort.id,
    targetPort: targetPort?.id ?? portsForNode(target, "input")[0]?.id ?? "input",
    dataType,
  };
}

/**
 * Removes legacy or otherwise invalid edges before a canvas is rendered or
 * persisted. Result nodes are valid intermediate workflow steps again, while
 * stale edges that reference unknown ports still need to be discarded.
 */
export function sanitizeCanvasEdges(
  nodes: Array<PortAwareNode & { id: string }>,
  edges: CanvasEdge[],
) {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const sanitized: CanvasEdge[] = [];

  for (const edge of edges) {
    const source = nodesById.get(edge.source);
    const target = nodesById.get(edge.target);
    if (!source || !target) continue;

    // An explicit but unknown port is a stale edge. Do not silently redirect
    // it to another port because that could change the workflow's meaning.
    const sourcePort = edge.sourcePort
      ? portForNode(source, edge.sourcePort, "output")
      : defaultOutputPort(source);
    if (!sourcePort) continue;

    let targetPort = edge.targetPort
      ? portForNode(target, edge.targetPort, "input")
      : compatibleInputPorts(
          target,
          edge.dataType ?? sourcePort.dataTypes[0],
        )[0];
    // Before plugin inputs were split, text and media references both used
    // `materials`. Preserve those canvases by moving legacy text edges to the
    // new blue text input instead of silently dropping them during hydration.
    if (
      roleForNode(target) === "plugin" &&
      edge.dataType === "text" &&
      (edge.targetPort === "materials" || edge.targetPort === "reference") &&
      targetPort &&
      !targetPort.dataTypes.includes("text")
    ) {
      targetPort = compatibleInputPorts(target, "text")[0];
    }
    if (!targetPort) continue;

    const dataType =
      edge.dataType &&
      sourcePort.dataTypes.includes(edge.dataType) &&
      targetPort.dataTypes.includes(edge.dataType)
        ? edge.dataType
        : sourcePort.dataTypes.find((type) =>
            targetPort.dataTypes.includes(type),
          );
    if (!dataType) continue;

    const candidate: CanvasEdge = {
      ...edge,
      sourcePort: sourcePort.id,
      targetPort: targetPort.id,
      dataType,
    };
    if (validateEdgePorts(candidate, source, target)) continue;
    if (validatePortCardinality(candidate, sanitized, target)) continue;
    sanitized.push(candidate);
  }

  return sanitized;
}

export function validateEdgePorts(
  edge: CanvasEdge,
  source: PortAwareNode,
  target: PortAwareNode,
) {
  const sourcePort = portForNode(source, edge.sourcePort, "output");
  if (!sourcePort) return "来源端口不存在";
  const targetPort = portForNode(target, edge.targetPort, "input");
  if (!targetPort) return "目标端口不存在";
  if (!sourcePort.dataTypes.includes(edge.dataType)) {
    return `来源端口不能输出 ${edge.dataType}`;
  }
  if (!targetPort.dataTypes.includes(edge.dataType)) {
    return `${targetPort.label} 不能接收 ${edge.dataType}`;
  }
  return null;
}

export function validatePortCardinality(
  edge: Pick<CanvasEdge, "target" | "targetPort">,
  edges: Array<Pick<CanvasEdge, "target" | "targetPort">>,
  target: PortAwareNode,
) {
  const port = portForNode(target, edge.targetPort, "input");
  if (!port) return "目标端口不存在";
  const maximum =
    port.maxConnections ?? (port.cardinality === "one" ? 1 : Number.POSITIVE_INFINITY);
  const connections = edges.filter(
    (item) =>
      item.target === edge.target && item.targetPort === edge.targetPort,
  ).length;
  return connections >= maximum
    ? `${port.label}最多允许 ${maximum} 条输入连接`
    : null;
}

export function portColor(type: PortDataType) {
  return {
    text: "#6366f1",
    image: "#10b981",
    video: "#f97316",
    audio: "#ec4899",
    document: "#64748b",
    json: "#8b5cf6",
    asset: "#0ea5e9",
    asset_list: "#14b8a6",
    collection: "#a855f7",
  }[type];
}
