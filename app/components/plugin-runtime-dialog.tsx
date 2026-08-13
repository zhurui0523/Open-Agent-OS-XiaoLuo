"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PluginAssetContext, PluginTextContext } from "../types";
import { launchPluginRuntime } from "../lib/plugin-runtime-client";
import { syncPluginReferenceFrame } from "../lib/plugin-reference-bridge";

interface PluginRuntimeDialogProps {
  title: string;
  url?: string | null;
  workspaceId: string;
  packageId?: string | null;
  packageKey?: string | null;
  assetContexts?: PluginAssetContext[];
  textContexts?: PluginTextContext[];
  initialMode?: PluginRuntimeMode;
  onClose: () => void;
}

export type PluginRuntimeMode = "window" | "fullscreen";

export function PluginRuntimeDialog({
  title,
  url,
  workspaceId,
  packageId,
  packageKey,
  assetContexts = [],
  textContexts = [],
  initialMode = "window",
  onClose,
}: PluginRuntimeDialogProps) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const assetContextsRef = useRef<PluginAssetContext[]>(assetContexts);
  const textContextsRef = useRef<PluginTextContext[]>(textContexts);
  const [mode, setMode] = useState<PluginRuntimeMode>(initialMode);
  const [frameFailed, setFrameFailed] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [runtimeUrl, setRuntimeUrl] = useState<string | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [launchRevision, setLaunchRevision] = useState(0);

  const notifyPluginHost = useCallback((frame: HTMLIFrameElement | null) => {
    syncPluginReferenceFrame(
      frame,
      assetContextsRef.current,
      textContextsRef.current,
    );
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    void (async () => {
      setFrameFailed(false);
      setRuntimeError(null);
      setRuntimeUrl(null);
      if (!url) {
        setRuntimeError("插件运行地址不可用，请重新安装或更新插件。");
        return;
      }

      const target = new URL(url, window.location.origin);
      const needsLaunchGrant = target.pathname.startsWith(
        "/api/v2/packages/runtime/static/",
      );
      if (!needsLaunchGrant) {
        if (!cancelled) setRuntimeUrl(target.href);
        return;
      }

      setLaunching(true);
      try {
        const launchedUrl = await launchPluginRuntime(
          {
            url: target.href,
            workspaceId,
            packageId,
            packageKey,
            packageName: title,
          },
          { signal: controller.signal },
        );
        if (!cancelled) setRuntimeUrl(launchedUrl);
      } catch (error) {
        if (!cancelled && !controller.signal.aborted) {
          setRuntimeError(
            error instanceof Error ? error.message : "无法启动插件",
          );
        }
      } finally {
        if (!cancelled) setLaunching(false);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [launchRevision, packageId, packageKey, title, url, workspaceId]);

  useEffect(() => {
    assetContextsRef.current = assetContexts;
    textContextsRef.current = textContexts;
    notifyPluginHost(frameRef.current);
  }, [assetContexts, notifyPluginHost, textContexts]);

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (event.source !== frameRef.current?.contentWindow) return;
      if (!event.data || typeof event.data !== "object") return;

      if (event.data.type === "xiaoluo:runtime-grant-expired") {
        setLaunchRevision((current) => current + 1);
        return;
      }

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

  const frameActive = Boolean(runtimeUrl) && !frameFailed;

  return createPortal(
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
              画布
            </button>
          </div>
        </header>

        <div className="plugin-runtime-content">
          {frameActive ? (
            <iframe
              key={runtimeUrl}
              ref={frameRef}
              src={runtimeUrl ?? undefined}
              title={`${title} 插件界面`}
              sandbox="allow-scripts allow-same-origin allow-forms allow-downloads"
              referrerPolicy="no-referrer"
              allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'"
              onLoad={() => notifyPluginHost(frameRef.current)}
              onError={() => setFrameFailed(true)}
            />
          ) : (
            <div className="plugin-runtime-empty">
              <strong>
                {launching ? "正在重新连接插件…" : "插件界面暂不可用"}
              </strong>
              {!launching ? (
                <>
                  <span>
                    {runtimeError ||
                      (frameFailed
                        ? "插件页面加载失败，请稍后重试。"
                        : "该插件尚未配置可打开的运行界面。")}
                  </span>
                  <button
                    type="button"
                    onClick={() => setLaunchRevision((current) => current + 1)}
                  >
                    重新加载
                  </button>
                </>
              ) : null}
            </div>
          )}
        </div>
      </section>
    </div>,
    document.body,
  );
}
