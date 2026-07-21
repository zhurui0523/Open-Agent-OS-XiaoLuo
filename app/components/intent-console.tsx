"use client";

import {
  AlertTriangle,
  Check,
  ChevronDown,
  CircleStop,
  ListChecks,
  MessageSquareText,
  PanelRightClose,
  Paperclip,
  Pause,
  Play,
  RotateCcw,
  Send,
  Sparkles,
} from "lucide-react";
import { useState } from "react";
import type { ChatMessage, IntentPlan, RunState } from "../types";
import { IconButton } from "./icon-button";

const suggestions = [
  "把当前脚本扩展成 30 秒品牌短片",
  "为这个角色建立统一视觉 DNA",
  "检查画布中可能失败的依赖",
];

interface IntentConsoleProps {
  messages: ChatMessage[];
  plan: IntentPlan | null;
  isPlanning: boolean;
  runState: RunState;
  onClose: () => void;
  onSubmit: (value: string) => void;
  onConfirmPlan: () => void;
  onStart: () => void;
  onPause: () => void;
  onCancel: () => void;
}

export function IntentConsole({
  messages,
  plan,
  isPlanning,
  runState,
  onClose,
  onSubmit,
  onConfirmPlan,
  onStart,
  onPause,
  onCancel,
}: IntentConsoleProps) {
  const [draft, setDraft] = useState("");

  function submit() {
    if (!draft.trim()) return;
    onSubmit(draft);
    setDraft("");
  }

  return (
    <aside className="intent-console" aria-label="Intent Console">
      <div className="console-header">
        <div className="console-title">
          <span className="console-logo">
            <Sparkles size={17} />
          </span>
          <div>
            <strong>Intent Console</strong>
            <small>
              <i className="online-dot" /> Brain Planner 在线
            </small>
          </div>
        </div>
        <div className="console-header-actions">
          <button type="button" className="context-button">
            当前画布 <ChevronDown size={14} />
          </button>
          <IconButton label="折叠 Intent Console" onClick={onClose}>
            <PanelRightClose size={17} />
          </IconButton>
        </div>
      </div>

      <div className="console-messages" aria-live="polite">
        {messages.map((message) => (
          <div key={message.id} className={`message message-${message.role}`}>
            {message.role === "assistant" && (
              <span className="message-avatar">
                <Sparkles size={14} />
              </span>
            )}
            <div className="message-bubble">
              <p>{message.content}</p>
              <time>{message.time}</time>
            </div>
          </div>
        ))}

        {isPlanning && (
          <div className="planning-state">
            <span className="planning-orbit" />
            <div>
              <strong>正在理解意图并检查能力…</strong>
              <small>生成目标、任务依赖与成本估计</small>
            </div>
          </div>
        )}

        {plan && (
          <section className="plan-card" aria-label="待确认计划">
            <div className="plan-heading">
              <span>
                <ListChecks size={17} /> 执行计划
              </span>
              <span className="plan-badge">待确认</span>
            </div>
            <h3>{plan.goal}</h3>
            <div className="plan-tasks">
              {plan.tasks.map((task, index) => (
                <div key={task.id} className="plan-task">
                  <span>{index + 1}</span>
                  <div>
                    <b>{task.title}</b>
                    <small>
                      {task.capability} · {task.duration}
                    </small>
                  </div>
                </div>
              ))}
            </div>
            {plan.warning && (
              <p className="plan-warning">
                <AlertTriangle size={14} /> {plan.warning}
              </p>
            )}
            <div className="plan-summary">
              <span>{plan.estimate}</span>
              <button type="button" className="secondary-button">
                调整计划
              </button>
              <button type="button" className="primary-button" onClick={onConfirmPlan}>
                <Check size={15} /> 确认并写入画布
              </button>
            </div>
          </section>
        )}

        {runState === "ready" && (
          <div className="run-ready-card">
            <span className="run-ready-icon">
              <Check size={18} />
            </span>
            <div>
              <strong>计划已写入画布</strong>
              <small>你可以先编辑任意节点，也可以直接运行。</small>
            </div>
            <button type="button" className="primary-button" onClick={onStart}>
              <Play size={15} /> 运行
            </button>
          </div>
        )}

        {(runState === "running" || runState === "paused") && (
          <div className="run-control-card">
            <div>
              <span className={`run-pulse ${runState === "paused" ? "is-paused" : ""}`} />
              <div>
                <strong>{runState === "running" ? "工作流执行中" : "工作流已暂停"}</strong>
                <small>运行状态来自当前 Run 投影</small>
              </div>
            </div>
            <div>
              {runState === "running" ? (
                <button type="button" className="secondary-button" onClick={onPause}>
                  <Pause size={14} /> 暂停
                </button>
              ) : (
                <button type="button" className="secondary-button" onClick={onStart}>
                  <RotateCcw size={14} /> 恢复
                </button>
              )}
              <button type="button" className="danger-text-button" onClick={onCancel}>
                <CircleStop size={14} /> 取消
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="suggestion-row" aria-label="意图建议">
        {suggestions.map((suggestion) => (
          <button key={suggestion} type="button" onClick={() => setDraft(suggestion)}>
            {suggestion}
          </button>
        ))}
      </div>

      <div className="composer-wrap">
        <div className="composer">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submit();
            }}
            aria-label="描述你的创作目标"
            placeholder="描述你想完成的目标…"
          />
          <div className="composer-footer">
            <div>
              <IconButton label="添加附件">
                <Paperclip size={17} />
              </IconButton>
              <button type="button" className="composer-skill">
                <MessageSquareText size={15} /> 自动选择能力
                <ChevronDown size={13} />
              </button>
            </div>
            <span>⌘ Enter 发送</span>
            <button
              type="button"
              className="send-button"
              aria-label="发送意图"
              disabled={!draft.trim() || isPlanning}
              onClick={submit}
            >
              <Send size={17} />
            </button>
          </div>
        </div>
        <small className="composer-note">AI 会先生成可检查计划，不会未经确认直接执行。</small>
      </div>
    </aside>
  );
}

