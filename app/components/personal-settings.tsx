"use client";

import {
  Building2,
  Check,
  ChevronRight,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  MonitorSmartphone,
  Phone,
  Save,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { AccountUser } from "../types";

type PersonalSection =
  | "profile"
  | "phone"
  | "password"
  | "security"
  | "sessions";

interface SecuritySettings {
  allowMultipleSessions: boolean;
  sessionTtlDays: number;
}

interface DeviceSession {
  id: string;
  deviceName: string;
  ipAddress: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  current: boolean;
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

function formatDate(value: string) {
  const date = new Date(value.includes("T") ? value : value.replace(" ", "T"));
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }).format(date);
}

interface PersonalSettingsProps {
  user: AccountUser;
  onUserUpdate: (user: AccountUser) => void;
  onOpenAccount: () => void;
}

export function PersonalSettings({
  user,
  onUserUpdate,
  onOpenAccount,
}: PersonalSettingsProps) {
  const [section, setSection] = useState<PersonalSection>("profile");
  const [username, setUsername] = useState(user.username);
  const [displayName, setDisplayName] = useState(user.displayName);
  const [phone, setPhone] = useState("");
  const [phoneCode, setPhoneCode] = useState("");
  const [phonePassword, setPhonePassword] = useState("");
  const [developmentCode, setDevelopmentCode] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [security, setSecurity] = useState<SecuritySettings>({
    allowMultipleSessions: true,
    sessionTtlDays: 30,
  });
  const [sessions, setSessions] = useState<DeviceSession[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const loadSecurity = useCallback(async () => {
    const payload = await requestJson<{ security: SecuritySettings }>(
      "/api/v2/account/security",
    );
    setSecurity(payload.security);
  }, []);

  const loadSessions = useCallback(async () => {
    const payload = await requestJson<{ sessions: DeviceSession[] }>(
      "/api/v2/account/sessions",
    );
    setSessions(payload.sessions);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      void Promise.all([loadSecurity(), loadSessions()]).catch((caught) =>
        setError(caught instanceof Error ? caught.message : "账户安全信息加载失败"),
      );
    }, 0);
    return () => clearTimeout(timer);
  }, [loadSecurity, loadSessions]);

  async function perform(operation: () => Promise<void>) {
    setPending(true);
    setError("");
    setMessage("");
    try {
      await operation();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "操作失败");
    } finally {
      setPending(false);
    }
  }

  function saveProfile(event: FormEvent) {
    event.preventDefault();
    void perform(async () => {
      const payload = await requestJson<{
        user: AccountUser;
        message: string;
      }>("/api/v2/account/profile", {
        method: "PATCH",
        body: JSON.stringify({ username, displayName }),
      });
      onUserUpdate(payload.user);
      setUsername(payload.user.username);
      setDisplayName(payload.user.displayName);
      setMessage(payload.message);
    });
  }

  function sendPhoneCode() {
    void perform(async () => {
      const payload = await requestJson<{
        message: string;
        developmentCode?: string;
      }>("/api/v2/auth/send-code", {
        method: "POST",
        body: JSON.stringify({ phone, purpose: "phone_change" }),
      });
      setDevelopmentCode(payload.developmentCode ?? "");
      setMessage("验证码已发送到新手机号。");
    });
  }

  function changePhone(event: FormEvent) {
    event.preventDefault();
    void perform(async () => {
      const payload = await requestJson<{
        user: AccountUser;
        message: string;
      }>("/api/v2/account/phone", {
        method: "POST",
        body: JSON.stringify({
          phone,
          code: phoneCode,
          currentPassword: phonePassword,
        }),
      });
      onUserUpdate(payload.user);
      setPhone("");
      setPhoneCode("");
      setPhonePassword("");
      setDevelopmentCode("");
      setMessage(payload.message);
      await loadSessions();
    });
  }

  function changePassword(event: FormEvent) {
    event.preventDefault();
    if (newPassword !== confirmPassword) {
      setError("两次输入的新密码不一致");
      return;
    }
    void perform(async () => {
      const payload = await requestJson<{ message: string }>(
        "/api/v2/account/password",
        {
          method: "POST",
          body: JSON.stringify({ currentPassword, newPassword }),
        },
      );
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setMessage(payload.message);
      await loadSessions();
    });
  }

  function saveSecurity() {
    void perform(async () => {
      const payload = await requestJson<{
        security: SecuritySettings;
        message: string;
      }>("/api/v2/account/security", {
        method: "PATCH",
        body: JSON.stringify(security),
      });
      setSecurity(payload.security);
      setMessage(payload.message);
      await loadSessions();
    });
  }

  function revokeSession(sessionId: string) {
    void perform(async () => {
      const payload = await requestJson<{
        message: string;
        current?: boolean;
      }>("/api/v2/account/sessions", {
        method: "DELETE",
        body: JSON.stringify({ sessionId }),
      });
      if (payload.current) {
        window.location.reload();
        return;
      }
      setMessage(payload.message);
      await loadSessions();
    });
  }

  function revokeOtherSessions() {
    void perform(async () => {
      const payload = await requestJson<{ message: string }>(
        "/api/v2/account/sessions",
        {
          method: "DELETE",
          body: JSON.stringify({ allOthers: true }),
        },
      );
      setMessage(payload.message);
      await loadSessions();
    });
  }

  const sections: Array<{
    id: PersonalSection;
    label: string;
    icon: typeof UserRound;
  }> = [
    { id: "profile", label: "编辑资料", icon: UserRound },
    { id: "phone", label: "改绑手机", icon: Phone },
    { id: "password", label: "修改密码", icon: LockKeyhole },
    { id: "security", label: "安全设置", icon: ShieldCheck },
    { id: "sessions", label: "登录设备", icon: MonitorSmartphone },
  ];

  return (
    <div className="personal-settings">
      <section className="personal-account-summary">
        <span>{user.displayName.trim().slice(0, 1) || "洛"}</span>
        <div>
          <strong>{user.displayName}</strong>
          <p>
            @{user.username} · {user.email} · 手机尾号{" "}
            {user.phoneLast4 ?? "未绑定"}
          </p>
          <small>
            {user.platformRole === "system_admin" ? "系统管理员" : "普通用户"}
          </small>
        </div>
        <button
          type="button"
          className="secondary-button"
          onClick={onOpenAccount}
        >
          <Building2 size={15} /> 账号与企业
        </button>
      </section>

      <div className="personal-settings-layout">
        <nav aria-label="个人中心分类">
          {sections.map((item) => {
            const Icon = item.icon;
            return (
              <button
                type="button"
                key={item.id}
                className={section === item.id ? "active" : ""}
                onClick={() => {
                  setSection(item.id);
                  setError("");
                  setMessage("");
                }}
              >
                <Icon size={16} />
                <span>{item.label}</span>
                <ChevronRight size={14} />
              </button>
            );
          })}
        </nav>

        <div className="personal-settings-panel">
          {error && <div className="settings-alert is-error">{error}</div>}
          {message && (
            <div className="settings-alert is-success">
              <Check size={15} /> {message}
            </div>
          )}

          {section === "profile" && (
            <form className="personal-form" onSubmit={saveProfile}>
              <header>
                <UserRound size={20} />
                <div>
                  <h3>编辑资料</h3>
                  <p>用户名用于登录且全局唯一；显示名称用于界面展示。</p>
                </div>
              </header>
              <label>
                用户名
                <input
                  value={username}
                  minLength={3}
                  maxLength={32}
                  pattern="[a-z0-9][a-z0-9_]{2,31}"
                  onChange={(event) =>
                    setUsername(
                      event.target.value
                        .toLowerCase()
                        .replace(/[^a-z0-9_]/g, "")
                        .slice(0, 32),
                    )
                  }
                  autoComplete="username"
                  required
                />
              </label>
              <label>
                显示名称
                <input
                  value={displayName}
                  minLength={2}
                  maxLength={80}
                  onChange={(event) => setDisplayName(event.target.value)}
                  required
                />
              </label>
              <label>
                登录邮箱
                <input value={user.email} readOnly disabled />
              </label>
              <footer>
                <button className="primary-button" disabled={pending}>
                  <Save size={15} /> 保存资料
                </button>
              </footer>
            </form>
          )}

          {section === "phone" && (
            <form className="personal-form" onSubmit={changePhone}>
              <header>
                <Phone size={20} />
                <div>
                  <h3>改绑手机号</h3>
                  <p>
                    当前绑定尾号 {user.phoneLast4 ?? "—"}。改绑后其他设备将退出。
                  </p>
                </div>
              </header>
              <label>
                新手机号
                <input
                  type="tel"
                  value={phone}
                  onChange={(event) => setPhone(event.target.value)}
                  placeholder="请输入新手机号"
                  required
                />
              </label>
              <div className="personal-code-row">
                <label>
                  短信验证码
                  <input
                    inputMode="numeric"
                    value={phoneCode}
                    onChange={(event) => setPhoneCode(event.target.value)}
                    maxLength={6}
                    required
                  />
                </label>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={sendPhoneCode}
                  disabled={pending || !phone}
                >
                  发送验证码
                </button>
              </div>
              {developmentCode && (
                <div className="personal-development-code">
                  本地测试验证码：{developmentCode}
                </div>
              )}
              <label>
                当前密码
                <input
                  type="password"
                  autoComplete="current-password"
                  value={phonePassword}
                  onChange={(event) => setPhonePassword(event.target.value)}
                  required
                />
              </label>
              <footer>
                <button className="primary-button" disabled={pending}>
                  <Phone size={15} /> 确认改绑
                </button>
              </footer>
            </form>
          )}

          {section === "password" && (
            <form className="personal-form" onSubmit={changePassword}>
              <header>
                <KeyRound size={20} />
                <div>
                  <h3>修改密码</h3>
                  <p>密码至少 6 位。修改成功后其他设备会话自动退出。</p>
                </div>
              </header>
              <label>
                当前密码
                <input
                  type="password"
                  autoComplete="current-password"
                  value={currentPassword}
                  onChange={(event) => setCurrentPassword(event.target.value)}
                  required
                />
              </label>
              <label>
                新密码
                <input
                  type="password"
                  autoComplete="new-password"
                  minLength={6}
                  maxLength={128}
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                  required
                />
              </label>
              <label>
                再次输入新密码
                <input
                  type="password"
                  autoComplete="new-password"
                  minLength={6}
                  maxLength={128}
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  required
                />
              </label>
              <footer>
                <button className="primary-button" disabled={pending}>
                  <LockKeyhole size={15} /> 修改密码
                </button>
              </footer>
            </form>
          )}

          {section === "security" && (
            <section className="personal-form">
              <header>
                <ShieldCheck size={20} />
                <div>
                  <h3>安全设置</h3>
                  <p>控制多设备登录和新会话的有效时间。</p>
                </div>
              </header>
              <label className="personal-switch-row">
                <span>
                  <strong>允许多设备同时登录</strong>
                  <small>关闭后仅保留当前设备，新登录会退出旧设备。</small>
                </span>
                <input
                  type="checkbox"
                  checked={security.allowMultipleSessions}
                  onChange={(event) =>
                    setSecurity((current) => ({
                      ...current,
                      allowMultipleSessions: event.target.checked,
                    }))
                  }
                />
              </label>
              <label>
                会话有效期
                <select
                  value={security.sessionTtlDays}
                  onChange={(event) =>
                    setSecurity((current) => ({
                      ...current,
                      sessionTtlDays: Number(event.target.value),
                    }))
                  }
                >
                  <option value={7}>7 天</option>
                  <option value={30}>30 天</option>
                  <option value={90}>90 天</option>
                </select>
              </label>
              <footer>
                <button
                  type="button"
                  className="primary-button"
                  disabled={pending}
                  onClick={saveSecurity}
                >
                  <Save size={15} /> 保存安全设置
                </button>
              </footer>
            </section>
          )}

          {section === "sessions" && (
            <section className="personal-session-section">
              <header>
                <div>
                  <h3>登录设备</h3>
                  <p>查看并退出已登录 XiaoLuo AI 的浏览器和设备。</p>
                </div>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={pending || sessions.length < 2}
                  onClick={revokeOtherSessions}
                >
                  退出其他设备
                </button>
              </header>
              <div className="personal-session-list">
                {sessions.map((session) => (
                  <article key={session.id}>
                    <span>
                      <MonitorSmartphone size={18} />
                    </span>
                    <div>
                      <strong>
                        {session.deviceName}
                        {session.current && <em>当前设备</em>}
                      </strong>
                      <p>
                        {session.ipAddress} · 最近活动{" "}
                        {formatDate(session.lastSeenAt)}
                      </p>
                      <small>
                        登录 {formatDate(session.createdAt)} · 到期{" "}
                        {formatDate(session.expiresAt)}
                      </small>
                    </div>
                    <button
                      type="button"
                      className="danger-text-button"
                      disabled={pending}
                      onClick={() => revokeSession(session.id)}
                    >
                      {session.current ? "退出当前设备" : "退出设备"}
                    </button>
                  </article>
                ))}
                {!sessions.length && (
                  <div className="settings-empty">暂无有效登录设备</div>
                )}
              </div>
            </section>
          )}
        </div>
      </div>

      {pending && (
        <div className="personal-pending">
          <LoaderCircle className="spin" size={16} /> 正在处理
        </div>
      )}
    </div>
  );
}
