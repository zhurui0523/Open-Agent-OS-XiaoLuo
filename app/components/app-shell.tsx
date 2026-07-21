"use client";

import {
  Bell,
  Blocks,
  ChevronDown,
  CircleHelp,
  Gauge,
  Library,
  LogOut,
  Menu,
  Sparkles,
  UserRound,
  WandSparkles,
} from "lucide-react";
import { useState } from "react";
import { useIntentOS } from "../hooks/use-intent-os";
import type { AppView } from "../types";
import { AssetsView } from "./assets-view";
import { AuthScreen } from "./auth-screen";
import { CanvasView } from "./canvas-view";
import { CapabilitiesView } from "./capabilities-view";
import { IconButton } from "./icon-button";

const navItems: Array<{ id: AppView; label: string; icon: typeof Sparkles }> = [
  { id: "canvas", label: "灵境", icon: WandSparkles },
  { id: "assets", label: "资产", icon: Library },
  { id: "capabilities", label: "能力", icon: Blocks },
];

export function AppShell() {
  const os = useIntentOS();
  const [loggedIn, setLoggedIn] = useState(true);
  const [profileOpen, setProfileOpen] = useState(false);

  if (!loggedIn) return <AuthScreen onEnter={() => setLoggedIn(true)} />;

  return (
    <div className="app-shell">
      <header className="top-bar">
        <div className="brand-lockup">
          <span><Sparkles size={18} /></span>
          <div><b>XiaoLuo AI</b><small>Intent OS · V2</small></div>
        </div>
        <div className="top-status">
          <button type="button" className="status-pill">
            <span className="credit-ring">68</span>
            <span><small>个人额度</small><b>6,820</b></span>
          </button>
          <button type="button" className="status-pill team-pill">
            <span className="team-mark">XL</span>
            <span><small>品牌内容实验室</small><b>团队空间</b></span>
            <ChevronDown size={14} />
          </button>
          <button type="button" className="kernel-chip"><i /> 核心预览</button>
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
                <button type="button"><Gauge size={15} /> 用量与额度</button>
                <button type="button" onClick={() => setLoggedIn(false)}><LogOut size={15} /> 退出演示</button>
              </div>
            )}
          </div>
        </div>
      </header>

      <nav className="app-dock" aria-label="主导航">
        <IconButton label="打开菜单" className="dock-menu-button"><Menu size={20} /></IconButton>
        <div className="dock-main-items">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                type="button"
                key={item.id}
                className={`dock-item ${os.view === item.id ? "is-active" : ""}`}
                onClick={() => os.setView(item.id)}
              >
                <span><Icon size={21} /></span>
                {item.label}
              </button>
            );
          })}
        </div>
        <div className="dock-bottom"><span className="sync-dot" title="同步正常" /><small>同步</small></div>
      </nav>

      <main className="app-main">
        {os.view === "canvas" && <CanvasView os={os} />}
        {os.view === "assets" && <AssetsView />}
        {os.view === "capabilities" && <CapabilitiesView os={os} />}
      </main>
    </div>
  );
}

