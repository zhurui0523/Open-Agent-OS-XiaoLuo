/**
 * 小逻 v3 —— 大模型选择器（对话器输入条的"模型 ∨"胶囊）
 *
 * 形态对齐对话器头部的角色选择器（"✨ 小逻 ∨"）：
 *  - 触发器：浅灰白胶囊 + 前缀图标 + 当前模型名 + ▾ 箭头；
 *  - 面板：白色 12px 圆角浮层，向上弹出（输入条在底部），分组列表 + 选中对勾；
 *  - 点外部 / Esc 收起。
 *
 * 样式自包含（inline style），主工程集成时可按 SelectMenu 规范替换为 className 方案。
 * 注意：老板显式选定模型后禁止静默回退（既有决策）——选中值由宿主持有并透传 callLLM。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";

export interface ModelOption {
  /** 模型 id（透传 callLLM 的 model 字段） */
  id: string;
  /** 显示名（如 gpt-5.6-sol / qwen-max） */
  label: string;
  /** 一句话说明（面板内灰色小字，可选） */
  description?: string;
  /** 分组名（如"企业共享"/"本地模型"，缺省归入"大模型"组） */
  group?: string;
}

export interface ModelPickerProps {
  options: ModelOption[];
  /** 当前选中的模型 id */
  value?: string;
  onChange: (id: string) => void;
  /** 触发器前缀文案（默认"模型"） */
  prefix?: string;
  disabled?: boolean;
}

const DEFAULT_GROUP = "大模型";

const styles: Record<string, CSSProperties> = {
  root: { position: "relative", display: "inline-block", fontSize: 13 },
  trigger: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "6px 12px",
    borderRadius: 999,
    border: "1px solid #e0e4ea",
    background: "#f5f7fa",
    color: "#334155",
    cursor: "pointer",
    fontSize: 13,
    lineHeight: 1.2,
    whiteSpace: "nowrap",
    userSelect: "none",
  },
  triggerDisabled: { opacity: 0.5, cursor: "not-allowed" },
  prefix: { color: "#64748b" },
  value: { fontWeight: 600 },
  chevron: {
    fontSize: 10,
    color: "#64748b",
    transition: "transform 0.15s ease",
    display: "inline-block",
  },
  panel: {
    position: "absolute",
    bottom: "calc(100% + 8px)", // 输入条在底部 → 面板向上弹出
    left: 0,
    minWidth: 240,
    maxWidth: 320,
    maxHeight: 320,
    overflowY: "auto",
    background: "#fff",
    border: "1px solid #e5e8ee",
    borderRadius: 12,
    boxShadow: "0 10px 30px rgba(15, 23, 42, 0.12)",
    padding: "6px",
    zIndex: 40,
  },
  groupLabel: {
    padding: "8px 10px 4px",
    fontSize: 11,
    color: "#94a3b8",
    letterSpacing: 0.5,
  },
  item: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    padding: "8px 10px",
    borderRadius: 8,
    cursor: "pointer",
    color: "#334155",
  },
  itemActive: { background: "#f0f2f5", fontWeight: 600 },
  itemDesc: { fontSize: 11, color: "#94a3b8", marginTop: 2 },
  check: { color: "#4f6ef7", fontSize: 13, flexShrink: 0 },
  empty: { padding: "12px 10px", color: "#94a3b8", fontSize: 12 },
};

export function ModelPicker({ options, value, onChange, prefix = "模型", disabled }: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const current = options.find((o) => o.id === value);

  /** 按分组归并（保持选项原序） */
  const groups = useMemo(() => {
    const map = new Map<string, ModelOption[]>();
    for (const opt of options) {
      const key = opt.group ?? DEFAULT_GROUP;
      const list = map.get(key) ?? [];
      list.push(opt);
      map.set(key, list);
    }
    return [...map.entries()];
  }, [options]);

  // 点外部 / Esc 收起
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} style={styles.root}>
      <button
        type="button"
        style={{ ...styles.trigger, ...(disabled ? styles.triggerDisabled : {}) }}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        title="选择大模型"
      >
        <span style={styles.prefix}>✦ {prefix}</span>
        <span style={styles.value}>{current?.label ?? "未选择"}</span>
        <span style={{ ...styles.chevron, transform: open ? "rotate(180deg)" : "none" }}>▾</span>
      </button>

      {open && (
        <div style={styles.panel}>
          {options.length === 0 && <div style={styles.empty}>暂无可用模型</div>}
          {groups.map(([groupName, items]) => (
            <div key={groupName}>
              {groups.length > 1 && <div style={styles.groupLabel}>{groupName}</div>}
              {items.map((opt) => {
                const active = opt.id === value;
                return (
                  <div
                    key={opt.id}
                    style={{ ...styles.item, ...(active ? styles.itemActive : {}) }}
                    onClick={() => {
                      onChange(opt.id);
                      setOpen(false);
                    }}
                    onMouseEnter={(e) => {
                      if (!active) e.currentTarget.style.background = "#f5f7fa";
                    }}
                    onMouseLeave={(e) => {
                      if (!active) e.currentTarget.style.background = "transparent";
                    }}
                  >
                    <div>
                      <div>{opt.label}</div>
                      {opt.description && <div style={styles.itemDesc}>{opt.description}</div>}
                    </div>
                    {active && <span style={styles.check}>✓</span>}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
