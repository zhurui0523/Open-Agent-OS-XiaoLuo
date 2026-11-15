/**
 * 插件能力授权面板（P1-4）。
 * 用户在这里逐项开关；开关只说明"这一类允许"，每次调用仍受围栏与白名单二次约束。
 */
"use client";

import { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";

interface CapabilityRow {
  id: string;
  label: string;
  scope: string;
  granted: boolean;
}

export function PluginCapabilitiesPanel() {
  const [rows, setRows] = useState<CapabilityRow[]>([]);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/v2/plugins/capability");
        if (!res.ok) return;
        const payload = (await res.json()) as { capabilities?: CapabilityRow[] };
        if (!cancelled) setRows(payload.capabilities ?? []);
      } catch {
        // 未登录/离线时静默：这里是设置面板，不该弹错误
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function toggle(row: CapabilityRow) {
    setBusy(row.id);
    setNotice("");
    const next = rows.map((item) => (item.id === row.id ? { ...item, granted: !item.granted } : item));
    setRows(next);
    try {
      const res = await fetch("/api/v2/plugins/capability", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ capabilities: next.filter((item) => item.granted).map((item) => item.id) }),
      });
      if (!res.ok) throw new Error("保存失败");
      setNotice(row.granted ? `已关闭「${row.label}」` : `已开启「${row.label}」：${row.scope}`);
    } catch {
      setRows(rows);
      setNotice("授权保存失败，稍后重试。");
    } finally {
      setBusy("");
    }
  }

  if (!rows.length) return null;

  return (
    <div style={{ marginTop: 14, borderTop: "1px solid #f3f4f6", paddingTop: 10 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          color: "#374151",
          fontWeight: 600,
          marginBottom: 4,
        }}
      >
        <ShieldCheck size={13} style={{ color: "#4f46e5" }} />
        插件能力授权
      </div>
      <div style={{ color: "#9ca3af", fontSize: 11, lineHeight: 1.6, marginBottom: 8 }}>
        默认全关。开启只表示这一类允许，具体每次调用仍受工作区围栏与网络白名单约束。
      </div>
      {rows.map((row) => (
        <div key={row.id} style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "4px 0" }}>
          <button
            type="button"
            role="switch"
            aria-checked={row.granted}
            aria-label={`插件能力 ${row.label}`}
            disabled={busy === row.id}
            onClick={() => void toggle(row)}
            style={{
              flexShrink: 0,
              width: 34,
              height: 18,
              borderRadius: 999,
              border: "1px solid " + (row.granted ? "#c7d2fe" : "#e5e7eb"),
              background: row.granted ? "#4f46e5" : "#f3f4f6",
              cursor: busy === row.id ? "default" : "pointer",
              position: "relative",
            }}
          >
            <span
              style={{
                position: "absolute",
                top: 1,
                left: row.granted ? 17 : 1,
                width: 14,
                height: 14,
                borderRadius: "50%",
                background: "#fff",
                transition: "left 120ms",
              }}
            />
          </button>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: "block", color: "#374151" }}>
              {row.label}
              <span style={{ color: "#9ca3af", marginLeft: 6, fontSize: 11 }}>{row.id}</span>
            </span>
            <span style={{ display: "block", color: "#9ca3af", fontSize: 11, lineHeight: 1.5 }}>{row.scope}</span>
          </span>
        </div>
      ))}
      {notice ? <div style={{ color: "#4b5563", fontSize: 11, marginTop: 6 }}>{notice}</div> : null}
    </div>
  );
}
