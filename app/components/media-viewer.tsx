"use client";

import { X } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { VideoPlayer } from "./video-player";

interface MediaViewerProps {
  url: string;
  kind: "image" | "video";
  title: string;
  onClose: () => void;
}

// 统一的全屏放大预览：画布节点结果与对话器消息附件共用。
// 支持关闭（× / Esc / 点击遮罩）、滚轮缩放、放大后按住拖拽平移
export function MediaViewer({ url, kind, title, onClose }: MediaViewerProps) {
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const overlayRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    pointerX: number;
    pointerY: number;
    baseX: number;
    baseY: number;
  } | null>(null);

  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [onClose]);

  // React 合成 onWheel 是 passive 监听器无法 preventDefault，
  // 这里用原生 wheel 事件，避免缩放时页面跟着滚动
  useEffect(() => {
    if (kind !== "image") return;
    const overlay = overlayRef.current;
    if (!overlay) return;
    function wheel(event: WheelEvent) {
      event.preventDefault();
      const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
      setScale((current) => Math.min(8, Math.max(0.25, current * factor)));
    }
    overlay.addEventListener("wheel", wheel, { passive: false });
    return () => overlay.removeEventListener("wheel", wheel);
  }, [kind]);

  function startDrag(event: ReactPointerEvent<HTMLImageElement>) {
    if (event.button !== 0 || scale <= 1) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      baseX: offset.x,
      baseY: offset.y,
    };
  }

  function moveDrag(event: ReactPointerEvent<HTMLImageElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    setOffset({
      x: drag.baseX + (event.clientX - drag.pointerX),
      y: drag.baseY + (event.clientY - drag.pointerY),
    });
  }

  function endDrag() {
    dragRef.current = null;
  }

  return createPortal(
    <div
      ref={overlayRef}
      className="media-viewer-overlay"
      role="dialog"
      aria-label={title}
      onClick={onClose}
    >
      {kind === "video" ? (
        <div onClick={(event) => event.stopPropagation()}>
          <VideoPlayer src={url} autoPlay title={title} />
        </div>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt={title}
          draggable={false}
          style={{
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
            cursor: scale > 1 ? "grab" : "zoom-in",
          }}
          onClick={(event) => event.stopPropagation()}
          onPointerDown={startDrag}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        />
      )}
      <button
        type="button"
        className="media-viewer-close"
        aria-label="关闭放大预览"
        title="关闭"
        onClick={onClose}
      >
        <X size={18} />
      </button>
    </div>,
    document.body,
  );
}
