/**
 * 小逻 v3 —— 预览卡（统一内嵌浏览器形态）
 *
 * 单一 UI = 内嵌小浏览器（地址栏 + ←→⟳ + ↗ + iframe 视窗），底层按内容切隔离档位：
 *  - 代码产物：srcDoc + sandbox（隔离沙箱，预览 JS 碰不到主应用），徽标「沙箱预览」
 *  - 本机服务 URL：直载不加 sandbox（需要真实网络/同源），徽标「本地服务」
 *  - 空态：地址栏可直接输入网址
 */

import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import type { PreviewDocument } from "../../lib/brain/preview";

/** 外部打开统一通道：桌面桥 IPC 优先（shell.openExternal 确定性拉起默认浏览器），
 * 浏览器环境退化 window.open，再被弹窗拦截则程序化锚点点击。
 * 不用 <a target="_blank">——Electron 单窗口里该路径依赖窗口打开拦截器，不可靠。 */
export function openExternalUrl(url: string) {
  try {
    const bridge = typeof window !== "undefined" ? window.xiaoluoDesktop : undefined;
    if (bridge?.openExternal) {
      void bridge.openExternal({ url }).catch(() => {});
      return;
    }
  } catch {}
  const win = window.open(url, "_blank", "noopener");
  if (win) return;
  const a = document.createElement("a");
  a.href = url;
  a.target = "_blank";
  a.rel = "noreferrer";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export interface CodePreviewProps {
  preview: PreviewDocument;
  /** 预览区高度（默认 360） */
  height?: number;
  /** 撑满父容器（结果面板全屏模式用），此时忽略 height */
  fill?: boolean;
}

const styles: Record<string, CSSProperties> = {
  card: {
    border: "1px solid #e2e4ea",
    borderRadius: 12,
    background: "#fff",
    overflow: "hidden",
    maxWidth: 560,
    fontSize: 13,
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "8px 12px",
    borderBottom: "1px solid #eef0f4",
    background: "#fafbfc",
  },
  title: { fontWeight: 600, color: "#333", fontSize: 12 },
  badge: {
    fontSize: 11,
    color: "#7a8194",
    border: "1px solid #e2e4ea",
    borderRadius: 999,
    padding: "2px 8px",
    marginLeft: 8,
  },
  btn: {
    padding: "4px 10px",
    borderRadius: 999,
    border: "1px solid #d9dce3",
    background: "#fff",
    cursor: "pointer",
    fontSize: 12,
    color: "#333",
  },
  frame: {
    width: "100%",
    border: "none",
    display: "block",
    background: "#fff",
  },
};

// SPLIT-PREVIEW：纯沙箱预览（结果面板「预览」页签专用）——只运行代码产物，
// 没有地址栏/导航，避免与浏览器档互相切换的困惑。
export function SandboxFrame({
  preview,
  height = 360,
  fill = false,
}: {
  preview: PreviewDocument;
  height?: number;
  fill?: boolean;
}) {
  const [runKey, setRunKey] = useState(0);
  return (
    <div
      style={
        fill
          ? { ...styles.card, maxWidth: "none", height: "100%", display: "flex", flexDirection: "column" }
          : styles.card
      }
    >
      <div style={{ ...styles.header, gap: 6 }}>
        <span
          style={{ ...styles.title, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          title={preview.title}
        >
          {preview.title}
        </span>
        <button style={styles.btn} title="重新运行" onClick={() => setRunKey((k) => k + 1)}>
          ⟳
        </button>
        <span style={{ ...styles.badge, marginLeft: 0, flexShrink: 0 }}>沙箱预览</span>
      </div>
      <iframe
        key={runKey}
        title={`小逻沙箱预览：${preview.title}`}
        srcDoc={preview.srcDoc}
        sandbox={preview.sandbox}
        style={fill ? { ...styles.frame, flex: 1, minHeight: 0, height: "auto" } : { ...styles.frame, height }}
      />
    </div>
  );
}

/** 预览入口（薄封装）：统一交给 BrowserFrame，沙箱/实况两种内容形态共用一套浏览器 UI */
export function CodePreview({ preview, height = 360, fill = false }: CodePreviewProps) {
  return <BrowserFrame preview={preview} height={height} fill={fill} />;
}

/**
 * 内嵌小浏览器（预览区唯一形态）：地址栏（←/→/⟳ + 地址框 + ↗）+ iframe 视窗。
 * 内容两档：
 *  - 沙箱档（preview.srcDoc）：代码产物隔离运行，←/→/↗ 停用，⟳ = 重新运行；
 *    地址栏仍可输入——回车即切到浏览器档导航（manualUrl 覆盖）；
 *  - 浏览器档（preview.url / initialUrl / 手动输入）：URL 直载，自维护导航栈
 *    实现前进后退（跨域 iframe 无法程序化控制其历史）。
 * 无内容时显示空态占位，可直接在地址栏输入网址。
 */
export function BrowserFrame({
  preview,
  initialUrl = "",
  height = 360,
  fill = false,
  reloadKey = 0,
}: {
  preview?: PreviewDocument;
  initialUrl?: string;
  height?: number;
  fill?: boolean;
  /** AUTO-SVC-SYNC：外部计数变化（服务自动重启完成）→ 强制重载 iframe */
  reloadKey?: number;
}) {
  /** 手动导航覆盖：用户在地址框输了网址 → 压过沙箱档，按浏览器档渲染 */
  const [manualUrl, setManualUrl] = useState<string | null>(null);
  /** 沙箱档：代码产物 srcDoc（有 url / 有手动导航时走浏览器档） */
  const sandboxed = Boolean(preview && !preview.url && preview.srcDoc && !manualUrl);
  const bootUrl = preview?.url || initialUrl || "";
  // 宿主换了预览内容（新产物 / 起服务）→ 清掉手动导航，回到内容决定档位
  useEffect(() => {
    setManualUrl(null);
  }, [preview]);
  const [runKey, setRunKey] = useState(0);
  const [stack, setStack] = useState<string[]>(bootUrl ? [bootUrl] : []);
  const [idx, setIdx] = useState(bootUrl ? 0 : -1);
  const [draftUrl, setDraftUrl] = useState(bootUrl);
  // 宿主切换服务地址时重置导航栈
  useEffect(() => {
    if (!bootUrl) return;
    setStack([bootUrl]);
    setIdx(0);
    setDraftUrl(bootUrl);
    setRunKey((k) => k + 1);
  }, [bootUrl]);
  // NAV-EVENT：小逻 navigate_browser 工具派发的导航指令 → 压过当前档位按浏览器档渲染
  useEffect(() => {
    const onNav = (e: Event) => {
      const url = (e as CustomEvent<{ url?: string }>).detail?.url;
      if (!url) return;
      setManualUrl(url);
      setStack([url]);
      setIdx(0);
      setDraftUrl(url);
      setRunKey((k) => k + 1);
    };
    window.addEventListener('xiaoluo:navigate-browser', onNav);
    return () => window.removeEventListener('xiaoluo:navigate-browser', onNav);
  }, []);
  // AUTO-SVC-SYNC：服务自动重启完成（同地址跑新代码）→ 强制重载，否则 iframe 还是旧页面
  useEffect(() => {
    if (reloadKey) setRunKey((k) => k + 1);
  }, [reloadKey]);
  const current = idx >= 0 ? (stack[idx] ?? "") : "";
  /** BACK-TO-SANDBOX-V2 被手动导航压过就可回：有沙箱产物回沙箱，本地服务回服务地址，否则回初始空态 */
  const canBackHome = manualUrl !== null;
  const backHome = () => {
    setManualUrl(null);
    setStack(bootUrl ? [bootUrl] : []);
    setIdx(bootUrl ? 0 : -1);
    setDraftUrl(bootUrl);
    setRunKey((k) => k + 1);
  };
  const navigate = (raw: string) => {
    let u = raw.trim();
    if (!u) {
      // BACK-TO-SANDBOX-V2 清空地址栏回车 = 回到预览原位
      if (canBackHome) backHome();
      return;
    }
    if (!/^https?:\/\//i.test(u)) u = "http://" + u;
    if (preview && !preview.url && preview.srcDoc && !manualUrl) {
      // 沙箱档里手动导航：切到浏览器档，栈重置为新地址
      setManualUrl(u);
      setStack([u]);
      setIdx(0);
      setDraftUrl(u);
      setRunKey((k) => k + 1);
      return;
    }
    const next = stack.slice(0, idx + 1);
    next.push(u);
    setStack(next);
    setIdx(next.length - 1);
    setDraftUrl(u);
    // BACK-TO-SANDBOX-V3 空态/本地服务档的手动导航也要可回原位
    if (!manualUrl) setManualUrl(u);
  };
  const goto = (ni: number) => {
    if (ni < 0 || ni >= stack.length) return;
    setIdx(ni);
    setDraftUrl(stack[ni]);
  };
  /** 外部打开：走统一通道（桌面桥 IPC > window.open > 程序化锚点） */
  const openExternally = openExternalUrl;
  const navBtn = (extra: CSSProperties = {}): CSSProperties => ({
    ...styles.btn,
    padding: "4px 9px",
    flex: "0 0 auto",
    ...extra,
  });
  return (
    <div
      style={
        fill
          ? { ...styles.card, maxWidth: "none", height: "100%", display: "flex", flexDirection: "column" }
          : styles.card
      }
    >
      <div style={{ ...styles.header, gap: 6 }}>
        <button
          style={navBtn()}
          disabled={sandboxed || idx <= 0}
          title="后退"
          onClick={() => goto(idx - 1)}
        >
          ←
        </button>
        <button
          style={navBtn()}
          disabled={sandboxed || idx >= stack.length - 1}
          title="前进"
          onClick={() => goto(idx + 1)}
        >
          →
        </button>
        <button
          style={navBtn()}
          title={sandboxed ? "重新运行" : "刷新"}
          onClick={() => setRunKey((k) => k + 1)}
        >
          ⟳
        </button>
        <input
          value={draftUrl}
          placeholder={sandboxed ? preview?.title + "（沙箱运行中，输网址回车可切换）" : "输入 URL..."}
          title={sandboxed ? "代码产物在隔离沙箱中运行（无网络、无同源）；输入网址回车即切换为浏览器模式" : undefined}
          onChange={(e) => setDraftUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") navigate(draftUrl);
          }}
          style={{
            flex: 1,
            minWidth: 0,
            border: "1px solid #d9dce3",
            borderRadius: 999,
            padding: "4px 12px",
            fontSize: 12,
            color: "#333",
            outline: "none",
            background: "#fff",
          }}
        />
        <span style={{ ...styles.badge, marginLeft: 0, flexShrink: 0 }}>
          {sandboxed ? "沙箱预览" : current ? (preview?.url && !manualUrl ? "本地服务" : "网页") : "浏览器"}
        </span>
        {canBackHome ? (
          <button
            style={navBtn()}
            title={preview && !preview.url && preview.srcDoc ? "回到代码产物的隔离沙箱预览" : "回到预览原位"}
            onClick={backHome}
          >
            {preview && !preview.url && preview.srcDoc ? "⌂ 沙箱" : "⌂ 返回"}
          </button>
        ) : null}
        {current && !sandboxed ? (
          <button
            style={navBtn()}
            title="在外部浏览器打开"
            onClick={() => openExternally(current)}
          >
            ↗
          </button>
        ) : null}
      </div>
      {sandboxed && preview ? (
        <iframe
          key={runKey + "-sandbox"}
          title={`小逻预览：${preview.title}`}
          srcDoc={preview.srcDoc}
          sandbox={preview.sandbox}
          style={fill ? { ...styles.frame, flex: 1, minHeight: 0, height: "auto" } : { ...styles.frame, height }}
        />
      ) : current ? (
        <iframe
          key={runKey + "-" + current}
          title="小逻内嵌浏览器"
          src={current}
          style={fill ? { ...styles.frame, flex: 1, minHeight: 0, height: "auto" } : { ...styles.frame, height }}
        />
      ) : (
        <div
          style={
            fill
              ? { flex: 1, minHeight: 0, display: "grid", placeItems: "center", background: "#fafbfc" }
              : { height, display: "grid", placeItems: "center", background: "#fafbfc" }
          }
        >
          <div style={{ textAlign: "center", color: "#8a8f98", fontSize: 13 }}>
            <div style={{ fontSize: 34 }}>🌐</div>
            <div style={{ fontWeight: 700, color: "#333", marginTop: 6 }}>浏览器</div>
            <div style={{ marginTop: 4 }}>在上方输入 URL，或让小逻起个本地服务后自动出现在这里</div>
          </div>
        </div>
      )}
    </div>
  );
}
