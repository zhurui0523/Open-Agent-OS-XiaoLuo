"use client";

import { ChevronDown } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CSSProperties } from "react";
import { createPortal } from "react-dom";

interface DurationRangeOption {
  value: string;
  label: string;
}

interface DurationRangeMenuProps {
  options: DurationRangeOption[];
  value: string;
  onChange: (value: string) => void;
  ariaLabel?: string;
}

function markIndexes(length: number) {
  if (length <= 1) return [0];
  return Array.from(
    new Set(
      [0, 0.25, 0.5, 0.75, 1].map((ratio) =>
        Math.round((length - 1) * ratio),
      ),
    ),
  );
}

export function DurationRangeMenu({
  options,
  value,
  onChange,
  ariaLabel,
}: DurationRangeMenuProps) {
  const [open, setOpen] = useState(false);
  const [panelStyle, setPanelStyle] = useState<CSSProperties | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const currentIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const current = options[currentIndex] ?? options[0];
  const marks = useMemo(() => markIndexes(options.length), [options.length]);
  const progress =
    options.length > 1 ? (currentIndex / (options.length - 1)) * 100 : 0;

  useLayoutEffect(() => {
    if (!open) return;
    const root = rootRef.current;
    if (!root) return;
    const rootRect = root.getBoundingClientRect();
    const hostRect =
      root.closest(".canvas-node")?.getBoundingClientRect() ?? null;
    const topBound = hostRect?.top ?? 0;
    const bottomBound = hostRect?.bottom ?? window.innerHeight;
    const width = Math.max(
      280,
      Math.min(400, (hostRect?.width ?? window.innerWidth) - 24),
    );
    const openUp = bottomBound - rootRect.bottom < rootRect.top - topBound;
    const preferredLeft =
      hostRect && rootRect.left + width > hostRect.right - 10
        ? rootRect.right - width
        : rootRect.left;
    const left = Math.max(
      12,
      Math.min(preferredLeft, window.innerWidth - width - 12),
    );
    setPanelStyle({
      width,
      left,
      ...(openUp
        ? { bottom: window.innerHeight - rootRect.top + 8 }
        : { top: rootRect.bottom + 8 }),
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !rootRef.current?.contains(target) &&
        !panelRef.current?.contains(target)
      ) {
        setOpen(false);
      }
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

  if (!current || options.length === 0) return null;

  return (
    <div
      ref={rootRef}
      className={`duration-range-menu nodrag nopan${open ? " is-open" : ""}`}
      onPointerDown={(event) => event.stopPropagation()}
      onPointerMove={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onPointerCancel={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className="duration-range-trigger"
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((previous) => !previous)}
      >
        <span>{current.label}</span>
        <ChevronDown size={14} aria-hidden />
      </button>

      {open &&
        panelStyle &&
        createPortal(
          <div
            ref={panelRef}
            className="duration-range-panel"
            role="dialog"
            aria-label="选择视频生成时长"
            style={panelStyle}
            onPointerDown={(event) => event.stopPropagation()}
            onPointerMove={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onPointerCancel={(event) => event.stopPropagation()}
          >
            <div className="duration-range-heading">选择视频生成时长</div>
            <div className="duration-range-content">
              <div className="duration-range-slider-wrap">
                <input
                  type="range"
                  min={0}
                  max={Math.max(0, options.length - 1)}
                  step={1}
                  value={currentIndex}
                  aria-label="视频生成时长"
                  style={
                    { "--duration-progress": `${progress}%` } as CSSProperties
                  }
                  onChange={(event) => {
                    const option = options[Number(event.target.value)];
                    if (option) onChange(option.value);
                  }}
                />
                <div className="duration-range-marks" aria-hidden>
                  {marks.map((index) => (
                    <span key={options[index].value}>{options[index].label}</span>
                  ))}
                </div>
              </div>
              <output className="duration-range-value">
                <strong>{current.label}</strong>
                <span>s</span>
              </output>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
