import type {
  CanvasNode,
  CanvasNodeRole,
  NodeBatchMode,
} from "../types";

type RoleAwareNode = Pick<CanvasNode, "role" | "parameters">;

export function roleForNode(node: RoleAwareNode): CanvasNodeRole {
  if (
    node.role === "material" ||
    node.role === "plugin" ||
    node.role === "execution" ||
    node.role === "result"
  ) {
    return node.role;
  }
  const stored = node.parameters?.nodeRole;
  if (
    stored === "material" ||
    stored === "plugin" ||
    stored === "execution" ||
    stored === "result"
  ) {
    return stored;
  }
  if (node.parameters?.source === "asset-kernel") return "material";
  if (node.parameters?.packageId && node.parameters?.runtimeType) {
    return "plugin";
  }
  if (node.parameters?.resultSlot === true) return "result";
  return "execution";
}

export function batchModeForNode(node: RoleAwareNode): NodeBatchMode {
  const value = node.parameters?.batchMode;
  return value === "each" ||
    value === "broadcast" ||
    value === "aggregate" ||
    value === "combine"
    ? value
    : "combine";
}

export function withNodeRole(
  parameters: Record<string, unknown> | undefined,
  role: CanvasNodeRole,
) {
  return { ...(parameters ?? {}), nodeRole: role };
}
