"use client";

import {
  Boxes,
  Database,
  HardDrive,
  MessageSquareText,
  RefreshCcw,
  ServerCog,
  ShieldCheck,
  TimerReset,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

interface Overview {
  metrics: {
    users: number;
    canvases: number;
    assets: number;
    assetBytes: number;
    runningTasks: number;
    failedTasks: number;
  };
  dependencies: {
    mysql: boolean;
    storage: boolean;
    storageDriver: "local" | "oss";
  };
  services: {
    sms: { provider: string; configured: boolean; missing: string[] };
    scheduler: { configured: boolean };
    isolatedWorker: {
      configured: boolean;
      endpointOrigin: string | null;
    };
    packageTrust: { signaturesRequired: boolean };
  };
  trust: {
    publishers: number;
    pendingReviews: number;
    quarantinedReviews: number;
    trustedPackages: number;
  };
  heartbeats: Array<{
    component: string;
    instanceId: string;
    status: string;
    lastSeenAt: string;
    detail: Record<string, unknown>;
  }>;
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
              <span>
                <b>
                  {overview.dependencies.storageDriver === "local"
                    ? "本地文件存储"
                    : "阿里云 OSS"}
                </b>
                <small>
                  {overview.dependencies.storage ? "连接正常" : "不可用"}
                </small>
              </span>
              <i
                className={
                  overview.dependencies.storage ? "healthy" : "failed"
                }
              />
            </article>
            <article>
              <MessageSquareText size={18} />
              <span>
                <b>短信服务</b>
                <small>
                  {overview.services.sms.configured
                    ? `${overview.services.sms.provider} 已配置`
                    : `待配置 ${overview.services.sms.missing.length} 项凭证`}
                </small>
              </span>
              <i className={overview.services.sms.configured ? "healthy" : "failed"} />
            </article>
            <article>
              <TimerReset size={18} />
              <span>
                <b>常驻任务调度</b>
                <small>
                  {overview.heartbeats[0]
                    ? `最后心跳 ${new Date(overview.heartbeats[0].lastSeenAt).toLocaleString("zh-CN")}`
                    : overview.services.scheduler.configured
                      ? "接入端已就绪，等待首次调度"
                      : "调度令牌未配置"}
                </small>
              </span>
              <i className={overview.heartbeats[0]?.status === "healthy" ? "healthy" : "failed"} />
            </article>
            <article>
              <Boxes size={18} />
              <span>
                <b>隔离 Worker</b>
                <small>
                  {overview.services.isolatedWorker.configured
                    ? overview.services.isolatedWorker.endpointOrigin
                    : "等待绑定隔离执行集群"}
                </small>
              </span>
              <i className={overview.services.isolatedWorker.configured ? "healthy" : "failed"} />
            </article>
            <article>
              <ShieldCheck size={18} />
              <span>
                <b>Package 信任</b>
                <small>
                  {overview.trust.trustedPackages} 个可信 · {overview.trust.pendingReviews} 个待审
                </small>
              </span>
              <i className={overview.trust.quarantinedReviews === 0 ? "healthy" : "failed"} />
            </article>
          </div>
          <div className="admin-metric-grid">
            <div><b>{overview.metrics.users}</b><span>用户</span></div>
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
