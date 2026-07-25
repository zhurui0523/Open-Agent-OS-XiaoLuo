"use client";

import { History, RotateCcw, Save } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

interface Snapshot {
  id: string;
  revision: number;
  label: string;
  createdAt: string;
}

interface CanvasVersionPanelProps {
  canvasId: string;
  onCreate: (label?: string) => Promise<void>;
  onRestore: (snapshotId: string) => Promise<void>;
}

export function CanvasVersionPanel({
  canvasId,
  onCreate,
  onRestore,
}: CanvasVersionPanelProps) {
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!canvasId) return;
    const response = await fetch(
      `/api/v2/canvases/snapshots?canvasId=${encodeURIComponent(canvasId)}`,
    );
    const payload = (await response.json().catch(() => ({}))) as {
      snapshots?: Snapshot[];
      error?: string;
    };
    if (!response.ok) throw new Error(payload.error ?? "版本读取失败");
    setSnapshots(payload.snapshots ?? []);
  }, [canvasId]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load().catch((cause) =>
        setError(cause instanceof Error ? cause.message : "版本读取失败"),
      );
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  return (
    <section className="canvas-version-panel">
      <div>
        <span><History size={14} /> 版本快照</span>
        <button
          type="button"
          disabled={Boolean(busy)}
          onClick={async () => {
            const label = window.prompt("快照名称", "手动快照")?.trim();
            if (label === undefined) return;
            setBusy("create");
            setError("");
            try {
              await onCreate(label || undefined);
              await load();
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : "创建失败");
            } finally {
              setBusy("");
            }
          }}
        >
          <Save size={13} /> 保存
        </button>
      </div>
      {error && <small className="drawer-inline-error">{error}</small>}
      <div className="canvas-version-list">
        {snapshots.slice(0, 6).map((snapshot) => (
          <div key={snapshot.id}>
            <span>
              <b>{snapshot.label}</b>
              <small>
                r{snapshot.revision} ·{" "}
                {new Date(snapshot.createdAt).toLocaleString("zh-CN")}
              </small>
            </span>
            <button
              type="button"
              aria-label={`恢复 ${snapshot.label}`}
              title={`恢复 ${snapshot.label}`}
              disabled={Boolean(busy)}
              onClick={async () => {
                if (!window.confirm(`恢复到“${snapshot.label}”？`)) return;
                setBusy(snapshot.id);
                try {
                  await onRestore(snapshot.id);
                  await load();
                } catch (cause) {
                  setError(
                    cause instanceof Error ? cause.message : "恢复失败",
                  );
                } finally {
                  setBusy("");
                }
              }}
            >
              <RotateCcw size={13} />
            </button>
          </div>
        ))}
        {!snapshots.length && <small>尚未创建快照</small>}
      </div>
    </section>
  );
}
