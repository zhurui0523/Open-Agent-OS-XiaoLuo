"use client";

import {
  Activity,
  Building2,
  Check,
  CircleAlert,
  FileText,
  HardDrive,
  Image as ImageIcon,
  KeyRound,
  LoaderCircle,
  Power,
  RefreshCcw,
  Search,
  ShieldCheck,
  Trash2,
  UsersRound,
  Video,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useState,
  type FormEvent,
} from "react";
import type { AccountUser } from "../types";
import { AdminOperations } from "./admin-operations";

type AdminTab = "overview" | "users" | "enterprises";

interface AdminCenterProps {
  user: AccountUser;
  onClose: () => void;
}

interface ManagedUser {
  id: string;
  username: string;
  email: string;
  displayName: string;
  phoneLast4: string | null;
  platformRole: "system_admin" | "user";
  status: "active" | "disabled";
  textCount: number;
  imageCount: number;
  videoCount: number;
  storageBytes: number;
  createdAt: string;
}

interface EnterpriseApplication {
  id: string;
  organizationName: string;
  registrationCode: string | null;
  contactName: string;
  note: string;
  applicantName: string;
  applicantEmail: string;
  phoneLast4: string | null;
  createdAt: string;
}

async function requestJson<T>(url: string, init?: RequestInit) {
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
  if (!response.ok) throw new Error(payload.error ?? "请求失败");
  return payload;
}

function formatBytes(value: number) {
  if (!value) return "0 B";
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}

