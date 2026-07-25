"use client";

import {
  ArrowLeft,
  Clapperboard,
  LoaderCircle,
  RefreshCcw,
  RotateCcw,
  Square,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

interface RuntimeTask {
  id: string;
  status: string;
  canvasId?: string | null;
  error?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  updatedAt?: string;
}

interface GenerationTask extends RuntimeTask {
  kind: string;
  progress: number;
  provider: string;
  providerStatus?: string | null;
  externalJobId?: string | null;
  pollCount?: number;
  maxPolls?: number;
  runId?: string | null;
  nodeId?: string | null;
}

interface TaskPayload {
  runs: RuntimeTask[];
  jobs: GenerationTask[];
  runTasks: Array<{
    id: string;
    runId: string;
    nodeId: string;
    status: string;
    attempt: number;
    maxAttempts: number;
    executor?: string | null;
    error?: string | null;
    startedAt?: string | null;
    completedAt?: string | null;
  }>;
  summary: { running: number; queued: number; failed: number };
}

const statusLabels: Record<string, string> = {
  queued: "排队中",
  submitted: "已提交",
  running: "执行中",
  succeeded: "已完成",
  failed: "失败",
  canceled: "已取消",
  paused: "已暂停",
  skipped: "已跳过",
};

export function TaskCenter({
  workspaceId,
  onBack,
}: {
  workspaceId: string;
  onBack: () => void;
}) {
  const [payload, setPayload] = useState<TaskPayload>({
    runs: [],
    jobs: [],
    runTasks: [],
    summary: { running: 0, queued: 0, failed: 0 },
  });
  const [status, setStatus] = useState("all");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const query = new URLSearchParams({ workspaceId });
    if (status !== "all") query.set("status", status);
    const response = await fetch(`/api/v2/tasks?${query}`);
    const next = (await response.json().catch(() => ({}))) as TaskPayload & {
      error?: string;
    };
    if (!response.ok) throw new Error(next.error ?? "任务读取失败");
    setPayload(next);
    setError("");
  }, [status, workspaceId]);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        await fetch(
          `/api/v2/tasks/poll?workspaceId=${encodeURIComponent(workspaceId)}`,
          { method: "POST" },
        );
        if (active) await load();
      } catch (cause) {
        if (active) {
          setError(cause instanceof Error ? cause.message : "任务刷新失败");
        }
      }
    };
    void refresh();
    const timer = window.setInterval(refresh, 4_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [load, workspaceId]);

  const tasks = useMemo(
    () => [
      ...payload.jobs.map((job) => ({ ...job, taskType: "generation" as const })),
      ...payload.runs.map((run) => ({
        ...run,
        taskType: "run" as const,
        kind: "workflow",
        progress:
          run.status === "succeeded"
            ? 100
            : run.status === "running"
              ? 50
              : 0,
        provider: "XiaoLuo Runtime",
      })),
    ].sort(
      (first, second) =>
        Date.parse(second.updatedAt ?? "") - Date.parse(first.updatedAt ?? ""),
    ),
    [payload.jobs, payload.runs],
  );

  async function act(
    task: (typeof tasks)[number],
    action: "cancel" | "retry",
  ) {
    setBusy(task.id);
    try {
      const response = await fetch("/api/v2/tasks", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          type: task.taskType,
          id: task.id,
          action,
        }),
      });
      const result = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) throw new Error(result.error ?? "任务操作失败");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "任务操作失败");
    } finally {
      setBusy("");
    }
  }

  async function retryNode(runId: string, nodeId: string) {
    const busyId = `${runId}:${nodeId}`;
    setBusy(busyId);
    try {
      const response = await fetch("/api/v2/tasks", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          type: "run",
          id: runId,
          action: "retry_task",
          nodeId,
        }),
      });
      const result = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) throw new Error(result.error ?? "节点重跑失败");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "节点重跑失败");
    } finally {
      setBusy("");
    }
  }

  return (
    <section className="content-view task-center" aria-label="任务中心">
      <header className="content-header">
        <div>
          <button type="button" className="task-back" onClick={onBack}>
            <ArrowLeft size={15} /> 返回文件系统
          </button>
          <span className="eyebrow">RUNTIME · GENERATION JOBS</span>
          <h1>任务中心</h1>
          <p>异步视频和工作流在关闭页面后继续运行，状态完全来自服务端。</p>
        </div>
        <button type="button" className="secondary-button" onClick={() => void load()}>
          <RefreshCcw size={15} /> 刷新
        </button>
      </header>

      <div className="task-summary">
        <div><b>{payload.summary.running}</b><span>执行中</span></div>
        <div><b>{payload.summary.queued}</b><span>排队中</span></div>
        <div><b>{payload.summary.failed}</b><span>需要处理</span></div>
        <label>
          状态
          <select value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="all">全部</option>
            <option value="running">执行中</option>
            <option value="queued">排队中</option>
            <option value="failed">失败</option>
            <option value="succeeded">已完成</option>
            <option value="canceled">已取消</option>
          </select>
        </label>
      </div>

      {error && <div className="file-system-error" role="alert">{error}</div>}
      <div className="task-list">
        {tasks.map((task) => {
          const active = ["queued", "submitted", "running"].includes(task.status);
          return (
            <article key={`${task.taskType}-${task.id}`} className="task-card">
              <span className={`task-icon kind-${task.kind}`}>
                {task.kind === "video" ? <Clapperboard size={19} /> : <LoaderCircle size={19} />}
              </span>
              <div className="task-copy">
                <div>
                  <strong>
                    {task.kind === "video" ? "异步视频生成" : "工作流运行"}
                  </strong>
                  <em className={`status-${task.status}`}>
                    {statusLabels[task.status] ?? task.status}
                  </em>
                </div>
                <p>{task.provider}{task.providerStatus ? ` · ${task.providerStatus}` : ""}</p>
                <div className="task-progress">
                  <span style={{ width: `${Math.max(0, Math.min(100, task.progress))}%` }} />
                </div>
                <small>
                  {task.progress}% · {task.nodeId ? `节点 ${task.nodeId}` : `任务 ${task.id.slice(0, 12)}`}
                  {task.pollCount ? ` · 已轮询 ${task.pollCount} 次` : ""}
                </small>
                {task.error && <code>{task.error}</code>}
                {task.taskType === "run" && (
                  <details className="run-task-details">
                    <summary>
                      节点执行详情（
                      {payload.runTasks.filter((item) => item.runId === task.id).length}
                      ）
                    </summary>
                    {payload.runTasks
                      .filter((item) => item.runId === task.id)
                      .map((item) => (
                        <div key={item.id}>
                          <span>
                            <b>{item.nodeId}</b>
                            <small>
                              {statusLabels[item.status] ?? item.status} · 尝试{" "}
                              {item.attempt}/{item.maxAttempts}
                            </small>
                          </span>
                          <time>
                            {item.startedAt
                              ? new Date(item.startedAt).toLocaleTimeString("zh-CN")
                              : "未开始"}
                            {" → "}
                            {item.completedAt
                              ? new Date(item.completedAt).toLocaleTimeString("zh-CN")
                              : "进行中"}
                          </time>
                          {["failed", "succeeded"].includes(item.status) && (
                            <button
                              type="button"
                              disabled={busy === `${task.id}:${item.nodeId}`}
                              onClick={() => void retryNode(task.id, item.nodeId)}
                            >
                              <RotateCcw size={12} />
                              {item.status === "failed" ? "重试节点" : "重跑下游"}
                            </button>
                          )}
                          {item.error && <code>{item.error}</code>}
                        </div>
                      ))}
                  </details>
                )}
              </div>
              <div className="task-actions">
                {active && (
                  <button type="button" disabled={busy === task.id} onClick={() => void act(task, "cancel")}>
                    <Square size={13} /> 取消
                  </button>
                )}
                {task.status === "failed" && (
                  <button type="button" disabled={busy === task.id} onClick={() => void act(task, "retry")}>
                    <RotateCcw size={13} /> 重试
                  </button>
                )}
              </div>
            </article>
          );
        })}
        {!tasks.length && <div className="empty-state"><h2>暂无任务</h2><p>画布运行和异步视频任务会出现在这里。</p></div>}
      </div>
    </section>
  );
}
