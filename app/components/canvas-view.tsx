"use client";

import {
  Check,
  ChevronsLeft,
  Maximize2,
  MessageSquareText,
  PanelLeftOpen,
  Share2,
  Sparkles,
} from "lucide-react";
import type { CSSProperties } from "react";
import { canvasList } from "../data";
import type { IntentOSController } from "../hooks/use-intent-os";
import { CanvasDrawer } from "./canvas-drawer";
import { CanvasToolbar } from "./canvas-toolbar";
import { IconButton } from "./icon-button";
import { IntentConsole } from "./intent-console";
import { NodeCard } from "./node-card";
import { ZoomControls } from "./zoom-controls";

interface CanvasViewProps {
  os: IntentOSController;
}

function edgeStyle(
  source: { x: number; y: number },
  target: { x: number; y: number },
): CSSProperties {
  const startX = source.x + 264;
  const startY = source.y + 78;
  const endX = target.x;
  const endY = target.y + 78;
  const distance = Math.hypot(endX - startX, endY - startY);
  const angle = Math.atan2(endY - startY, endX - startX) * (180 / Math.PI);
  return {
    left: startX,
    top: startY,
    width: distance,
    transform: `rotate(${angle}deg)`,
  };
}

export function CanvasView({ os }: CanvasViewProps) {
  const activeCanvas =
    canvasList.find((canvas) => canvas.id === os.activeCanvasId) ?? canvasList[0];

  return (
    <div className="canvas-view">
      <CanvasDrawer
        open={os.drawerOpen}
        activeCanvasId={os.activeCanvasId}
        onClose={() => os.setDrawerOpen(false)}
        onSelect={os.setActiveCanvasId}
      />

      <section className="canvas-workspace" aria-label="无限画布">
        <header className="canvas-header">
          <div className="canvas-breadcrumbs">
            {!os.drawerOpen && (
              <IconButton label="打开画布管理" onClick={() => os.setDrawerOpen(true)}>
                <PanelLeftOpen size={17} />
              </IconButton>
            )}
            <span>品牌内容实验室</span>
            <ChevronsLeft size={13} className="breadcrumb-chevron" />
            <strong>{activeCanvas.title}</strong>
            <span className="save-indicator">
              <Check size={13} /> 已保存
            </span>
          </div>
          <div className="canvas-header-actions">
            <span className="viewer-stack" aria-label="2 位协作者">
              <i>洛</i>
              <i>林</i>
            </span>
            <button type="button" className="secondary-button compact">
              <Share2 size={15} /> 分享
            </button>
            <IconButton label="全屏画布">
              <Maximize2 size={17} />
            </IconButton>
          </div>
        </header>

        <div
          className="canvas-stage"
          onClick={(event) => {
            if (event.currentTarget === event.target) os.setSelectedNodeId(null);
          }}
        >
          <div
            className="canvas-content"
            style={{ transform: `scale(${os.zoom / 100})` }}
          >
            {os.edges.map((edge) => {
              const source = os.nodes.find((node) => node.id === edge.source);
              const target = os.nodes.find((node) => node.id === edge.target);
              if (!source || !target) return null;
              const flowing = source.status === "running" || target.status === "running";
              return (
                <div
                  key={edge.id}
                  className={`edge-line ${flowing ? "is-flowing" : ""}`}
                  style={edgeStyle(source, target)}
                  aria-hidden="true"
                >
                  <span />
                </div>
              );
            })}

            {os.nodes.map((node) => (
              <NodeCard
                key={node.id}
                node={node}
                selected={node.id === os.selectedNodeId}
                zoom={os.zoom}
                capabilities={os.capabilities}
                models={os.models}
                onSelect={() => os.setSelectedNodeId(node.id)}
                onMove={(x, y) => os.moveNode(node.id, x, y)}
                onUpdate={(patch) => os.updateNode(node.id, patch)}
              />
            ))}
          </div>

          <div className="canvas-mode-chip">
            <Sparkles size={14} /> 自由脑图流
          </div>

          <div className="minimap" aria-label="画布小地图">
            <span className="minimap-viewport" />
            {os.nodes.map((node) => (
              <i
                key={node.id}
                style={{ left: node.x / 7.2, top: node.y / 6.5 }}
                className={`mini-${node.kind}`}
              />
            ))}
          </div>

          <CanvasToolbar
            activeTool={os.activeTool}
            runState={os.runState}
            hasSelection={Boolean(os.selectedNodeId)}
            onToolChange={os.setActiveTool}
            onAddNode={os.addNode}
            onRun={os.startRun}
            onDelete={os.deleteSelected}
          />
          <ZoomControls zoom={os.zoom} onChange={os.setZoom} />

          {!os.consoleOpen && (
            <button
              type="button"
              className="open-console-button"
              onClick={() => os.setConsoleOpen(true)}
            >
              <MessageSquareText size={17} /> 打开 Intent
            </button>
          )}
        </div>
      </section>

      {os.consoleOpen && (
        <IntentConsole
          messages={os.messages}
          plan={os.plan}
          isPlanning={os.isPlanning}
          runState={os.runState}
          onClose={() => os.setConsoleOpen(false)}
          onSubmit={os.submitIntent}
          onConfirmPlan={os.confirmPlan}
          onStart={os.startRun}
          onPause={os.pauseRun}
          onCancel={os.cancelRun}
        />
      )}
    </div>
  );
}

