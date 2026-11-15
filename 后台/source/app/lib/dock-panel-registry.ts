import { useEffect, useMemo, useState } from "react";
import type { InstalledPackage } from "../types";
import { packageInstallStatus } from "./package-install-status";

/** 与 plugin-runtime-launch 的同名常量一致；那边依赖 node:crypto，客户端不能直接引。 */
const PLUGIN_STATIC_RUNTIME_PREFIX = "/api/v2/packages/runtime/static/";

export const DOCK_PANEL_TAB_PREFIX = "plugin:" as const;
export const DOCK_PANEL_PINS_STORAGE_KEY = "xiaoluo.dock.panel-pins";
export const DOCK_PANEL_PINS_CHANGED_EVENT = "xiaoluo:dock-panel-pins-changed";
export const DOCK_TAB_STORAGE_KEY = "xiaoluo.dock.tab";

export interface DockPanelDescriptor {
  /** `plugin:<packageKey>/<panelId>` */
  tabId: string;
  title: string;
  packageName: string;
  packageId: string;
  packageKey: string;
  panelId: string;
  /** 未授予 token 的静态运行地址；由 PluginRuntimeFrame 换成 session 地址 */
  runtimeUrl: string | null;
}

interface DeclaredPanel {
  id?: unknown;
  title?: unknown;
  entry?: unknown;
}

function declaredPanelsOf(item: InstalledPackage): DeclaredPanel[] {
  const contributes = (
    item.manifest as { contributes?: { panels?: unknown } } | undefined
  )?.contributes;
  return Array.isArray(contributes?.panels)
    ? (contributes?.panels as DeclaredPanel[])
    : [];
}

export function isDockPanelTab(tab: string) {
  return tab.startsWith(DOCK_PANEL_TAB_PREFIX);
}

/**
 * panel.entry 第一次成为拼进 iframe src 的输入，所以只接受同源静态目录下的
 * 具体 html 文件；非法值退回插件根地址，绝不拼接。
 */
export function isSafePanelEntry(entry: unknown): entry is string {
  if (typeof entry !== "string") return false;
  const value = entry.trim();
  if (!value.startsWith("/") || value.includes("..") || value.includes("\\")) {
    return false;
  }
  if (value.includes("://")) return false;
  const [pathname] = value.split(/[?#]/, 1);
  return /\.html?$/i.test(pathname);
}

export function dockPanelRuntimeUrl(
  runtimeUrl: string | null | undefined,
  entry: unknown,
): string | null {
  if (!runtimeUrl) return null;
  if (!isSafePanelEntry(entry)) return runtimeUrl;
  const suffix = entry.trim().replace(/^\/+/, "");
  const [path, query = ""] = runtimeUrl.split("?", 1);
  // 老记录里 runtimeUrl 可能是带 localhost 域名的绝对地址，只认静态运行前缀之后的部分。
  if (!path.includes(PLUGIN_STATIC_RUNTIME_PREFIX)) return runtimeUrl;
  return `${path.replace(/\/+$/, "")}/${suffix}${query ? `?${query}` : ""}`;
}

/** 只有 sandbox-ui 有可渲染界面；remote-api 等走节点与模型连接，不占页签。 */
export function pluginDockPanels(
  item: InstalledPackage,
): DockPanelDescriptor[] {
  if (item.packageType !== "plugin") return [];
  if (item.runtimeType !== "sandbox-ui") return [];
  if (item.lifecycleState === "uninstalled") return [];
  // 停用插件的运行令牌签发和静态资源路由都会直接拒绝，页签只会变成一块死面板。
  if (!item.enabled || !item.runtimeUrl) return [];
  if (!packageInstallStatus(item).available) return [];

  const packageKey = item.packageKey || item.id;
  const declared = declaredPanelsOf(item).filter(
    (panel) => typeof panel.id === "string" && typeof panel.title === "string",
  );
  const panels: DeclaredPanel[] = declared.length
    ? declared
    : [{ id: "main", title: item.name }];

  return panels.map((panel) => ({
    tabId: `${DOCK_PANEL_TAB_PREFIX}${packageKey}/${panel.id as string}`,
    title: panel.title as string,
    packageName: item.name,
    packageId: item.id,
    packageKey,
    panelId: panel.id as string,
    runtimeUrl: dockPanelRuntimeUrl(item.runtimeUrl, panel.entry),
  }));
}

export function allPluginDockPanels(
  packages: InstalledPackage[],
): DockPanelDescriptor[] {
  return packages.flatMap(pluginDockPanels);
}

export function readDockPanelPins(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(DOCK_PANEL_PINS_STORAGE_KEY) ?? "[]",
    ) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === "string")
      : [];
  } catch {
    return [];
  }
}

export function writeDockPanelPins(pins: string[]): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(
    DOCK_PANEL_PINS_STORAGE_KEY,
    JSON.stringify(Array.from(new Set(pins))),
  );
  window.dispatchEvent(new Event(DOCK_PANEL_PINS_CHANGED_EVENT));
}

export function toggleDockPanelPin(tabId: string): string[] {
  const pins = readDockPanelPins();
  const next = pins.includes(tabId)
    ? pins.filter((id) => id !== tabId)
    : [...pins, tabId];
  writeDockPanelPins(next);
  return next;
}

export function arePluginPanelsPinned(panels: DockPanelDescriptor[]): boolean {
  if (panels.length === 0) return false;
  const pins = new Set(readDockPanelPins());
  return panels.every((panel) => pins.has(panel.tabId));
}

/** 一个插件的面板整组固定或整组取消，避免多面板插件只剩一半。 */
export function setPluginPanelsPinned(
  panels: DockPanelDescriptor[],
  pinned: boolean,
): string[] {
  const pins = new Set(readDockPanelPins());
  for (const panel of panels) {
    if (pinned) pins.delete(panel.tabId);
    else pins.add(panel.tabId);
  }
  const next = Array.from(pins);
  writeDockPanelPins(next);
  return next;
}

/** 钉选状态存本机 localStorage，同一浏览器所有画布共享。 */
export function usePinnedDockPanels(
  packages: InstalledPackage[],
): DockPanelDescriptor[] {
  const [pins, setPins] = useState<string[]>(readDockPanelPins);

  useEffect(() => {
    const sync = () => setPins(readDockPanelPins());
    window.addEventListener(DOCK_PANEL_PINS_CHANGED_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(DOCK_PANEL_PINS_CHANGED_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  return useMemo(() => {
    const available = new Map(
      allPluginDockPanels(packages).map((panel) => [panel.tabId, panel]),
    );
    // 卸载或停用的插件其钉选自然被过滤掉，不留死页签。
    return pins
      .map((tabId) => available.get(tabId))
      .filter((panel): panel is DockPanelDescriptor => Boolean(panel));
  }, [packages, pins]);
}

export function readStoredDockTab(): string | null {
  if (typeof window === "undefined") return null;
  const value = window.localStorage.getItem(DOCK_TAB_STORAGE_KEY);
  return value ? value : null;
}

export function writeStoredDockTab(tab: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(DOCK_TAB_STORAGE_KEY, tab);
}
