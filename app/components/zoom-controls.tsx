"use client";

import { Focus, Minus, Plus } from "lucide-react";
import { IconButton } from "./icon-button";

interface ZoomControlsProps {
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  onReset: () => void;
}

export function ZoomControls({
  zoom,
  onZoomIn,
  onZoomOut,
  onFit,
  onReset,
}: ZoomControlsProps) {
  return (
    <div className="zoom-controls" aria-label="无限画布缩放控制">
      <IconButton label="适配所有节点" onClick={onFit}>
        <Focus size={16} />
      </IconButton>
      <span className="tool-separator" />
      <IconButton label="缩小" onClick={onZoomOut}>
        <Minus size={16} />
      </IconButton>
      <button type="button" className="zoom-value" onClick={onReset}>
        {Math.round(zoom)}%
      </button>
      <IconButton label="放大" onClick={onZoomIn}>
        <Plus size={16} />
      </IconButton>
    </div>
  );
}
