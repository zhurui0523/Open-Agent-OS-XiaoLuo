"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PluginAssetContext, PluginTextContext } from "../types";
import { launchPluginRuntime } from "../lib/plugin-runtime-client";
import {
  FRAME_LOAD_TIMEOUT_MS,
  describeFrameProblem,
  shouldAutoRestart,
} from "../lib/plugin-runtime-guard";
import { syncPluginReferenceFrame } from "../lib/plugin-reference-bridge";

export interface PluginRuntimeFrameProps {
  title: string;
  url?: string | null;
  workspaceId: string;
  packageId?: string | null;
  packageKey?: string | null;
  assetContexts?: PluginAssetContext[];
  textContexts?: PluginTextContext[];
  className?: string;
}

/**
 * 插件运行界面的无框版本：弹窗（PluginRuntimeDialog）与结果面板页签共用，
 * 保证 grant 启动、握手、令牌过期重连只有一份实现。
 */
export function PluginRuntimeFrame({
  title,
  url,
  workspaceId,
  packageId,
  packageKey,
  assetContexts = [],
  textContexts = [],
  className,
}: PluginRuntimeFrameProps) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const assetContextsRef = useRef<PluginAssetContext[]>(assetContexts);
  const textContextsRef = useRef<PluginTextContext[]>(textContexts);
  const [frameFailed, setFrameFailed] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [runtimeUrl, setRuntimeUrl] = useState<string | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [launchRevision, setLaunchRevision] = useState(0);
  // 故障隔离（P1-4）：加载看门狗 + 崩溃上报 + 自动重启计数
  const [frameLoaded, setFrameLoaded] = useState(false);
  const [autoRestarts, setAutoRestarts] = useState(0);

  const notifyPluginHost = useCallback((frame: HTMLIFrameElement | null) => {
    syncPluginReferenceFrame(
      frame,
      assetContextsRef.current,
      textContextsRef.current,
    );
  }, []);

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

  /** 加载看门狗：runtimeUrl 就绪后开始计时，onLoad 到点未触发就判定超时（可自动重启一次） */
  useEffect(() => {
    if (!runtimeUrl) return;
    setFrameLoaded(false);
    const timer = setTimeout(() => {
      setFrameLoaded((loaded) => {
        if (loaded) return loaded;
        setFrameFailed(true);
        setRuntimeError(describeFrameProblem("timeout"));
        setAutoRestarts((attempts) => {
          if (shouldAutoRestart(attempts)) {
            setLaunchRevision((current) => current + 1);
            return attempts + 1;
          }
          return attempts;
        });
        return loaded;
      });
    }, FRAME_LOAD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [runtimeUrl, launchRevision]);

  useEffect(() => {
    assetContextsRef.current = assetContexts;
    textContextsRef.current = textContexts;
    notifyPluginHost(frameRef.current);
  }, [assetContexts, notifyPluginHost, textContexts]);

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      const frame = frameRef.current;
      if (!frame || event.source !== frame.contentWindow) return;
      if (!event.data || typeof event.data !== "object") return;

      if (event.data.type === "xiaoluo:runtime-grant-expired") {
        setLaunchRevision((current) => current + 1);
        return;
      }

      // 插件自报崩溃/报错：不再静默，落到提示条上，并允许一键重启
      if (event.data.type === "xiaoluo:runtime-error") {
        const detail = String(event.data.message ?? event.data.error ?? "").slice(0, 160);
        setFrameFailed(true);
        setRuntimeError(describeFrameProblem("crash", detail));
        return;
      }

      if (event.data.type === "xiaoluo:capability-request") {
        // 真跑：交给服务端能力桥按「授权 + 围栏」执行；拒绝时把原因和「去哪开」一起回给插件
        const requestId = event.data.requestId;
        const capability = String(event.data.capability ?? "");
        const args = (event.data.args ?? {}) as Record<string, unknown>;
        void (async () => {
          try {
            const response = await fetch("/api/v2/plugins/capability", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ capability, args }),
            });
            const payload = (await response.json().catch(() => null)) as
              | { ok?: boolean; error?: string; hint?: string; [key: string]: unknown }
              | null;
            const ok = Boolean(payload?.ok);
            frame.contentWindow?.postMessage(
              {
                type: "xiaoluo:capability-response",
                requestId,
                ok,
                ...(ok ? { result: payload } : { error: payload?.error ?? "能力调用失败" }),
                ...(payload?.hint ? { hint: payload.hint } : {}),
              },
              "*",
            );
          } catch (error) {
            frame.contentWindow?.postMessage(
              {
                type: "xiaoluo:capability-response",
                requestId,
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              },
              "*",
            );
          }
        })();
      }
    }

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  const frameActive = Boolean(runtimeUrl) && !frameFailed;

  return (
    <div className={className ?? "plugin-runtime-content"}>
      {frameActive ? (
        <iframe
          key={runtimeUrl}
          ref={frameRef}
          src={runtimeUrl ?? undefined}
          title={`${title} 插件界面`}
          sandbox="allow-scripts allow-same-origin allow-forms allow-downloads"
          referrerPolicy="no-referrer"
          allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'"
          onLoad={() => {
            setFrameLoaded(true);
            notifyPluginHost(frameRef.current);
          }}
          onError={() => {
            setFrameFailed(true);
            setRuntimeError(describeFrameProblem("error"));
          }}
        />
      ) : (
        <div className="plugin-runtime-empty">
          <strong>{launching ? "正在重新连接插件…" : "插件界面暂不可用"}</strong>
          {launching ? null : (
            <>
              <span>
                {runtimeError ??
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
          )}
        </div>
      )}
    </div>
  );
}
