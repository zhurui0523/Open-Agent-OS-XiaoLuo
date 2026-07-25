"use client";

import { Database, HardDrive, RefreshCcw, ServerCog } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

interface Overview {
  metrics: {
    users: number;
    workspaces: number;
    canvases: number;
    assets: number;
    assetBytes: number;
    runningTasks: number;
    failedTasks: number;
  };
  dependencies: { mysql: boolean; oss: boolean };
  events: Array<{ eventType: string; entityId: string; createdAt: string }>;
}

function bytes(value: number) {
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}

export function AdminOperations() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/v2/admin/overview");
      const payload = (await response.json()) as Overview & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "读取失败");
      setOverview(payload);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "读取失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  return (
    <section className="admin-operations">
      <div className="settings-section-heading">
        <div>
          <h3>OS 内核运维</h3>
          <p>数据库、对象存储、任务和关键审计事件的只读总览。</p>
        </div>
        <button type="button" className="secondary-button" onClick={() => void load()}>
          <RefreshCcw size={15} /> 刷新
        </button>
      </div>
      {error && <div className="settings-alert is-error">{error}</div>}
      {loading && !overview && <div className="settings-empty">正在读取内核状态…</div>}
      {overview && (
        <>
          <div className="admin-health-grid">
            <article>
              <Database size={18} />
              <span><b>MySQL</b><small>{overview.dependencies.mysql ? "连接正常" : "不可用"}</small></span>
              <i className={overview.dependencies.mysql ? "healthy" : "failed"} />
            </article>
            <article>
              <HardDrive size={18} />
              <span><b>阿里云 OSS</b><small>{overview.dependencies.oss ? "连接正常" : "不可用"}</small></span>
              <i className={overview.dependencies.oss ? "healthy" : "failed"} />
            </article>
          </div>
          <div className="admin-metric-grid">
            <div><b>{overview.metrics.users}</b><span>用户</span></div>
            <div><b>{overview.metrics.workspaces}</b><span>工作空间</span></div>
            <div><b>{overview.metrics.canvases}</b><span>画布</span></div>
            <div><b>{overview.metrics.assets}</b><span>资产</span></div>
            <div><b>{bytes(overview.metrics.assetBytes)}</b><span>存储量</span></div>
            <div><b>{overview.metrics.runningTasks}</b><span>活动任务</span></div>
            <div><b>{overview.metrics.failedTasks}</b><span>失败任务</span></div>
          </div>
          <section className="admin-event-list">
            <h4><ServerCog size={16} /> 最近审计事件</h4>
            {overview.events.map((event, index) => (
              <div key={`${event.entityId}-${event.createdAt}-${index}`}>
                <code>{event.eventType}</code>
                <span>{event.entityId}</span>
                <time>{new Date(event.createdAt).toLocaleString("zh-CN")}</time>
              </div>
            ))}
            {!overview.events.length && <p>暂无审计事件</p>}
          </section>
        </>
      )}
    </section>
  );
}