export function AdminCenter({ user, onClose }: AdminCenterProps) {
  const [tab, setTab] = useState<AdminTab>("overview");
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [applications, setApplications] = useState<EnterpriseApplication[]>([]);
  const [search, setSearch] = useState("");
  const [pending, setPending] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [resetTarget, setResetTarget] = useState<ManagedUser | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const loadUsers = useCallback(async (query = "") => {
    setLoading(true);
    setError("");
    try {
      const suffix = query.trim()
        ? `?q=${encodeURIComponent(query.trim())}`
        : "";
      const payload = await requestJson<{ users: ManagedUser[] }>(
        `/api/v2/admin/users${suffix}`,
      );
      setUsers(payload.users);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "读取用户失败");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadApplications = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const payload = await requestJson<{
        applications: EnterpriseApplication[];
      }>("/api/v2/admin/enterprises");
      setApplications(payload.applications);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "读取企业申请失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab === "users" && users.length === 0) {
      const timer = window.setTimeout(() => void loadUsers(), 0);
      return () => window.clearTimeout(timer);
    }
    if (tab === "enterprises" && applications.length === 0) {
      const timer = window.setTimeout(() => void loadApplications(), 0);
      return () => window.clearTimeout(timer);
    }
  }, [applications.length, loadApplications, loadUsers, tab, users.length]);

  async function perform(
    operation: () => Promise<void>,
    successMessage?: string,
  ) {
    setPending(true);
    setError("");
    setMessage("");
    try {
      await operation();
      if (successMessage) setMessage(successMessage);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败");
    } finally {
      setPending(false);
    }
  }

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void loadUsers(search);
  }

  function updateUserStatus(target: ManagedUser) {
    const nextStatus = target.status === "active" ? "disabled" : "active";
    void perform(async () => {
      const payload = await requestJson<{ message: string }>(
        "/api/v2/admin/users",
        {
          method: "PATCH",
          body: JSON.stringify({ userId: target.id, status: nextStatus }),
        },
      );
      setMessage(payload.message);
      await loadUsers(search);
    });
  }

  function submitPasswordReset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!resetTarget) return;
    if (newPassword.length < 6) {
      setError("新密码至少需要 6 位");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("两次输入的密码不一致");
      return;
    }
    void perform(async () => {
      const payload = await requestJson<{ message: string }>(
        "/api/v2/admin/users",
        {
          method: "POST",
          body: JSON.stringify({
            userId: resetTarget.id,
            newPassword,
          }),
        },
      );
      setResetTarget(null);
      setNewPassword("");
      setConfirmPassword("");
      setMessage(payload.message);
    });
  }

  function deleteUser(target: ManagedUser) {
    const accepted = window.confirm(
      `确定删除用户 @${target.username} 吗？\n\n账号将失去登录权限，邮箱、手机号等身份信息会匿名化；历史资产与审计记录会保留。此操作不可撤销。`,
    );
    if (!accepted) return;
    void perform(async () => {
      const payload = await requestJson<{ message: string }>(
        "/api/v2/admin/users",
        {
          method: "DELETE",
          body: JSON.stringify({ userId: target.id }),
        },
      );
      setMessage(payload.message);
      await loadUsers(search);
    });
  }

  function reviewApplication(
    applicationId: string,
    decision: "approve" | "reject",
  ) {
    void perform(async () => {
      const payload = await requestJson<{ message: string }>(
        "/api/v2/admin/enterprises",
        {
          method: "PATCH",
          body: JSON.stringify({ applicationId, decision }),
        },
      );
      setMessage(payload.message);
      await loadApplications();
    });
  }

  return (
    <div
      className="admin-center-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="admin-center"
        role="dialog"
        aria-modal="true"
        aria-labelledby="admin-center-title"
      >
        <header>
          <div>
            <span className="eyebrow">SYSTEM ADMINISTRATION</span>
            <h2 id="admin-center-title">后台管理</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="关闭后台管理"
          >
            <X size={19} />
          </button>
        </header>

        <div className="admin-center-layout">
          <aside className="admin-center-sidebar">
            <div className="admin-identity">
              <span>{user.displayName.trim().slice(0, 1) || "管"}</span>
              <div>
                <b>{user.displayName}</b>
                <small>@{user.username}</small>
              </div>
              <em>系统管理员</em>
            </div>
            <nav aria-label="后台管理分类">
              <button
                type="button"
                className={tab === "overview" ? "active" : ""}
                onClick={() => setTab("overview")}
              >
                <Activity size={17} />
                <span>内核运维</span>
              </button>
              <button
                type="button"
                className={tab === "users" ? "active" : ""}
                onClick={() => setTab("users")}
              >
                <UsersRound size={17} />
                <span>用户管理</span>
              </button>
              <button
                type="button"
                className={tab === "enterprises" ? "active" : ""}
                onClick={() => setTab("enterprises")}
              >
                <Building2 size={17} />
                <span>企业审核</span>
                {applications.length > 0 && <i>{applications.length}</i>}
              </button>
            </nav>
            <div className="admin-access-note">
              <ShieldCheck size={17} />
              <span>只有唯一系统管理员可以访问此后台，所有变更都会写入审计记录。</span>
            </div>
          </aside>

          <main className="admin-center-content">
            {error && (
              <div className="settings-alert is-error">
                <CircleAlert size={15} />
                <span>{error}</span>
              </div>
            )}
            {message && (
              <div className="settings-alert is-success">
                <Check size={15} />
                <span>{message}</span>
              </div>
            )}

            {tab === "overview" && <AdminOperations />}

            {tab === "users" && (
              <section className="admin-users-panel">
                <div className="admin-panel-heading">
                  <div>
                    <h3>用户管理</h3>
                    <p>
                      查看用户使用情况和名下工作空间的 OSS 存储量，并管理账号安全。
                    </p>
                  </div>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => void loadUsers(search)}
                  >
                    <RefreshCcw size={15} /> 刷新
                  </button>
                </div>
                <form className="admin-user-search" onSubmit={submitSearch}>
                  <Search size={16} />
                  <input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="搜索用户名、显示名称、邮箱或手机尾号"
                    aria-label="搜索用户"
                  />
                  <button type="submit">搜索</button>
                </form>

                <div className="admin-user-table" role="table" aria-label="用户列表">
                  <div className="admin-user-table-head" role="row">
                    <span>用户</span>
                    <span>使用情况</span>
                    <span>OSS 存储量</span>
                    <span>状态</span>
                    <span>操作</span>
                  </div>
                  {users.map((managedUser) => (
                    <article key={managedUser.id} role="row">
                      <div className="admin-user-main">
                        <span>
                          {managedUser.displayName.trim().slice(0, 1) || "用"}
                        </span>
                        <div>
                          <b>@{managedUser.username}</b>
                          <small>{managedUser.displayName}</small>
                          <small>
                            {managedUser.email} · 手机尾号{" "}
                            {managedUser.phoneLast4 ?? "未绑定"}
                          </small>
                        </div>
                      </div>
                      <div className="admin-usage-counts">
                        <span title="文本调用次数">
                          <FileText size={13} /> 文本 {managedUser.textCount}
                        </span>
                        <span title="图片调用次数">
                          <ImageIcon size={13} /> 图片 {managedUser.imageCount}
                        </span>
                        <span title="视频调用次数">
                          <Video size={13} /> 视频 {managedUser.videoCount}
                        </span>
                      </div>
                      <div className="admin-storage-cell">
                        <HardDrive size={15} />
                        <span>
                          <b>{formatBytes(managedUser.storageBytes)}</b>
                          <small>名下工作空间</small>
                        </span>
                      </div>
                      <div>
                        <span
                          className={`admin-user-status is-${managedUser.status}`}
                        >
                          {managedUser.platformRole === "system_admin"
                            ? "系统管理员"
                            : managedUser.status === "active"
                              ? "正常"
                              : "已停用"}
                        </span>
                      </div>
                      <div className="admin-user-actions">
                        {managedUser.platformRole === "system_admin" ? (
                          <span className="admin-protected-label">
                            <ShieldCheck size={13} /> 受保护
                          </span>
                        ) : (
                          <>
                            <button
                              type="button"
                              onClick={() => {
                                setError("");
                                setResetTarget(managedUser);
                              }}
                              disabled={pending}
                            >
                              <KeyRound size={14} /> 修改密码
                            </button>
                            <button
                              type="button"
                              onClick={() => updateUserStatus(managedUser)}
                              disabled={pending}
                            >
                              <Power size={14} />
                              {managedUser.status === "active" ? "停用" : "启用"}
                            </button>
                            <button
                              type="button"
                              className="is-danger"
                              onClick={() => deleteUser(managedUser)}
                              disabled={pending}
                            >
                              <Trash2 size={14} /> 删除用户
                            </button>
                          </>
                        )}
                      </div>
                    </article>
                  ))}
                  {!loading && users.length === 0 && (
                    <div className="admin-empty-state">没有找到符合条件的用户。</div>
                  )}
                  {loading && (
                    <div className="admin-empty-state">
                      <LoaderCircle className="spin" size={17} /> 用户数据加载中…
                    </div>
                  )}
                </div>
              </section>
            )}

            {tab === "enterprises" && (
              <section className="admin-enterprises-panel">
                <div className="admin-panel-heading">
                  <div>
                    <h3>企业审核</h3>
                    <p>审核普通用户提交的企业空间申请。</p>
                  </div>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => void loadApplications()}
                  >
                    <RefreshCcw size={15} /> 刷新
                  </button>
                </div>
                <div className="admin-enterprise-list">
                  {applications.map((application) => (
                    <article key={application.id}>
                      <div>
                        <b>{application.organizationName}</b>
                        <small>
                          社会信用代码：{application.registrationCode || "未填写"}
                        </small>
                      </div>
                      <div>
                        <b>{application.applicantName}</b>
                        <small>
                          {application.applicantEmail} · 手机尾号{" "}
                          {application.phoneLast4 ?? "未绑定"}
                        </small>
                      </div>
                      <p>{application.note || "未填写申请说明"}</p>
                      <span>
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={() =>
                            reviewApplication(application.id, "reject")
                          }
                          disabled={pending}
                        >
                          拒绝
                        </button>
                        <button
                          type="button"
                          className="primary-button"
                          onClick={() =>
                            reviewApplication(application.id, "approve")
                          }
                          disabled={pending}
                        >
                          通过
                        </button>
                      </span>
                    </article>
                  ))}
                  {!loading && applications.length === 0 && (
                    <div className="admin-empty-state">当前没有待审核的企业申请。</div>
                  )}
                  {loading && (
                    <div className="admin-empty-state">
                      <LoaderCircle className="spin" size={17} /> 申请数据加载中…
                    </div>
                  )}
                </div>
              </section>
            )}
          </main>
        </div>

        {resetTarget && (
          <div
            className="admin-password-backdrop"
            role="presentation"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setResetTarget(null);
            }}
          >
            <form
              className="admin-password-dialog"
              onSubmit={submitPasswordReset}
            >
              <header>
                <div>
                  <span className="eyebrow">RESET PASSWORD</span>
                  <h3>修改 @{resetTarget.username} 的密码</h3>
                  <p>修改后，该用户当前所有登录设备会立即退出。</p>
                </div>
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => setResetTarget(null)}
                  aria-label="关闭修改密码"
                >
                  <X size={17} />
                </button>
              </header>
              <label>
                新密码
                <input
                  type="password"
                  minLength={6}
                  maxLength={128}
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                  autoComplete="new-password"
                  required
                />
              </label>
              <label>
                再次输入新密码
                <input
                  type="password"
                  minLength={6}
                  maxLength={128}
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  autoComplete="new-password"
                  required
                />
              </label>
              <footer>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setResetTarget(null)}
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="primary-button"
                  disabled={pending}
                >
                  {pending && <LoaderCircle className="spin" size={15} />}
                  确认修改
                </button>
              </footer>
            </form>
          </div>
        )}
      </section>
    </div>
  );
}
