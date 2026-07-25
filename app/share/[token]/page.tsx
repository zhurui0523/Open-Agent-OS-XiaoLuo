"use client";

import { use, useEffect, useState } from "react";
import type { CanvasEdge, CanvasNode } from "../../types";

interface SharedGraph {
  title: string;
  projectName: string;
  revision: number;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

export default function SharedCanvasPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = use(params);
  const [graph, setGraph] = useState<SharedGraph | null>(null);
  const [mode, setMode] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    void fetch(`/api/v2/canvases/share?token=${encodeURIComponent(token)}`)
      .then(async (response) => {
        const payload = (await response.json()) as {
          share?: { mode: string; graph: SharedGraph };
          error?: string;
        };
        if (!response.ok || !payload.share) {
          throw new Error(payload.error ?? "分享读取失败");
        }
        setMode(payload.share.mode);
        setGraph(payload.share.graph);
      })
      .catch((cause) =>
        setError(cause instanceof Error ? cause.message : "分享读取失败"),
      );
  }, [token]);

  if (error) return <main className="shared-canvas-error">{error}</main>;
  if (!graph) return <main className="shared-canvas-loading">正在读取画布快照…</main>;
  return (
    <main className="shared-canvas-page">
      <header>
        <span>XiaoLuo AI · {mode === "workflow" ? "Workflow 模板" : "只读画布"}</span>
        <h1>{graph.title}</h1>
        <p>{graph.projectName} · revision {graph.revision}</p>
      </header>
      <section>
        <svg className="shared-edge-layer" aria-hidden="true">
          {graph.edges.map((edge) => {
            const source = graph.nodes.find((node) => node.id === edge.source);
            const target = graph.nodes.find((node) => node.id === edge.target);
            if (!source || !target) return null;
            const startX = source.x + 264;
            const startY = source.y + 64;
            const endX = target.x;
            const endY = target.y + 64;
            const control = Math.max(72, Math.abs(endX - startX) * 0.42);
            return (
              <path
                key={edge.id}
                d={`M ${startX} ${startY} C ${startX + control} ${startY}, ${endX - control} ${endY}, ${endX} ${endY}`}
              />
            );
          })}
        </svg>
        {graph.nodes.map((node) => (
          <article
            key={node.id}
            className={`shared-node kind-${node.kind}`}
            style={{ left: node.x, top: node.y }}
          >
            <small>{node.kind}</small>
            <h2>{node.title}</h2>
            <p>{node.prompt}</p>
            {node.result && <div>{node.result}</div>}
          </article>
        ))}
      </section>
    </main>
  );
}
