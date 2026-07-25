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
  Trash2,
} from "lucide-react";
import { useRef, useState } from "react";
import type {
  ChatAttachment,
  ChatMessage,
  Capability,
  IntentPlan,
  RunState,
} from "../types";
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
  capabilities: Capability[];
  onSubmit: (
    value: string,
    attachments?: ChatAttachment[],
    preferredCapabilityId?: string,
  ) => void;
  onUploadAttachments: (files: File[]) => Promise<ChatAttachment[]>;
  onConfirmPlan: () => void | Promise<void>;
  onUpdatePlan: (plan: IntentPlan) => void | Promise<void>;
  onRejectPlan: () => void | Promise<void>;
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
  capabilities,
  onSubmit,
  onUploadAttachments,
  onConfirmPlan,
  onUpdatePlan,
  onRejectPlan,
  onStart,
  onPause,
  onCancel,
}: IntentConsoleProps) {
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [editingPlan, setEditingPlan] = useState(false);
  const [planDraft, setPlanDraft] = useState<IntentPlan | null>(null);
  const [preferredCapabilityId, setPreferredCapabilityId] = useState("auto");
  const attachmentRef = useRef<HTMLInputElement>(null);

  function submit() {
    if (!draft.trim()) return;
    onSubmit(
      draft,
      attachments,
      preferredCapabilityId === "auto" ? undefined : preferredCapabilityId,
    );
    setDraft("");
    setAttachments([]);
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
              {!!message.attachments?.length && (
                <div className="message-attachments">
                  {message.attachments.map((attachment) => (
                    <span key={attachment.id}>
                      <Paperclip size={11} /> {attachment.name}
                    </span>
                  ))}
                </div>
              )}
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
            {editingPlan && planDraft ? (
              <input
                className="plan-edit-goal"
                aria-label="计划目标"
                value={planDraft.goal}
                onChange={(event) =>
                  setPlanDraft({ ...planDraft, goal: event.target.value })
                }
              />
            ) : (
              <h3>{plan.goal}</h3>
            )}
            <div className="plan-tasks">
              {(editingPlan && planDraft ? planDraft : plan).tasks.map((task, index) => (
                <div key={task.id} className="plan-task">
                  <span>{index + 1}</span>
                  <div>
                    {editingPlan && planDraft ? (
                      <>
                        <input
                          aria-label={`任务 ${index + 1} 标题`}
                          value={task.title}
                          onChange={(event) =>
                            setPlanDraft({
                              ...planDraft,
                              tasks: planDraft.tasks.map((item, itemIndex) =>
                                itemIndex === index
                                  ? { ...item, title: event.target.value }
                                  : item,
                              ),
                            })
                          }
                        />
                        <input
                          aria-label={`任务 ${index + 1} 能力`}
                          value={task.capability}
                          onChange={(event) =>
                            setPlanDraft({
                              ...planDraft,
                              tasks: planDraft.tasks.map((item, itemIndex) =>
                                itemIndex === index
                                  ? { ...item, capability: event.target.value }
                                  : item,
                              ),
                            })
                          }
                        />
                      </>
                    ) : (
                      <>
                        <b>{task.title}</b>
                        <small>
                          {task.capability} · {task.duration}
                        </small>
                      </>
                    )}
                  </div>
                  {editingPlan && planDraft && planDraft.tasks.length > 1 && (
                    <button
                      type="button"
                      aria-label={`删除任务 ${index + 1}`}
                      onClick={() =>
                        setPlanDraft({
                          ...planDraft,
                          tasks: planDraft.tasks.filter(
                            (_, itemIndex) => itemIndex !== index,
                          ),
                        })
                      }
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
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
              <button
                type="button"
                className="danger-text-button"
                onClick={() => void onRejectPlan()}
              >
                取消计划
              </button>
              {editingPlan && planDraft ? (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={!planDraft.goal.trim() || !planDraft.tasks.length}
                  onClick={() => {
                    void onUpdatePlan(planDraft);
                    setEditingPlan(false);
                  }}
                >
                  保存调整
                </button>
              ) : (
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => {
                    setPlanDraft({
                      ...plan,
                      tasks: plan.tasks.map((task) => ({ ...task })),
                    });
                    setEditingPlan(true);
                  }}
                >
                  调整计划
                </button>
              )}
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

        {(runState === "running" ||
          runState === "waiting" ||
          runState === "paused") && (
          <div className="run-control-card">
            <div>
              <span className={`run-pulse ${runState === "paused" ? "is-paused" : ""}`} />
              <div>
                <strong>
                  {runState === "waiting"
                    ? "等待第三方模型结果"
                    : runState === "running"
                      ? "工作流执行中"
                      : "工作流已暂停"}
                </strong>
                <small>
                  {runState === "waiting"
                    ? "异步任务完成后会自动继续执行下游节点"
                    : "运行状态来自当前 Run 投影"}
                </small>
              </div>
            </div>
            <div>
              {runState === "running" || runState === "waiting" ? (
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

        {(runState === "succeeded" ||
          runState === "failed" ||
          runState === "canceled") && (
          <div className={`run-ready-card run-result-${runState}`}>
            <span className="run-ready-icon">
              {runState === "succeeded" ? (
                <Check size={18} />
              ) : runState === "failed" ? (
                <AlertTriangle size={18} />
              ) : (
                <CircleStop size={18} />
              )}
            </span>
            <div>
              <strong>
                {runState === "succeeded"
                  ? "AI 微内核执行完成"
                  : runState === "failed"
                    ? "工作流执行失败"
                    : "工作流已取消"}
              </strong>
              <small>
                {runState === "succeeded"
                  ? "节点结果已按连线完成传递并记录"
                  : "可检查失败节点后重新运行"}
              </small>
            </div>
            <button type="button" className="secondary-button" onClick={onStart}>
              <RotateCcw size={14} /> 重新运行
            </button>
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
        {!!attachments.length && (
          <div className="composer-attachments">
            {attachments.map((attachment) => (
              <span key={attachment.id}>
                <Paperclip size={12} />
                {attachment.name}
                <button
                  type="button"
                  aria-label={`移除附件 ${attachment.name}`}
                  onClick={() =>
                    setAttachments((current) =>
                      current.filter((item) => item.id !== attachment.id),
                    )
                  }
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
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
              <IconButton
                label={uploading ? "正在上传附件" : "添加附件"}
                onClick={() => attachmentRef.current?.click()}
              >
                <Paperclip size={17} />
              </IconButton>
              <label className="composer-skill">
                <MessageSquareText size={15} />
                <select
                  aria-label="意图首选能力"
                  value={preferredCapabilityId}
                  onChange={(event) => setPreferredCapabilityId(event.target.value)}
                >
                  <option value="auto">自动选择能力</option>
                  {capabilities
                    .filter((capability) => capability.enabled)
                    .map((capability) => (
                      <option key={capability.id} value={capability.id}>
                        {capability.title}
                      </option>
                    ))}
                </select>
                <ChevronDown size={13} />
              </label>
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
        <input
          ref={attachmentRef}
          className="canvas-file-input"
          type="file"
          multiple
          disabled={uploading}
          onChange={(event) => {
            const files = [...(event.target.files ?? [])];
            event.currentTarget.value = "";
            if (!files.length) return;
            setUploading(true);
            void onUploadAttachments(files)
              .then((uploaded) =>
                setAttachments((current) => [...current, ...uploaded].slice(0, 8)),
              )
              .finally(() => setUploading(false));
          }}
        />
        <small className="composer-note">AI 会先生成可检查计划，不会未经确认直接执行。</small>
      </div>
    </aside>
  );
}
