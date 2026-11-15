/**
 * Agent 配置面板（P2-6 前端收尾）。
 *
 * 以前配置只能改文件或调接口；这里把四层解析结果直接摆出来：每项显示"当前生效值 + 来自哪一层"，
 * 改动只写 workspace 层（用户层/项目层文件不归接口管），保存后重新拉一次以显示新的来源。
 */
"use client";

import { useEffect, useMemo, useState } from "react";
import { RotateCcw, SlidersHorizontal } from "lucide-react";

interface SchemaEntry {
  key: string;
  type: "number" | "string" | "boolean";
  default: unknown;
  min?: number;
  max?: number;
  describe?: string;
}

interface ConfigPayload {
  values: Record<string, unknown>;
  sources: Record<string, string>;
  warnings: string[];
  flags: Record<string, boolean>;
  flagSources: Record<string, string>;
  schema: SchemaEntry[];
}

const SOURCE_LABEL: Record<string, string> = {
  default: "默认值",
  user: "用户层",
  workspace: "工作区层",
  project: "项目层",
  env: "环境变量",
};

const GROUPS: Array<{ id: string; title: string; hint: string }> = [
  { id: "agent.", title: "对话与预算", hint: "单轮步数、token 预算、上下文压缩阈值" },
  { id: "security.", title: "安全策略", hint: "审批档位、网络默认档、Windows 沙箱" },
  { id: "workspace.", title: "工作区", hint: "小逻落盘与读写围栏的根目录" },
];

function groupOf(key: string): string {
  const hit = GROUPS.find((group) => key.startsWith(group.id));
  return hit ? hit.id : "other";
}

function formatValue(value: unknown): string {
  if (value === undefined || value === null || value === "") return "（未设）";
  if (typeof value === "boolean") return value ? "开" : "关";
  return String(value);
}

