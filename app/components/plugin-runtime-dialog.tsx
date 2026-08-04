"use client";

import { useEffect, useRef, useState } from "react";

interface PluginRuntimeDialogProps {
  title: string;
  url?: string | null;
  onClose: () => void;
}

type PluginRuntimeMode = "window" | "fullscreen";

export function PluginRuntimeDialog({
  title,
  url,
  onClose,
}: PluginRuntimeDialogProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [mode, setMode] = useState<PluginRuntimeMode>("window");
  const [frameFailed, setFrameFailed] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [runtimeUrl, setRuntimeUrl] = useState<string | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    setFrameFailed(false);
    setRuntimeError(null);
    setRuntimeUrl(null);

    if (!url) return;

    const target = new URL(url, window.location.origin);
    const needsLaunchGrant = target.pathname.startsWith(
      "/api/v2/packages/runtime/static/",
    );
    if (!needsLaunchGrant) {
      setRuntimeUrl(target.href);
      return;
    }

    setLaunching(true);
    void fetch("/api/v2/packages/runtime/launch", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: target.href }),
    })
      .then(async (response) => {
        const payload = (await response.json()) as {
          url?: string;
          error?: string;
        };
        if (!response.ok || !payload.url) {
          throw new Error(payload.error || "无法启动插件");
        }
        return payload.url;
      })
      .then((launchUrl) => {
        if (!cancelled) setRuntimeUrl(launchUrl);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setRuntimeError(
            error instanceof Error ? error.message : "无法启动插件",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLaunching(false);
      });

    return () => {
      cancelled = true;
    };
  }, [url]);

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (event.source !== frameRef.current?.contentWindow) return;
      if (!event.data || typeof event.data !== "object") return;

      if (event.data.type === "xiaoluo:capability-request") {
        frameRef.current?.contentWindow?.postMessage(
          {
            type: "xiaoluo:capability-response",
            requestId: event.data.requestId,
            ok: false,
            error: "该插件能力尚未获得宿主授权。",
          },
          "*",
        );
      }
    }

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  return (
    <div
      className="plugin-runtime-backdrop"
      role="presentation"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className={`plugin-runtime-dialog is-${mode}`}
        role="dialog"
        aria-modal="true"
        aria-label={`${title} 插件运行器`}
      >
        <header className="plugin-runtime-toolbar">
          <strong>{title}</strong>
          <div className="plugin-runtime-actions" aria-label="插件窗口控制">
            <button
              type="button"
              className={mode === "window" ? "is-active" : ""}
              onClick={() => setMode("window")}
            >
              小窗
            </button>
            <button
              type="button"
              className={mode === "fullscreen" ? "is-active" : ""}
              onClick={() => setMode("fullscreen")}
            >
              全屏
            </button>
            <button type="button" onClick={onClose}>
              关闭
            </button>
          </div>
        </header>

        <div className="plugin-runtime-content">
          {runtimeUrl && !frameFailed ? (
            <iframe
              ref={frameRef}
              src={runtimeUrl}
              title={`${title} 插件界面`}
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
              allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'"
              onLoad={() => {
                frameRef.current?.contentWindow?.postMessage(
                  {
                    type: "xiaoluo:host-ready",
                    version: "2.0",
                    capabilities: [],
                  },
                  "*",
                );
              }}
              onError={() => setFrameFailed(true)}
            />
          ) : (
            <div className="plugin-runtime-empty">
              <strong>
                {launching ? "正在启动插件…" : "插件界面暂不可用"}
              </strong>
              {!launching ? (
                <span>
                  {runtimeError ||
                    (frameFailed
                      ? "插件页面加载失败，请检查插件运行地址。"
                      : "该插件尚未配置可打开的运行界面。")}
                </span>
              ) : null}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
