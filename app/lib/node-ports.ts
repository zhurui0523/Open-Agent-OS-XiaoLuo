import type {
  CanvasEdge,
  CanvasNode,
  NodePort,
  PortDataType,
} from "../types";

const PORTS: Record<CanvasNode["kind"], NodePort[]> = {
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

export function portsForNode(
  node: Pick<CanvasNode, "kind">,
  direction?: NodePort["direction"],
) {
  const ports = PORTS[node.kind];
  return direction
    ? ports.filter((port) => port.direction === direction)
    : ports;
}

export function portForNode(
  node: Pick<CanvasNode, "kind">,
  portId: string,
  direction: NodePort["direction"],
) {
  return portsForNode(node, direction).find((port) => port.id === portId);
}

export function defaultOutputPort(node: Pick<CanvasNode, "kind">) {
  return portsForNode(node, "output")[0];
}

export function compatibleInputPorts(
  node: Pick<CanvasNode, "kind">,
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
  source: Pick<CanvasNode, "kind">,
  target: Pick<CanvasNode, "kind">,
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
  source: Pick<CanvasNode, "kind">,
  target: Pick<CanvasNode, "kind">,
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
  source: Pick<CanvasNode, "kind">,
  target: Pick<CanvasNode, "kind">,
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

export function portColor(type: PortDataType) {
  return {
    text: "#6366f1",
    image: "#10b981",
    video: "#f97316",
    audio: "#ec4899",
    document: "#64748b",
    json: "#8b5cf6",
  }[type];
}
