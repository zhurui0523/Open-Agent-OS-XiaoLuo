"use client";

import { Check, ChevronDown, ChevronRight, Plus, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { SUNO_STYLE_TAG_GROUPS } from "../lib/model-protocol-options";

interface StyleTagsFieldProps {
  value: string;
  maxLength?: number;
  onChange: (value: string) => void;
}

function parseTags(value: string) {
  return value
    .split(/[,，]/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function splitGroupName(name: string) {
  const matched = name.match(/^(.+?)\s+([A-Za-z].*)$/);
  return matched
    ? { zh: matched[1], en: matched[2] }
    : { zh: name, en: "" };
}

// 风格标签选择器：预设风格使用“分类 + 二级风格”的悬浮菜单，
// 悬停或聚焦分类即可切换子菜单；具体风格支持多选，也支持手动输入自定义标签。
export function StyleTagsField({
  value,
  maxLength,
  onChange,
}: StyleTagsFieldProps) {
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelOpenUp, setPanelOpenUp] = useState(false);
  const [panelMaxHeight, setPanelMaxHeight] = useState(320);
  const [draft, setDraft] = useState("");
  const [groupName, setGroupName] = useState(
    SUNO_STYLE_TAG_GROUPS[0]?.name ?? "",
  );
  const fieldRef = useRef<HTMLDivElement>(null);
  const tags = parseTags(value);
  const selected = new Set(tags);
  const activeOptions =
    SUNO_STYLE_TAG_GROUPS.find((group) => group.name === groupName)
      ?.options ?? [];
  const activeGroupLabel = splitGroupName(groupName);

  const commit = (next: string[]) => {
    const joined = [...new Set(next)].filter(Boolean).join(",");
    onChange(maxLength ? joined.slice(0, maxLength) : joined);
  };

  const toggleTag = (tag: string) => {
    commit(
      selected.has(tag)
        ? tags.filter((item) => item !== tag)
        : [...tags, tag],
    );
  };

  const addDraft = () => {
    const additions = parseTags(draft);
    if (!additions.length) return;
    commit([...tags, ...additions]);
    setDraft("");
  };

  // The execution node clips content to its own scrolling viewport. Measure the
  // real space around the trigger so the floating menu stays fully visible
  // instead of being cut off at the top of the node.
  useLayoutEffect(() => {
    if (!panelOpen) return;
    const field = fieldRef.current;
    const trigger = field?.querySelector<HTMLElement>(".style-tags-toggle");
    if (!field || !trigger) return;

    const triggerRect = trigger.getBoundingClientRect();
    const scrollHost = field.closest<HTMLElement>(".node-workbench-content");
    const nodeHost = field.closest<HTMLElement>(".canvas-node");
    const bounds =
      scrollHost?.getBoundingClientRect() ??
      nodeHost?.getBoundingClientRect() ?? {
        top: 0,
        bottom: window.innerHeight,
      };
    const gap = 8;
    const spaceAbove = Math.max(0, triggerRect.top - bounds.top - gap);
    const spaceBelow = Math.max(0, bounds.bottom - triggerRect.bottom - gap);
    const openUp = spaceAbove >= spaceBelow;
    const available = openUp ? spaceAbove : spaceBelow;

    setPanelOpenUp(openUp);
    setPanelMaxHeight(Math.max(120, Math.min(360, Math.floor(available))));
  }, [panelOpen]);

  // 点击组件外部或按 Esc 时收起下拉菜单
  useEffect(() => {
    if (!panelOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!fieldRef.current?.contains(event.target as Node)) {
        setPanelOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPanelOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [panelOpen]);

  return (
    <div className="style-tags-field" ref={fieldRef}>
      {tags.length > 0 && (
        <div className="style-tags-selected">
          {tags.map((tag) => (
            <span className="style-tags-chip" key={tag}>
              {tag}
              <button
                type="button"
                aria-label={`移除风格标签 ${tag}`}
                onClick={() => toggleTag(tag)}
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="style-tags-custom">
        <input
          value={draft}
          placeholder="自定义风格，如：R&B、国风，逗号分隔"
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              addDraft();
            }
          }}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="button" onClick={addDraft}>
          <Plus size={13} /> 添加
        </button>
      </div>
      <div className="style-tags-dropdown">
        <button
          type="button"
          className={`style-tags-toggle${panelOpen ? " is-open" : ""}`}
          onClick={() => setPanelOpen((open) => !open)}
        >
          选择预设风格
          {tags.length > 0 && (
            <span className="style-tags-toggle-count">{tags.length}</span>
          )}
          <ChevronDown size={14} className="style-tags-toggle-caret" />
        </button>
        {panelOpen && (
          <div
            className={`style-tags-panel${panelOpenUp ? " is-up" : ""}`}
            style={{ maxHeight: panelMaxHeight }}
          >
            <div className="style-tags-groups" aria-label="风格分类">
              {SUNO_STYLE_TAG_GROUPS.map((group) => {
                const label = splitGroupName(group.name);
                const selectedCount = group.options.filter((option) =>
                  selected.has(option.zh),
                ).length;
                return (
                  <button
                    key={group.name}
                    type="button"
                    className={`style-tags-group${
                      group.name === groupName ? " is-active" : ""
                    }`}
                    onMouseEnter={() => setGroupName(group.name)}
                    onFocus={() => setGroupName(group.name)}
                    onClick={() => setGroupName(group.name)}
                  >
                    <span className="style-tags-group-copy">
                      <strong>{label.zh}</strong>
                      {label.en && <small>{label.en}</small>}
                    </span>
                    {selectedCount > 0 && (
                      <span className="style-tags-group-count">
                        {selectedCount}
                      </span>
                    )}
                    <ChevronRight size={13} aria-hidden />
                  </button>
                );
              })}
            </div>
            <div className="style-tags-submenu">
              <div className="style-tags-submenu-heading">
                <strong>{activeGroupLabel.zh}</strong>
                {activeGroupLabel.en && <span>{activeGroupLabel.en}</span>}
              </div>
              <div className="style-tags-menu" aria-label={`${groupName}风格`}>
                {activeOptions.map((option) => {
                  const isActive = selected.has(option.zh);
                  return (
                    <button
                      key={option.en}
                      type="button"
                      title={option.en}
                      className={`style-tags-menu-item${
                        isActive ? " is-active" : ""
                      }`}
                      onClick={() => toggleTag(option.zh)}
                    >
                      <span className="style-tags-menu-label">{option.zh}</span>
                      <span className="style-tags-menu-en">{option.en}</span>
                      {isActive && (
                        <Check
                          size={14}
                          className="style-tags-menu-check"
                          aria-hidden
                        />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
