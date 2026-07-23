"use client";

import {
  Bell,
  ChevronDown,
  CircleHelp,
  LogOut,
  Sparkles,
  UserRound,
} from "lucide-react";
import { useState } from "react";
import { useIntentOS } from "../hooks/use-intent-os";
import { AssetsView } from "./assets-view";
import { AuthScreen } from "./auth-screen";
import { CanvasToolbar } from "./canvas-toolbar";
import { CanvasView } from "./canvas-view";
import { CapabilitiesView } from "./capabilities-view";
import { IconButton } from "./icon-button";

export function AppShell() {
  const os = useIntentOS();
  const [loggedIn, setLoggedIn] = useState(true);
  const [profileOpen, setProfileOpen] = useState(false);

  if (!loggedIn) return <AuthScreen onEnter={() => setLoggedIn(true)} />;

  return (
    <div className={`app-shell ${os.view === "canvas" ? "is-canvas-view" : ""}`}>
      <header className="top-bar">
        <div className="brand-lockup">
          <span><Sparkles size={18} /></span>
          <div><b>XiaoLuo AI</b><small>Intent OS · V2</small></div>
        </div>
        <div className="top-status">
          <button type="button" className="status-pill team-pill">
            <span className="team-mark">XL</span>
            <span><small>品牌内容实验室</small><b>团队空间</b></span>
            <ChevronDown size={14} />
          </button>
          <button type="button" className="kernel-chip"><i /> AI 微内核在线</button>
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
              <span>洛</span>
              <div><b>小洛创作者</b><small>管理员 · 演示</small></div>
              <ChevronDown size={14} />
            </button>
            {profileOpen && (
              <div className="profile-menu">
                <button type="button"><UserRound size={15} /> 个人中心</button>
                <button type="button" onClick={() => setLoggedIn(false)}><LogOut size={15} /> 退出演示</button>
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
        onNavigate={os.setView}
      />

      <main className="app-main">
        {os.view === "canvas" && <CanvasView os={os} />}
        {os.view === "assets" && <AssetsView />}
        {os.view === "capabilities" && <CapabilitiesView os={os} />}
      </main>
    </div>
  );
}