export function AgentConfigPanel() {
  const [payload, setPayload] = useState<ConfigPayload | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const res = await fetch("/api/v2/config");
      if (!res.ok) return;
      const next = (await res.json()) as ConfigPayload;
      setPayload(next);
      setDraft({});
    } catch {
      // 未登录/离线：设置面板不弹错，静默留空
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const grouped = useMemo(() => {
    if (!payload) return [] as Array<{ id: string; title: string; hint: string; rows: SchemaEntry[] }>;
    const buckets = [
      ...GROUPS.map((group) => ({ ...group, rows: payload.schema.filter((row) => row.key.startsWith(group.id)) })),
      { id: "other", title: "其它", hint: "", rows: payload.schema.filter((row) => groupOf(row.key) === "other") },
    ];
    return buckets.filter((bucket) => bucket.rows.length > 0);
  }, [payload]);

  if (!payload) return null;

  const dirtyKeys = Object.keys(draft).filter((key) => {
    const incoming = draft[key];
    if (incoming === undefined) return false;
    const current = payload.values[key];
    return String(incoming) !== String(current ?? "");
  });

  async function save() {
    if (!dirtyKeys.length) return;
    setBusy(true);
    setNotice("");
    try {
      const values: Record<string, unknown> = {};
      for (const key of dirtyKeys) {
        const entry = payload?.schema.find((row) => row.key === key);
        const raw = draft[key];
        values[key] = entry && entry.type === "number" ? Number(raw) : raw;
      }
      const res = await fetch("/api/v2/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ values }),
      });
      const result = (await res.json()) as { ok?: boolean; error?: string; warnings?: string[] };
      if (!res.ok || result.ok === false) throw new Error(result.error || "保存失败");
      setNotice(
        result.warnings && result.warnings.length
          ? `已保存 ${dirtyKeys.length} 项；有告警：${result.warnings.join("；")}`
          : `已保存 ${dirtyKeys.length} 项到工作区配置。`,
      );
      await load();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  async function toggleFlag(name: string, next: boolean) {
    setBusy(true);
    setNotice("");
    try {
      const res = await fetch("/api/v2/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ features: { [name]: next } }),
      });
      if (!res.ok) throw new Error("保存失败");
      setNotice(`${next ? "已开启" : "已关闭"}开关 ${name}`);
      await load();
    } catch {
      setNotice("开关保存失败，稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  const flagNames = Object.keys(payload.flags);

  return (
    <div style={{ display: "grid", gap: 18 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, color: "#111827", fontWeight: 700 }}>
        <SlidersHorizontal size={18} />
        <span>Agent 配置</span>
        <span style={{ fontSize: 12, fontWeight: 400, color: "#6b7280" }}>
          改动只写工作区层；带「环境变量」的项会被 env 覆盖，界面里改不动
        </span>
      </div>

      {payload.warnings.length > 0 && (
        <div style={{ background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 8, padding: "8px 12px", fontSize: 13, color: "#92400e" }}>
          {payload.warnings.map((warning) => (
            <div key={warning}>⚠ {warning}</div>
          ))}
        </div>
      )}

      {grouped.map((group) => (
        <section key={group.id} style={{ border: "1px solid #e5e7eb", borderRadius: 10, overflow: "hidden" }}>
          <header style={{ background: "#f9fafb", padding: "10px 14px", borderBottom: "1px solid #e5e7eb" }}>
            <div style={{ fontWeight: 600, color: "#111827" }}>{group.title}</div>
            {group.hint && <div style={{ fontSize: 12, color: "#6b7280" }}>{group.hint}</div>}
          </header>
          <div>
            {group.rows.map((row) => {
              const current = payload.values[row.key];
              const source = SOURCE_LABEL[payload.sources[row.key] ?? ""] ?? payload.sources[row.key] ?? "";
              const fromEnv = payload.sources[row.key] === "env";
              const value = draft[row.key] !== undefined ? draft[row.key] : String(current ?? "");
              return (
                <div
                  key={row.key}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "minmax(220px, 1fr) 160px auto",
                    gap: 10,
                    alignItems: "center",
                    padding: "10px 14px",
                    borderTop: "1px solid #f3f4f6",
                  }}
                >
                  <div>
                    <div style={{ fontFamily: "ui-monospace, monospace", fontSize: 13, color: "#111827" }}>{row.key}</div>
                    <div style={{ fontSize: 12, color: "#6b7280" }}>
                      {row.describe ?? ""}
                      {row.type === "number" && row.min !== undefined && row.max !== undefined
                        ? `（${row.min}–${row.max}，默认 ${formatValue(row.default)}）`
                        : `（默认 ${formatValue(row.default)}）`}
                    </div>
                  </div>
                  <input
                    type={row.type === "number" ? "number" : "text"}
                    value={value}
                    disabled={fromEnv}
                    onChange={(event) => setDraft((prev) => ({ ...prev, [row.key]: event.target.value }))}
                    style={{
                      width: "100%",
                      padding: "6px 8px",
                      border: "1px solid #d1d5db",
                      borderRadius: 6,
                      fontSize: 13,
                      background: fromEnv ? "#f3f4f6" : "#fff",
                    }}
                  />
                  <span
                    style={{
                      fontSize: 12,
                      padding: "2px 8px",
                      borderRadius: 999,
                      background: fromEnv ? "#eff6ff" : "#f3f4f6",
                      color: fromEnv ? "#1d4ed8" : "#4b5563",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {source || "默认值"}
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      ))}

      {flagNames.length > 0 && (
        <section style={{ border: "1px solid #e5e7eb", borderRadius: 10, overflow: "hidden" }}>
          <header style={{ background: "#f9fafb", padding: "10px 14px", borderBottom: "1px solid #e5e7eb" }}>
            <div style={{ fontWeight: 600, color: "#111827" }}>功能开关</div>
            <div style={{ fontSize: 12, color: "#6b7280" }}>
              <code>XIAOLUO_FLAGS=-name</code> 也能即刻关；这里改的是工作区层
            </div>
          </header>
          {flagNames.map((name) => (
            <label
              key={name}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "10px 14px",
                borderTop: "1px solid #f3f4f6",
                fontSize: 13,
              }}
            >
              <span>
                <span style={{ fontFamily: "ui-monospace, monospace" }}>{name}</span>
                <span style={{ marginLeft: 8, fontSize: 12, color: "#6b7280" }}>
                  {SOURCE_LABEL[payload.flagSources[name] ?? ""] ?? payload.flagSources[name] ?? ""}
                </span>
              </span>
              <input
                type="checkbox"
                checked={Boolean(payload.flags[name])}
                disabled={busy || payload.flagSources[name] === "env"}
                onChange={(event) => void toggleFlag(name, event.target.checked)}
              />
            </label>
          ))}
        </section>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy || !dirtyKeys.length}
          style={{
            padding: "8px 16px",
            borderRadius: 8,
            border: "none",
            background: dirtyKeys.length ? "#111827" : "#e5e7eb",
            color: dirtyKeys.length ? "#fff" : "#9ca3af",
            cursor: dirtyKeys.length ? "pointer" : "not-allowed",
            fontSize: 13,
          }}
        >
          保存{dirtyKeys.length ? `（${dirtyKeys.length} 项）` : ""}
        </button>
        <button
          type="button"
          onClick={() => setDraft({})}
          disabled={!dirtyKeys.length}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            padding: "8px 12px",
            borderRadius: 8,
            border: "1px solid #e5e7eb",
            background: "#fff",
            color: "#374151",
            fontSize: 13,
            cursor: dirtyKeys.length ? "pointer" : "not-allowed",
          }}
        >
          <RotateCcw size={14} />
          还原改动
        </button>
        {notice && <span style={{ fontSize: 12, color: "#6b7280" }}>{notice}</span>}
      </div>
    </div>
  );
}
