"use client";

import {
  Bell,
  Building2,
  Check,
  ChevronDown,
  CircleHelp,
  LoaderCircle,
  LogOut,
  ShieldCheck,
  Sparkles,
  UserRound,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useIntentOS } from "../hooks/use-intent-os";
import type { AccountUser } from "../types";
import { AccountCenter } from "./account-center";
import { AdminCenter } from "./admin-center";
import { AssetsView } from "./assets-view";
import { AuthScreen } from "./auth-screen";
import { CanvasToolbar } from "./canvas-toolbar";
import { CanvasView } from "./canvas-view";
import { CapabilitiesView } from "./capabilities-view";
import { IconButton } from "./icon-button";
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
  const [profileOpen, setProfileOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const avatar = user.displayName.trim().slice(0, 1) || "洛";

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
    <div className={`app-shell ${os.view === "canvas" ? "is-canvas-view" : ""}`}>
      <header className="top-bar">
        <div className="brand-lockup">
          <span><Sparkles size={18} /></span>
          <div><b>XiaoLuo AI</b><small>Intent OS · V2</small></div>
        </div>
        <div className="top-status">
          <div className="team-switcher">
            <button
              type="button"
              className="status-pill team-pill"
              onClick={() => setWorkspaceOpen((current) => !current)}
              aria-expanded={workspaceOpen}
            >
              <span className="team-mark">XL</span>
              <span>
                <small>{os.workspaceName || "正在连接云端"}</small>
                <b>{os.projectName || "工作空间"}</b>
              </span>
              <ChevronDown size={14} />
            </button>
            {workspaceOpen && (
              <div className="workspace-menu">
                <strong>切换工作空间</strong>
                {os.workspaces.map((workspace) => (
                  <button
                    type="button"
                    key={workspace.id}
                    className={workspace.id === os.workspaceId ? "active" : ""}
                    onClick={() => {
                      setWorkspaceOpen(false);
                      void os.switchWorkspace(workspace.id);
                    }}
                  >
                    <span>
                      {workspace.kind === "enterprise"
                        ? <Building2 size={15} />
                        : <UserRound size={15} />}
                    </span>
                    <div>
                      <b>{workspace.organizationName ?? workspace.name}</b>
                      <small>
                        {workspace.kind === "enterprise"
                          ? workspace.organizationRole === "admin"
                            ? "企业管理员"
                            : "企业普通用户"
                          : "个人工作空间"}
                      </small>
                    </div>
                    {workspace.id === os.workspaceId && <Check size={14} />}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            type="button"
            className={`kernel-chip is-${os.cloudStatus}`}
            title={os.cloudError || "服务端运行状态"}
          >
            <i />
            {os.cloudStatus === "error"
              ? "AI 微内核不可用"
              : os.cloudStatus === "loading"
                ? "AI 微内核连接中"
                : "AI 微内核在线"}
          </button>
        </div>
        <div className="top-actions">
          <IconButton label="帮助中心"><CircleHelp size={18} /></IconButton>
          <IconButton label="通知"><Bell size={18} /><span className="notification-dot" /></IconButton>
          <div className="profile-wrap">
            <button
              type="button"
              className="profile-button"
              onClick={() => setProfileOpen((current) => !current)}
              aria-expanded={profileOpen}
            >
              <span>{avatar}</span>
              <div><b>{user.displayName}</b><small>@{user.username}</small></div>
              <ChevronDown size={14} />
            </button>
            {profileOpen && (
              <div className="profile-menu">
                <button
                  type="button"
                  onClick={() => {
                    setProfileOpen(false);
                    setAccountOpen(true);
                  }}
                >
                  <UserRound size={15} /> 账户与企业管理
                </button>
                {user.platformRole === "system_admin" && (
                  <button
                    type="button"
                    onClick={() => {
                      setProfileOpen(false);
                      setAdminOpen(true);
                    }}
                  >
                    <ShieldCheck size={15} /> 后台管理
                  </button>
                )}
                <button type="button" onClick={onLogout}>
                  <LogOut size={15} /> 退出登录
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <CanvasToolbar
        currentView={os.view}
        activeTool={os.activeTool}
        runState={os.runState}
        onToolChange={os.setActiveTool}
        onRun={os.startRun}
        onOpenDrawer={() => {
          os.setView("canvas");
          os.setDrawerOpen(true);
        }}
        onOpenSettings={() => setSettingsOpen(true)}
        onNavigate={os.setView}
      />

      <main className="app-main">
        {os.view === "canvas" && <CanvasView os={os} />}
        {os.view === "assets" && (
          <AssetsView
            workspaceId={os.workspaceId}
            onAddToCanvas={(asset) => {
              os.addAssetToCanvas(asset);
            }}
            onOpenCanvas={async (canvasId) => {
              await os.setActiveCanvasId(canvasId);
              os.setView("canvas");
            }}
          />
        )}
        {os.view === "capabilities" && <CapabilitiesView os={os} />}
        {os.view === "runs" && (
          <TaskCenter
            workspaceId={os.workspaceId}
            onBack={() => os.setView("canvas")}
          />
        )}
      </main>
      {accountOpen && (
        <AccountCenter user={user} onClose={() => setAccountOpen(false)} />
      )}
      {adminOpen && (
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
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}

export function AppShell() {
  const [status, setStatus] = useState<"loading" | "anonymous" | "ready">("loading");
  const [user, setUser] = useState<AccountUser | null>(null);
  const [serviceError, setServiceError] = useState("");

  useEffect(() => {
    let active = true;
    void fetch("/api/v2/auth/session")
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
        setServiceError("无法连接云端认证服务，请检查网络与服务器配置");
        setStatus("anonymous");
      });
    return () => {
      active = false;
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
