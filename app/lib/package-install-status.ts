import type { InstalledPackage } from "../types";

export function packageInstallStatus(item: InstalledPackage) {
  if (item.healthStatus === "build_required" || item.lifecycleState === "source_pending_build") {
    return { kind: "installing" as const, label: "源码已导入", detail: "等待配置隔离运行环境", available: false };
  }
  if (["installing", "building", "pending"].includes(item.lifecycleState ?? "")) {
    return { kind: "installing" as const, label: "安装中", detail: "正在准备插件运行环境", available: false };
  }
  if (["rejected", "revoked", "quarantined", "failed"].includes(item.lifecycleState ?? "") || ["rejected", "revoked"].includes(item.trustState ?? "")) {
    return { kind: "failed" as const, label: "安装失败", detail: "插件未通过安装或安全检查", available: false };
  }
  if (!item.enabled) {
    return { kind: "disabled" as const, label: "已停用", detail: "插件已安装但当前未启用", available: true };
  }
  return { kind: "success" as const, label: "安装成功", detail: "插件可以添加到画布", available: true };
}
