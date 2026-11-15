"use client";

import { GripHorizontal, Pencil, Play, Trash2 } from "lucide-react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { CanvasGroup } from "../types";
import { useAppDialog } from "./app-dialog";

interface CanvasGroupRegionProps {
  group: CanvasGroup;
  memberNodeIds: string[];
  zoom: number;
  running: boolean;
  onChangeStart: () => void;
  onMoveBy: (
    deltaX: number,
    deltaY: number,
    memberNodeIds: string[],
  ) => void;
  onResizeBy: (deltaWidth: number, deltaHeight: number) => void;
  onRename: (title: string) => void;
  onDelete: () => void;
  onRun: () => void;
}

export function CanvasGroupRegion({
  group,
  memberNodeIds,
  zoom,
  running,
  onChangeStart,
  onMoveBy,
  onResizeBy,
  onRename,
  onDelete,
  onRun,
}: CanvasGroupRegionProps) {
  const dialog = useAppDialog();
  const scale = Math.max(0.1, zoom / 100);

  function startMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (
      event.button !== 0 ||
      (event.target as HTMLElement).closest("button")
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    onChangeStart();
    const target = event.currentTarget;
    let lastX = event.clientX;
    let lastY = event.clientY;
    target.setPointerCapture(event.pointerId);
    const move = (pointerEvent: PointerEvent) => {
      const deltaX = (pointerEvent.clientX - lastX) / scale;
      const deltaY = (pointerEvent.clientY - lastY) / scale;
      lastX = pointerEvent.clientX;
      lastY = pointerEvent.clientY;
      onMoveBy(deltaX, deltaY, memberNodeIds);
    };
    const finish = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", finish);
      target.removeEventListener("pointercancel", finish);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", finish);
    target.addEventListener("pointercancel", finish);
  }

  function startResize(event: ReactPointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    onChangeStart();
    const target = event.currentTarget;
    let lastX = event.clientX;
    let lastY = event.clientY;
    target.setPointerCapture(event.pointerId);
    const move = (pointerEvent: PointerEvent) => {
      const deltaWidth = (pointerEvent.clientX - lastX) / scale;
      const deltaHeight = (pointerEvent.clientY - lastY) / scale;
      lastX = pointerEvent.clientX;
      lastY = pointerEvent.clientY;
      onResizeBy(deltaWidth, deltaHeight);
    };
    const finish = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", finish);
      target.removeEventListener("pointercancel", finish);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", finish);
    target.addEventListener("pointercancel", finish);
  }

  return (
    <section
      data-group-id={group.id}
      className={`canvas-group-region color-${group.color}`}
      style={{
        left: group.x,
        top: group.y,
        width: group.width,
        height: group.height,
      }}
      aria-label={`节点群区域：${group.title}`}
    >
      <div className="canvas-group-header" onPointerDown={startMove}>
        <GripHorizontal size={16} aria-hidden="true" />
        <strong>{group.title}</strong>
        <small>{memberNodeIds.length} 个节点</small>
        <button
          type="button"
          title="重命名节点群"
          aria-label={`重命名${group.title}`}
          onClick={async () => {
            const title = (
              await dialog.prompt("修改节点群的显示名称。", {
                title: "重命名节点群",
                inputLabel: "节点群名称",
                defaultValue: group.title,
                confirmText: "保存名称",
              })
            )?.trim().slice(0, 120);
            if (title && title !== group.title) onRename(title);
          }}
        >
          <Pencil size={14} />
        </button>
        <button
          type="button"
          className="canvas-group-run"
          disabled={running || memberNodeIds.length === 0}
          title={
            memberNodeIds.length
              ? "执行节点群内全部节点"
              : "节点群内暂时没有节点"
          }
          aria-label={`执行节点群${group.title}`}
          onClick={onRun}
        >
          <Play size={14} fill="currentColor" />
          {running ? "执行中" : "执行节点群"}
        </button>
        <button
          type="button"
          className="canvas-group-delete"
          title="删除节点群区域（不会删除节点）"
          aria-label={`删除节点群区域${group.title}`}
          onClick={async () => {
            if (await dialog.confirm(
              "只会删除节点群区域，区域内的节点和连线会继续保留。",
              {
                title: "删除节点群区域",
                confirmText: "删除区域",
                tone: "danger",
              },
            )) {
              onDelete();
            }
          }}
        >
          <Trash2 size={14} />
        </button>
      </div>
      <button
        type="button"
        className="canvas-group-resize"
        aria-label={`调整节点群${group.title}大小`}
        title="拖动调整节点群大小"
        onPointerDown={startResize}
      />
    </section>
  );
}
