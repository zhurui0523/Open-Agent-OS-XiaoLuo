"use client";

import { LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { useIntentOS } from "../hooks/use-intent-os";
import type { AccountUser } from "../types";
import { AccountCenter } from "./account-center";
import { AdminCenter } from "./admin-center";
import { AppDialogProvider } from "./app-dialog";
import { AssetsView } from "./assets-view";
import { AuthScreen } from "./auth-screen";
import { CanvasFloatBar } from "./canvas-float-bar";
import type { FloatBarAction } from "./canvas-float-bar";
import { CanvasToolbar } from "./canvas-toolbar";
import { CanvasView } from "./canvas-view";
import { CapabilitiesView } from "./capabilities-view";
import { SettingsCenter } from "./settings-center";
import { TaskCenter } from "./task-center";

function AuthenticatedShell({
  user,
  onUserUpdate,
  onLogout,
}: {
  user: AccountUser;
  onUserUpdate: (user: AccountUser) => void;
  onLogout: () => void;
}) {
  const os = useIntentOS();
  const [accountOpen, setAccountOpen] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [taskCenterOpen, setTaskCenterOpen] = useState(false);
  /** 小逻结果面板开关：左侧工具栏与画布共享 */
  const [brainDockOpen, setBrainDockOpen] = useState(false);
  // 插件台是画布上独立的一屏，和结果面板抢同一块地方；浮条要常驻，这两份状态只能放在这
  const [pluginsHubOpen, setPluginsHubOpen] = useState(false);
  // 插件台里正在跑哪块面板，null = 清单
  const [hubRunningTabId, setHubRunningTabId] = useState<string | null>(null);

  /**
   * 浮条那颗插件台按钮是三态的：没开就开、正在跑面板就退回清单，只有已经在清单时才关掉。
   * 从别的屏点它要先切回画布，不然那一屏根本不在屏幕上。
   */
  function handleFloatBarAction(action: FloatBarAction) {
    switch (action) {
      case "brain-dock":
        os.setView("canvas");
        setPluginsHubOpen(false);
        setBrainDockOpen(true);
        break;
      case "canvas-surface":
        os.setView("canvas");
        setPluginsHubOpen(false);
        setBrainDockOpen(false);
        break;
      case "plugins-hub":
        if (os.view !== "canvas" || !pluginsHubOpen || hubRunningTabId !== null) {
          os.setView("canvas");
          setHubRunningTabId(null);
          setPluginsHubOpen(true);
          setBrainDockOpen(false);
          break;
        }
        setPluginsHubOpen(false);
        break;
      case "assets":
        os.setView("assets");
        break;
      case "capabilities":
        os.setView("capabilities");
        break;
      // 这两屏现在也带着浮条，按钮就在弹层上面，所以再点一次要能收掉
      case "task-center":
        setTaskCenterOpen((open) => !open);
        break;
      case "settings":
        setSettingsOpen((open) => !open);
        break;
    }
  }

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = os.preferences.canvasBackground;
    root.style.colorScheme =
      os.preferences.canvasBackground === "night" ? "dark" : "light";

    return () => {
      delete root.dataset.theme;
      root.style.removeProperty("color-scheme");
    };
  }, [os.preferences.canvasBackground]);

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    if (
      query.get("view") === "capabilities" ||
      query.has("workflow")
    ) {
      os.setView("capabilities");
    }
  }, [os.setView]);

  useEffect(() => {
    let refreshing = false;
    const refresh = () => {
      if (refreshing) return;
      refreshing = true;
      void fetch("/api/v2/auth/refresh", { method: "POST" })
        .then(async (response) => {
          if (!response.ok) return;
          const payload = (await response.json().catch(() => ({}))) as {
            user?: AccountUser;
          };
          if (payload.user) onUserUpdate(payload.user);
        })
        .finally(() => {
          refreshing = false;
        });
    };
    const timer = window.setInterval(refresh, 10 * 60 * 1000);
    const onVisibility = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [onUserUpdate]);

  return (
    <div
      className={`app-shell theme-${os.preferences.canvasBackground} ${
        os.view === "canvas" ? "is-canvas-view" : ""
      }${os.view === "canvas" && os.consoleOpen ? " is-intent-docked" : ""}${
        brainDockOpen ? " is-brain-dock-open" : ""
      }`}
      data-theme={os.preferences.canvasBackground}
    >
      <CanvasToolbar
        currentView={os.view}
        activeTool={os.activeTool}
        drawerOpen={os.drawerOpen}
        onToolChange={os.setActiveTool}
        onToggleMultiSelect={() => {
          if (os.activeTool === "multi-select") {
            os.setActiveTool("select");
            os.setSelectedNodeId(os.selectedNodeId);
            return;
          }
          os.setActiveTool("multi-select");
        }}
        onToggleDrawer={() => {
          const alreadyOnCanvas = os.view === "canvas";
          os.setView("canvas");
          os.setDrawerOpen(alreadyOnCanvas ? !os.drawerOpen : true);
        }}
        onNavigate={os.setView}
      />

      <main
        className="app-main"
        style={{
          top: os.view === "canvas" ? 0 : "clamp(9px, 1.25vw, 16px)",
        }}
      >
        {os.view === "canvas" && (
          <CanvasView
            os={os}
            brainDockOpen={brainDockOpen}
            onBrainDockOpenChange={setBrainDockOpen}
            pluginsHubOpen={pluginsHubOpen}
            onPluginsHubOpenChange={setPluginsHubOpen}
            hubRunningTabId={hubRunningTabId}
            onHubRunningTabIdChange={setHubRunningTabId}
          />
        )}
        {os.view === "assets" && (
          <AssetsView
            workspaceId={os.workspaceId}
            onAddToCanvas={(asset) => {
              os.addAssetToCanvas(asset);
            }}
          />
        )}
        {os.view === "capabilities" && (
          <CapabilitiesView os={os} user={user} />
        )}
      </main>

      {/* 挂在壳上而不是画布里，所以资产中心 / 能力中心 / 运行详情 / 设置 这几屏也一直在 */}
      <CanvasFloatBar
        currentView={os.view}
        brainDockOpen={brainDockOpen}
        pluginsHubOpen={pluginsHubOpen}
        taskCenterOpen={taskCenterOpen}
        settingsOpen={settingsOpen}
        onAction={handleFloatBarAction}
      />

      {taskCenterOpen && (
        <TaskCenter
          workspaceId={os.workspaceId}
          onClose={() => setTaskCenterOpen(false)}
        />
      )}
      {accountOpen && (
        <AccountCenter user={user} onClose={() => setAccountOpen(false)} />
      )}
      {adminOpen && user.platformRole === "system_admin" && (
        <AdminCenter user={user} onClose={() => setAdminOpen(false)} />
      )}
      {settingsOpen && (
        <SettingsCenter
          os={os}
          user={user}
          onUserUpdate={onUserUpdate}
          onOpenAccount={() => {
            setSettingsOpen(false);
            setAccountOpen(true);
          }}
          onOpenAdmin={() => {
            if (user.platformRole !== "system_admin") return;
            setSettingsOpen(false);
            setAdminOpen(true);
          }}
          onLogout={onLogout}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}

function AppShellContent() {
  const [status, setStatus] = useState<"loading" | "anonymous" | "ready">("loading");
  const [user, setUser] = useState<AccountUser | null>(null);
  const [serviceError, setServiceError] = useState("");

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 8_000);

    void fetch("/api/v2/auth/session", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = (await response.json().catch(() => ({}))) as {
          user?: AccountUser | null;
          error?: string;
        };
        if (!active) return;
        if (response.ok && payload.user) {
          setUser(payload.user);
          setStatus("ready");
          return;
        }
        if (response.status !== 401) {
          setServiceError(payload.error ?? "云端认证服务暂时不可用");
        }
        setStatus("anonymous");
      })
      .catch(() => {
        if (!active) return;
        setServiceError(
          controller.signal.aborted
            ? "认证服务响应超时，请刷新页面或检查服务器状态"
            : "无法连接云端认证服务，请检查网络与服务器配置",
        );
        setStatus("anonymous");
      })
      .finally(() => {
        window.clearTimeout(timeout);
      });
    return () => {
      active = false;
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, []);

  if (status === "loading") {
    return (
      <main className="app-loading">
        <LoaderCircle className="spin" size={24} />
        <span>正在连接小逻Agent OS 云端内核</span>
      </main>
    );
  }
  if (status === "anonymous" || !user) {
    return (
      <AuthScreen
        serviceError={serviceError}
        onAuthenticated={(nextUser) => {
          setServiceError("");
          setUser(nextUser);
          setStatus("ready");
        }}
      />
    );
  }

  return (
    <AuthenticatedShell
      user={user}
      onUserUpdate={setUser}
      onLogout={() => {
        void fetch("/api/v2/auth/logout", { method: "POST" }).finally(() => {
          setUser(null);
          setStatus("anonymous");
        });
      }}
    />
  );
}

export function AppShell() {
  return (
    <AppDialogProvider>
      <AppShellContent />
    </AppDialogProvider>
  );
}
