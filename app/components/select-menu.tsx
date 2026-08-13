"use client";

import { Check, ChevronDown } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

export interface SelectMenuOption {
  value: string;
  label: string;
  hint?: string;
}

interface SelectMenuProps {
  options: SelectMenuOption[];
  value: string;
  onChange: (value: string) => void;
  ariaLabel?: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

// 全局统一下拉菜单：白卡浮层 + 列表项 + 选中对勾（参考首尾帧下拉样式），
// 替代原生 select；打开时按视口上下剩余空间自动决定向上/向下弹出
export function SelectMenu({
  options,
  value,
  onChange,
  ariaLabel,
  placeholder,
  disabled,
  className,
}: SelectMenuProps) {
  const [open, setOpen] = useState(false);
  const [openUp, setOpenUp] = useState(false);
  const [maxH, setMaxH] = useState(224);
  const rootRef = useRef<HTMLDivElement>(null);
  const current = options.find((option) => option.value === value);

  const toggleOpen = () => {
    if (disabled) return;
    setOpen((prev) => !prev);
  };

  useLayoutEffect(() => {
    if (!open) return;
    const root = rootRef.current;
    if (!root) return;
    const rect = root.getBoundingClientRect();
    // 画布卡片有 contain:paint，浮层出卡片即被裁剪，故以卡片边界为可用空间
    const host = root.closest(".canvas-node")?.getBoundingClientRect() ?? null;
    const topBound = host ? host.top : 0;
    const bottomBound = host ? host.bottom : window.innerHeight;
    const spaceBelow = bottomBound - rect.bottom - 10;
    const spaceAbove = rect.top - topBound - 10;
    const up = spaceBelow < spaceAbove;
    setOpenUp(up);
    setMaxH(Math.max(96, Math.min(224, up ? spaceAbove : spaceBelow)));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div
      ref={rootRef}
      className={`select-menu${open ? " is-open" : ""}${
        disabled ? " is-disabled" : ""
      }${className ? ` ${className}` : ""}`}
    >
      <button
        type="button"
        className="select-menu-trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={toggleOpen}
      >
        <span className="select-menu-value">
          {current?.label ?? placeholder ?? ""}
        </span>
        <ChevronDown size={14} className="select-menu-caret" />
      </button>
      {open && (
        <div
          className={`select-menu-panel${openUp ? " is-up" : ""}`}
          role="listbox"
          style={{ maxHeight: maxH }}
        >
          {options.map((option) => {
            const isActive = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={isActive}
                className={`select-menu-item${isActive ? " is-active" : ""}`}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
              >
                <span className="select-menu-item-label">{option.label}</span>
                {option.hint && (
                  <span className="select-menu-item-hint">{option.hint}</span>
                )}
                {isActive && (
                  <Check size={14} className="select-menu-check" aria-hidden />
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
