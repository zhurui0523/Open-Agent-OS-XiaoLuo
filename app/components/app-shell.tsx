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
        taskCenterOpen={taskCenterOpen}
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
        onOpenTaskCenter={() => setTaskCenterOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
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
        <span>正在连接 XiaoLuo AI 云端内核</span>
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
