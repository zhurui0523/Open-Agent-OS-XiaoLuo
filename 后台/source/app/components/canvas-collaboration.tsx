"use client";

import {
  AtSign,
  Check,
  CircleAlert,
  MessageCircle,
  RefreshCw,
  Send,
  Users,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

export interface CollaborationPresence {
  userId: string;
  username: string;
  displayName: string;
  sessionId: string;
  cursorX: number | null;
  cursorY: number | null;
  selectedNodeIds: string[];
  clientRevision: number;
  lastSeenAt: string;
}

interface CollaborationComment {
  id: string;
  nodeId: string | null;
  authorUserId: string;
  username: string;
  displayName: string;
  content: string;
  mentions: Array<{ userId: string; username: string }>;
  status: "open" | "resolved";
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface CollaborationEvent {
  sequence: number;
  actorUserId: string;
  sessionId: string | null;
  eventType: string;
  canvasRevision: number | null;
}

interface CollaborationPayload {
  self: {
    id: string;
    username: string;
    displayName: string;
    sessionId: string;
  };
  canvasRevision: number;
  presence: CollaborationPresence[];
  comments: CollaborationComment[];
  events: CollaborationEvent[];
  cursor: number;
}

async function jsonRequest<T>(url: string, init?: RequestInit) {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const payload = (await response.json().catch(() => ({}))) as T & {
    error?: string;
  };
  if (!response.ok) {
    const error = new Error(payload.error ?? `协作请求失败（${response.status}）`);
    Object.assign(error, { status: response.status });
    throw error;
  }
  return payload;
}

export function useCanvasCollaboration(input: {
  canvasId: string;
  sessionId: string;
  selectedNodeIds: string[];
  canvasRevision: number;
  cursorRef: RefObject<{ x: number; y: number } | null>;
}) {
  const [presence, setPresence] = useState<CollaborationPresence[]>([]);
  const [comments, setComments] = useState<CollaborationComment[]>([]);
  const [selfId, setSelfId] = useState("");
  const [remoteRevision, setRemoteRevision] = useState(0);
  const [accessRevoked, setAccessRevoked] = useState(false);
  const [error, setError] = useState("");
  const eventCursor = useRef(0);
  const heartbeatTimer = useRef<number | null>(null);
  const selectedNodeIdsRef = useRef(input.selectedNodeIds);
  const canvasRevisionRef = useRef(input.canvasRevision);
  const accessRevokedRef = useRef(accessRevoked);

  useEffect(() => {
    selectedNodeIdsRef.current = input.selectedNodeIds;
    canvasRevisionRef.current = input.canvasRevision;
    accessRevokedRef.current = accessRevoked;
  }, [accessRevoked, input.canvasRevision, input.selectedNodeIds]);

  const heartbeat = useCallback(async () => {
    if (!input.canvasId || accessRevokedRef.current) return;
    try {
      await jsonRequest("/api/v2/collaboration", {
        method: "POST",
        body: JSON.stringify({
          canvasId: input.canvasId,
          sessionId: input.sessionId,
          action: "heartbeat",
          cursor: input.cursorRef.current,
          selectedNodeIds: selectedNodeIdsRef.current,
          clientRevision: canvasRevisionRef.current,
        }),
      });
    } catch (cause) {
      if ((cause as { status?: number }).status === 403) {
        accessRevokedRef.current = true;
        setAccessRevoked(true);
      }
    }
  }, [input.canvasId, input.cursorRef, input.sessionId]);

  const scheduleHeartbeat = useCallback(() => {
    if (heartbeatTimer.current !== null) return;
    heartbeatTimer.current = window.setTimeout(() => {
      heartbeatTimer.current = null;
      void heartbeat();
    }, 350);
  }, [heartbeat]);

  const poll = useCallback(async () => {
    if (!input.canvasId || accessRevokedRef.current) return;
    try {
      const payload = await jsonRequest<CollaborationPayload>(
        `/api/v2/collaboration?canvasId=${encodeURIComponent(input.canvasId)}&sessionId=${encodeURIComponent(input.sessionId)}&after=${eventCursor.current}`,
      );
      eventCursor.current = payload.cursor;
      setSelfId(payload.self.id);
      setPresence(payload.presence);
      setComments(payload.comments);
      const newestRemoteRevision = payload.events.reduce(
        (current, event) =>
          event.actorUserId !== payload.self.id &&
          event.sessionId !== input.sessionId &&
          typeof event.canvasRevision === "number"
            ? Math.max(current, event.canvasRevision)
            : current,
        payload.canvasRevision > canvasRevisionRef.current
          ? payload.canvasRevision
          : 0,
      );
      setRemoteRevision((current) =>
        Math.max(current, newestRemoteRevision),
      );
      setError("");
    } catch (cause) {
      if ((cause as { status?: number }).status === 403) {
        accessRevokedRef.current = true;
        setAccessRevoked(true);
        setError("你的画布访问权限已被撤销，协作连接已停止。");
      } else {
        setError(cause instanceof Error ? cause.message : "协作连接暂时不可用");
      }
    }
  }, [input.canvasId, input.sessionId]);

  useEffect(() => {
    eventCursor.current = 0;
    if (!input.canvasId) return;
    const firstPoll = window.setTimeout(() => {
      setPresence([]);
      setComments([]);
      setRemoteRevision(0);
      setAccessRevoked(false);
      setError("");
      void heartbeat();
      void poll();
    }, 0);
    const pollTimer = window.setInterval(() => {
      // 标签页切到后台时暂停轮询，降低资源占用
      if (document.visibilityState !== "visible") return;
      void poll();
    }, 2_000);
    const heartbeatInterval = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void heartbeat();
    }, 8_000);
    return () => {
      window.clearTimeout(firstPoll);
      window.clearInterval(pollTimer);
      window.clearInterval(heartbeatInterval);
      if (heartbeatTimer.current !== null) {
        window.clearTimeout(heartbeatTimer.current);
        heartbeatTimer.current = null;
      }
      void fetch("/api/v2/collaboration", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          canvasId: input.canvasId,
          sessionId: input.sessionId,
          action: "leave",
        }),
        keepalive: true,
      });
    };
  }, [heartbeat, input.canvasId, input.sessionId, poll]);

  useEffect(() => {
    scheduleHeartbeat();
  }, [
    input.canvasRevision,
    input.selectedNodeIds,
    scheduleHeartbeat,
  ]);

  const createComment = useCallback(
    async (content: string, nodeId: string | null) => {
      await jsonRequest("/api/v2/collaboration", {
        method: "POST",
        body: JSON.stringify({
          canvasId: input.canvasId,
          sessionId: input.sessionId,
          action: "comment.create",
          content,
          nodeId,
        }),
      });
      await poll();
    },
    [input.canvasId, input.sessionId, poll],
  );

  const resolveComment = useCallback(
    async (commentId: string) => {
      await jsonRequest("/api/v2/collaboration", {
        method: "POST",
        body: JSON.stringify({
          canvasId: input.canvasId,
          sessionId: input.sessionId,
          action: "comment.resolve",
          commentId,
        }),
      });
      await poll();
    },
    [input.canvasId, input.sessionId, poll],
  );

  return {
    presence,
    comments,
    selfId,
    remoteRevision,
    accessRevoked,
    error,
    scheduleHeartbeat,
    refresh: poll,
    createComment,
    resolveComment,
    acknowledgeRemoteRevision: () => setRemoteRevision(0),
  };
}

