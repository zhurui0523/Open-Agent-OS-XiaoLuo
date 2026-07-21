"use client";

import { LocateFixed, Minus, Plus } from "lucide-react";
import { IconButton } from "./icon-button";

interface ZoomControlsProps {
  zoom: number;
  onChange: (zoom: number) => void;
}

export function ZoomControls({ zoom, onChange }: ZoomControlsProps) {
  return (
    <div className="zoom-controls" aria-label="缩放控制">
      <IconButton label="回到画布中心" onClick={() => onChange(100)}>
        <LocateFixed size={16} />
      </IconButton>
      <span className="tool-separator" />
      <IconButton label="缩小" onClick={() => onChange(Math.max(50, zoom - 10))}>
        <Minus size={16} />
      </IconButton>
      <button type="button" className="zoom-value" onClick={() => onChange(100)}>
        {zoom}%
      </button>
      <IconButton label="放大" onClick={() => onChange(Math.min(150, zoom + 10))}>
        <Plus size={16} />
      </IconButton>
    </div>
  );
}

