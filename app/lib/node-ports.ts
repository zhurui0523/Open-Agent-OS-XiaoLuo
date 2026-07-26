import type {
  CanvasEdge,
  CanvasNode,
  NodePort,
  PortDataType,
} from "../types";
import { roleForNode } from "./node-role.ts";

export const DEFAULT_NODE_PORTS: Record<CanvasNode["kind"], NodePort[]> = {
  text: [
    {
      id: "context",
      label: "上下文",
      direction: "input",
      dataTypes: ["text", "document", "json"],
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
      label: "参考图",
      direction: "input",
      dataTypes: ["image"],
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
      label: "参考媒体",
      direction: "input",
      dataTypes: ["image", "video"],
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
      label: "参考音频",
      direction: "input",
      dataTypes: ["audio"],
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
        id: "materials",
        label: "批量素材",
        direction: "input",
        dataTypes: ALL_CONTENT_TYPES,
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
  return direction
    ? resolved.filter((port) => port.direction === direction)
    : resolved;
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
  const targetPort =
    portForNode(target, edge.targetPort, "input") ??
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
