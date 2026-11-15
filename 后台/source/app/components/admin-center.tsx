"use client";

import {
  Activity,
  Building2,
  Check,
  CircleAlert,
  ClipboardList,
  FileText,
  HardDrive,
  Image as ImageIcon,
  KeyRound,
  LoaderCircle,
  Music,
  Plus,
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
import { useAppDialog } from "./app-dialog";

type AdminTab = "overview" | "users" | "enterprises" | "organizations";

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
  audioCount: number;
  storageBytes: number;
  storageQuotaBytes: number;
  accountType:
    | "system_admin"
    | "ordinary_user"
    | "enterprise_admin"
    | "enterprise_member";
  canIncreaseStorage: boolean;
  createdAt: string;
}

const ACCOUNT_TYPE_LABEL: Record<ManagedUser["accountType"], string> = {
  system_admin: "系统管理员",
  ordinary_user: "普通用户",
  enterprise_admin: "企业管理员",
  enterprise_member: "企业成员",
};

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

interface AdminOrganization {
  id: string;
  name: string;
  registrationCode: string | null;
  status: "pending" | "active" | "rejected" | "disabled";
  createdAt: string;
  creatorName: string | null;
  creatorUsername: string | null;
  adminNames: string | null;
  memberCount: number;
}

const ORG_STATUS_LABEL: Record<AdminOrganization["status"], string> = {
  pending: "待审核",
  active: "已启用",
  rejected: "已拒绝",
  disabled: "已停用",
};

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(
    date.getMinutes(),
  ).padStart(2, "0")}`;
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
  const dialog = useAppDialog();
  const [tab, setTab] = useState<AdminTab>("overview");
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [applications, setApplications] = useState<EnterpriseApplication[]>([]);
  const [organizations, setOrganizations] = useState<AdminOrganization[]>([]);
  const [search, setSearch] = useState("");
  const [pending, setPending] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [resetTarget, setResetTarget] = useState<ManagedUser | null>(null);
  const [storageTarget, setStorageTarget] = useState<ManagedUser | null>(null);
  const [increaseGiB, setIncreaseGiB] = useState("10");
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

  const loadOrganizations = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const payload = await requestJson<{
        organizations: AdminOrganization[];
      }>("/api/v2/admin/organizations");
      setOrganizations(payload.organizations);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "读取企业列表失败");
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
    if (tab === "organizations" && organizations.length === 0) {
      const timer = window.setTimeout(() => void loadOrganizations(), 0);
      return () => window.clearTimeout(timer);
    }
  }, [
    applications.length,
    loadApplications,
    loadOrganizations,
    loadUsers,
    organizations.length,
    tab,
    users.length,
  ]);

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

  function submitStorageIncrease(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!storageTarget) return;
    const parsed = Number(increaseGiB);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 1024) {
      setError("请输入 1–1024 GB 的整数容量");
      return;
    }
    void perform(async () => {
      const payload = await requestJson<{
        message: string;
        storageQuotaBytes: number;
      }>("/api/v2/admin/users/storage", {
        method: "POST",
        body: JSON.stringify({
          userId: storageTarget.id,
          increaseGiB: parsed,
        }),
      });
      setStorageTarget(null);
      setIncreaseGiB("10");
      setMessage(
        `${payload.message}，当前总空间 ${formatBytes(payload.storageQuotaBytes)}`,
      );
      await loadUsers(search);
    });
  }

  async function deleteUser(target: ManagedUser) {
    const accepted = await dialog.confirm(
      `账号将失去登录权限，邮箱、手机号等身份信息会匿名化；历史资产与审计记录会保留。此操作不可撤销。`,
      {
        title: `删除用户 @${target.username}`,
        confirmText: "删除用户",
        tone: "danger",
      },
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
              <button
                type="button"
                className={tab === "organizations" ? "active" : ""}
                onClick={() => setTab("organizations")}
              >
                <ClipboardList size={17} />
                <span>企业列表</span>
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
                      查看用户使用情况、画布文件存储量，并管理账号安全。
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
                    <span>已用空间</span>
                    <span>空间配额</span>
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
                          <small
                            className={`admin-account-type is-${managedUser.accountType}`}
                          >
                            {ACCOUNT_TYPE_LABEL[managedUser.accountType]}
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
                        <span title="音乐调用次数">
                          <Music size={13} /> 音乐 {managedUser.audioCount}
                        </span>
                      </div>
                      <div className="admin-storage-cell">
                        <HardDrive size={15} />
                        <span>
                          <b>{formatBytes(managedUser.storageBytes)}</b>
                          <small>文件与画布资产</small>
                        </span>
                      </div>
                      <div className="admin-quota-cell">
                        {managedUser.platformRole === "system_admin" ? (
                          <small>不支持调整</small>
                        ) : managedUser.canIncreaseStorage ? (
                          <>
                            <span>
                              <b>{formatBytes(managedUser.storageQuotaBytes)}</b>
                              <small>当前总空间</small>
                            </span>
                            <button
                              type="button"
                              onClick={() => {
                                setError("");
                                setIncreaseGiB("10");
                                setStorageTarget(managedUser);
                              }}
                              disabled={pending}
                            >
                              <Plus size={13} /> 增加空间
                            </button>
                          </>
                        ) : (
                          <small>企业成员不单独分配</small>
                        )}
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
                              onClick={() => void deleteUser(managedUser)}
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

            {tab === "organizations" && (
              <section className="admin-enterprises-panel">
                <div className="admin-panel-heading">
                  <div>
                    <h3>企业列表</h3>
                    <p>查看平台上所有已注册企业的状态、负责人与成员规模。</p>
                  </div>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => void loadOrganizations()}
                  >
                    <RefreshCcw size={15} /> 刷新
                  </button>
                </div>
                <div className="admin-enterprise-list">
                  {organizations.map((organization) => (
                    <article key={organization.id}>
                      <div>
                        <b>{organization.name}</b>
                        <small>
                          社会信用代码：
                          {organization.registrationCode || "未填写"}
                        </small>
                      </div>
                      <div>
                        <b>{organization.adminNames || "暂无管理员"}</b>
                        <small>
                          创建人：{organization.creatorName ?? "未知"}
                          {organization.creatorUsername
                            ? ` @${organization.creatorUsername}`
                            : ""}
                        </small>
                      </div>
                      <div>
                        <b>{Number(organization.memberCount)} 名成员</b>
                        <small>创建于 {formatDateTime(organization.createdAt)}</small>
                      </div>
                      <span>
                        <em
                          className={`admin-org-status is-${organization.status}`}
                        >
                          {ORG_STATUS_LABEL[organization.status]}
                        </em>
                      </span>
                    </article>
                  ))}
                  {!loading && organizations.length === 0 && (
                    <div className="admin-empty-state">当前还没有任何企业。</div>
                  )}
                  {loading && (
                    <div className="admin-empty-state">
                      <LoaderCircle className="spin" size={17} /> 企业数据加载中…
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

        {storageTarget && (
          <div
            className="admin-password-backdrop"
            role="presentation"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setStorageTarget(null);
            }}
          >
            <form
              className="admin-password-dialog admin-storage-dialog"
              onSubmit={submitStorageIncrease}
            >
              <header>
                <div>
                  <span className="eyebrow">INCREASE STORAGE</span>
                  <h3>为 @{storageTarget.username} 增加空间</h3>
                  <p>
                    {ACCOUNT_TYPE_LABEL[storageTarget.accountType]} · 当前总空间{" "}
                    {formatBytes(storageTarget.storageQuotaBytes)}
                  </p>
                </div>
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => setStorageTarget(null)}
                  aria-label="关闭增加空间"
                >
                  <X size={17} />
                </button>
              </header>
              <div className="admin-storage-presets" aria-label="快捷容量">
                {[1, 5, 10, 50].map((value) => (
                  <button
                    key={value}
                    type="button"
                    className={increaseGiB === String(value) ? "active" : ""}
                    onClick={() => setIncreaseGiB(String(value))}
                  >
                    +{value} GB
                  </button>
                ))}
              </div>
              <label>
                增加容量（GB）
                <input
                  type="number"
                  min={1}
                  max={1024}
                  step={1}
                  inputMode="numeric"
                  value={increaseGiB}
                  onChange={(event) => setIncreaseGiB(event.target.value)}
                  required
                />
              </label>
              <div className="admin-storage-result">
                <span>增加后的总空间</span>
                <b>
                  {formatBytes(
                    storageTarget.storageQuotaBytes +
                      (Number.isSafeInteger(Number(increaseGiB))
                        ? Number(increaseGiB) * 1024 ** 3
                        : 0),
                  )}
                </b>
              </div>
              <footer>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setStorageTarget(null)}
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="primary-button"
                  disabled={pending}
                >
                  {pending && <LoaderCircle className="spin" size={15} />}
                  确认增加
                </button>
              </footer>
            </form>
          </div>
        )}
      </section>
    </div>
  );
}
