"use client";

import { Check, ChevronDown, PlugZap } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import type { InstalledPackage, MediaPluginType } from "../types";

const typeLabel: Record<MediaPluginType, string> = {
  image: "图片",
  video: "视频",
  audio: "音频",
};

interface AssetPluginMenuProps {
  plugins: InstalledPackage[];
  mediaKind: MediaPluginType;
  onSelect: (plugin: InstalledPackage) => void;
}

export function AssetPluginMenu({
  plugins,
  mediaKind,
  onSelect,
}: AssetPluginMenuProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });

  useLayoutEffect(() => {
    if (!open) return;
    const trigger = rootRef.current?.getBoundingClientRect();
    if (!trigger) return;
    const panelWidth = 248;
    const panelHeight = Math.min(288, Math.max(82, plugins.length * 58 + 46));
    const roomBelow = window.innerHeight - trigger.bottom;
    const top =
      roomBelow >= panelHeight + 8
        ? trigger.bottom + 8
        : Math.max(8, trigger.top - panelHeight - 8);
    const left = Math.min(
      Math.max(8, trigger.left),
      Math.max(8, window.innerWidth - panelWidth - 8),
    );
    setPosition({ left, top });
  }, [open, plugins.length]);

  useEffect(() => {
    if (!open) return;
    function closeOnOutside(event: PointerEvent) {
      const target = event.target as Node;
      if (
        !rootRef.current?.contains(target) &&
        !panelRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    window.addEventListener("pointerdown", closeOnOutside, true);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOnOutside, true);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  function stopCanvasPointer(event: ReactPointerEvent) {
    event.stopPropagation();
  }

  return (
    <div className="asset-plugin-menu" ref={rootRef}>
      <button
        type="button"
        className={`result-text-action asset-plugin-trigger ${open ? "is-active" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`选择${typeLabel[mediaKind]}插件`}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((current) => !current);
        }}
        onPointerDown={stopCanvasPointer}
      >
        <PlugZap size={14} />
        <span>插件</span>
        <ChevronDown size={13} />
      </button>

      {open
        ? createPortal(
            <div
              ref={panelRef}
              className="asset-plugin-popover"
              role="menu"
              aria-label={`${typeLabel[mediaKind]}插件`}
              style={{ left: position.left, top: position.top }}
              onPointerDown={stopCanvasPointer}
              onPointerMove={stopCanvasPointer}
              onPointerUp={stopCanvasPointer}
              onPointerCancel={stopCanvasPointer}
            >
              <header>
                <PlugZap size={14} />
                <span>选择{typeLabel[mediaKind]}插件</span>
              </header>
              {plugins.length ? (
                <div className="asset-plugin-popover-list">
                  {plugins.map((plugin) => (
                    <button
                      key={plugin.id}
                      type="button"
                      role="menuitem"
                      onClick={(event) => {
                        event.stopPropagation();
                        setOpen(false);
                        onSelect(plugin);
                      }}
                    >
                      <span className="asset-plugin-popover-icon">
                        <PlugZap size={15} />
                      </span>
                      <span>
                        <b>{plugin.name}</b>
                        <small>{plugin.description || "处理当前资产"}</small>
                      </span>
                      <Check size={14} aria-hidden="true" />
                    </button>
                  ))}
                </div>
              ) : (
                <p className="asset-plugin-empty">
                  暂无适用于{typeLabel[mediaKind]}的已启用插件
                </p>
              )}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