export function CanvasCollaborationPanel({
  presence,
  comments,
  selfId,
  remoteRevision,
  accessRevoked,
  error,
  selectedNodeId,
  onRefresh,
  onReloadCanvas,
  onAcknowledgeRemoteRevision,
  onCreateComment,
  onResolveComment,
}: {
  presence: CollaborationPresence[];
  comments: CollaborationComment[];
  selfId: string;
  remoteRevision: number;
  accessRevoked: boolean;
  error: string;
  selectedNodeId: string | null;
  onRefresh: () => Promise<void>;
  onReloadCanvas: () => Promise<void>;
  onAcknowledgeRemoteRevision: () => void;
  onCreateComment: (content: string, nodeId: string | null) => Promise<void>;
  onResolveComment: (commentId: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const openComments = comments.filter((comment) => comment.status === "open");
  const visiblePresence = Array.from(
    new Map(
      presence
        .filter((item) => item.userId !== selfId)
        .map((item) => [item.userId, item]),
    ).values(),
  );

  async function submit() {
    const content = draft.trim();
    if (!content || busy) return;
    setBusy(true);
    try {
      await onCreateComment(content, selectedNodeId);
      setDraft("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="canvas-collaboration">
      <div className="collaboration-presence" aria-label="在线协作者">
        {visiblePresence.slice(0, 4).map((item, index) => (
          <span
            key={item.userId}
            title={`${item.displayName} 在线`}
            style={{ zIndex: 10 - index }}
          >
            {item.displayName.trim().slice(0, 1).toUpperCase()}
          </span>
        ))}
        <small>
          <Users size={13} />
          {visiblePresence.length + 1}
        </small>
      </div>
      <button
        type="button"
        className={`secondary-button compact collaboration-button ${open ? "is-active" : ""}`}
        onClick={() => setOpen((current) => !current)}
      >
        <MessageCircle size={15} />
        评论
        {openComments.length > 0 && <b>{openComments.length}</b>}
      </button>
      {remoteRevision > 0 && !accessRevoked && (
        <button
          type="button"
          className="collaboration-sync-alert"
          onClick={async () => {
            await onReloadCanvas();
            onAcknowledgeRemoteRevision();
          }}
        >
          <RefreshCw size={13} /> 有协作者更新，点击同步
        </button>
      )}
      {open && (
        <aside className="collaboration-panel" aria-label="画布协作评论">
          <header>
            <div>
              <b>协作评论</b>
              <small>输入 @用户名 可提及成员</small>
            </div>
            <button type="button" aria-label="关闭评论" onClick={() => setOpen(false)}>
              <X size={16} />
            </button>
          </header>
          {(accessRevoked || error) && (
            <div className={`collaboration-message ${accessRevoked ? "is-error" : ""}`}>
              <CircleAlert size={14} /> {error || "协作连接已停止"}
            </div>
          )}
          <div className="collaboration-comment-list">
            {comments.map((comment) => (
              <article
                key={comment.id}
                className={comment.status === "resolved" ? "is-resolved" : ""}
              >
                <div>
                  <span>{comment.displayName.trim().slice(0, 1)}</span>
                  <b>{comment.displayName}</b>
                  <time>{new Date(comment.createdAt).toLocaleString("zh-CN")}</time>
                </div>
                <p>{comment.content}</p>
                <footer>
                  {comment.nodeId && <code>节点 {comment.nodeId.slice(0, 8)}</code>}
                  {comment.mentions.length > 0 && (
                    <span><AtSign size={12} /> {comment.mentions.length} 人</span>
                  )}
                  {comment.status === "open" ? (
                    <button
                      type="button"
                      onClick={() => void onResolveComment(comment.id)}
                    >
                      <Check size={12} /> 解决
                    </button>
                  ) : (
                    <em>已解决</em>
                  )}
                </footer>
              </article>
            ))}
            {!comments.length && <p className="collaboration-empty">还没有评论。</p>}
          </div>
          <div className="collaboration-composer">
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={
                selectedNodeId
                  ? "评论将关联到当前节点…"
                  : "添加画布评论，使用 @用户名 提及成员…"
              }
              maxLength={2_000}
              disabled={accessRevoked}
            />
            <button
              type="button"
              className="primary-button"
              disabled={!draft.trim() || busy || accessRevoked}
              onClick={() => void submit()}
            >
              <Send size={14} /> 发送
            </button>
          </div>
          <button type="button" className="collaboration-refresh" onClick={() => void onRefresh()}>
            <RefreshCw size={12} /> 刷新协作状态
          </button>
        </aside>
      )}
    </div>
  );
}
