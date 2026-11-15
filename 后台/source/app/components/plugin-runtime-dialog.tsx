"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { PluginAssetContext, PluginTextContext } from "../types";
import { PluginRuntimeFrame } from "./plugin-runtime-frame";

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
  const [mode, setMode] = useState<PluginRuntimeMode>(initialMode);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

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

        <PluginRuntimeFrame
          title={title}
          url={url}
          workspaceId={workspaceId}
          packageId={packageId}
          packageKey={packageKey}
          assetContexts={assetContexts}
          textContexts={textContexts}
        />
      </section>
    </div>,
    document.body,
  );
}
