"use client";

// SERVER-URL 登录页快捷入口：连不上或连错服务时，登录前就能改服务地址
import { Globe, PlugZap } from "lucide-react";
import { useEffect, useState } from "react";

type ServerUrlBridge = (payload: {
  action: string;
  [key: string]: unknown;
}) => Promise<{ ok: boolean; data?: { cloudUrl?: string }; message?: string }>;

function readBridge(): ServerUrlBridge | null {
  if (typeof window === "undefined") return null;
  const bridge = (
    window as unknown as { xiaoluoDesktop?: { serverUrl?: ServerUrlBridge } }
  ).xiaoluoDesktop;
  return bridge?.serverUrl || null;
}

export function ServerUrlQuick() {
  const [bridge, setBridge] = useState<ServerUrlBridge | null>(null);
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const found = readBridge();
    if (found) {
      setBridge(found);
      if (typeof found === "function") {
        void found({ action: "status" })
          .then((result) => {
            if (result.ok && result.data?.cloudUrl) setUrl(result.data.cloudUrl);
          })
          .catch(() => {});
      }
    }
    // 桥暴露可能晚于挂载：定时重读，保证面板与状态不丢失
    const timers = [300, 1000, 2000, 4000].map((ms) =>
      setTimeout(() => {
        const live = readBridge();
        if (live) setBridge(live);
      }, ms),
    );
    // 桥不可用时回填当前页面来源，保证测试按钮始终可用
    setUrl((prev) => prev || (typeof window === "undefined" ? "" : window.location.origin));
    return () => timers.forEach(clearTimeout);
  }, []);

  if (!bridge) return null;

  async function testConnection() {
    if (!bridge) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const fn = readBridge();
      if (typeof fn === "function") {
        try {
          const result = await fn({ action: "test", url });
          if (result.ok) {
            setNotice(result.message || "测试通过");
            return;
          }
          setError("测试失败：" + (result.message || "无法连接"));
          return;
        } catch {
          // 桥不可用（旧打包/世界隔离）→ 降级为浏览器直接健康探测
        }
      }
      const base = url.trim().replace(/\/+$/, "");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const resp = await fetch(base + "/api/v2/health/ready", { signal: controller.signal });
      clearTimeout(timer);
      const payload = (await resp.json().catch(() => null)) as { ok?: boolean } | null;
      if (resp.ok && payload?.ok) setNotice("连接正常");
      else setError("测试失败：健康检查未通过");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "测试失败");
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!bridge) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const fn = readBridge();
      if (typeof fn !== "function") throw new Error("BRIDGE_NOT_CALLABLE");
      const result = await fn({ action: "set", cloudUrl: url });
      if (!result.ok) throw new Error(result.message || "保存失败");
      setNotice("已保存，客户端即将重启并连接新地址…");
    } catch (caught) {
      const msg = caught instanceof Error ? caught.message : "保存失败";
      if (msg === "BRIDGE_NOT_CALLABLE" || msg.includes("not a function")) {
        setError("保存失败：当前客户端连接通道不可用，无法写入地址配置。若当前页面已来自你要连接的地址，无需保存、直接登录即可；如确需更换地址，请编辑 %APPDATA% 下「小逻Agent OS」目录中的 server-url.json 后重启客户端。");
      } else {
        setError(msg);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-server-url">
      <button
        type="button"
        className="text-button"
        onClick={() => setOpen((value) => !value)}
      >
        <Globe size={13} /> 服务连接地址
      </button>
      {open && (
        <div className="auth-server-url-panel">
          <p className="auth-server-url-hint">
            当前页面来自：{window.location.origin}
            。若这不是你要连接的服务，在下方修改地址，应用后客户端自动重启。
          </p>
          <input
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://你的域名 或 http://127.0.0.1:3000"
          />
          {error && <p className="auth-server-url-msg is-error">{error}</p>}
          {notice && <p className="auth-server-url-msg is-ok">{notice}</p>}
          <div className="auth-server-url-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={busy || !url.trim()}
              onClick={() => void testConnection()}
            >
              <PlugZap size={13} /> 测试连接
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={busy || !url.trim()}
              onClick={() => void apply()}
            >
              应用并重启
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
