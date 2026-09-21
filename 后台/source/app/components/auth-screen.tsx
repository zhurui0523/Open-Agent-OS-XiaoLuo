"use client";

import {
  ArrowLeft,
  ArrowRight,
  LoaderCircle,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import type { AccountUser } from "../types";
import { ServerUrlQuick } from "./server-url-widget";

interface AuthScreenProps {
  onAuthenticated: (user: AccountUser) => void;
  serviceError?: string;
}

type AuthMode = "login" | "register" | "recover";
type RecoveryStep = "verify" | "reset" | "complete";

async function requestJson<T>(url: string, init: RequestInit) {
  const response = await fetch(url, init);
  const payload = (await response.json().catch(() => ({}))) as T & {
    error?: string;
  };
  if (!response.ok) throw new Error(payload.error ?? "请求失败");
  return payload;
}

export function AuthScreen({
  onAuthenticated,
  serviceError = "",
}: AuthScreenProps) {
  const [mode, setMode] = useState<AuthMode>("login");
  const [recoveryStep, setRecoveryStep] =
    useState<RecoveryStep>("verify");
  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [resetToken, setResetToken] = useState("");
  const [pending, setPending] = useState(false);
  const [codePending, setCodePending] = useState(false);
  const [codeHint, setCodeHint] = useState("");
  const [error, setError] = useState(serviceError);
  async function sendCode() {
    setCodePending(true);
    setError("");
    setCodeHint("");
    try {
      const payload = await requestJson<{
        developmentCode?: string;
        message: string;
      }>("/api/v2/auth/send-code", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          phone,
          purpose: mode === "register" ? "register" : "password_reset",
        }),
      });
      if (payload.developmentCode) {
        setCode(payload.developmentCode);
        setCodeHint(`本地测试验证码：${payload.developmentCode}`);
      } else {
        setCodeHint("验证码已发送，5 分钟内有效");
      }
    } catch (requestError) {
      setError(
        requestError instanceof Error ? requestError.message : "验证码发送失败",
      );
    } finally {
      setCodePending(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      if (mode === "recover") {
        if (recoveryStep === "verify") {
          const payload = await requestJson<{ resetToken: string }>(
            "/api/v2/auth/password/verify",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ phone, code }),
            },
          );
          setResetToken(payload.resetToken);
          setPassword("");
          setRecoveryStep("reset");
          return;
        }
        if (recoveryStep === "reset") {
          await requestJson<{ message: string }>(
            "/api/v2/auth/password/reset",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ resetToken, newPassword: password }),
            },
          );
          setRecoveryStep("complete");
          return;
        }
      }

      const response = await requestJson<{ user: AccountUser }>(`/api/v2/auth/${mode}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(mode === "login"
            ? { identifier: email }
            : { email }),
          password,
          ...(mode === "register"
            ? { username, displayName, phone, code }
            : {}),
        }),
      });
      onAuthenticated(response.user);
    } catch (requestError) {
      setError(
        requestError instanceof Error ? requestError.message : "认证失败",
      );
    } finally {
      setPending(false);
    }
  }

  function switchMode(next: AuthMode) {
    setMode(next);
    setRecoveryStep("verify");
    setResetToken("");
    setCode("");
    setPassword("");
    setError("");
    setCodeHint("");
  }

  const title =
    mode === "login"
      ? "登录小逻Agent OS"
      : mode === "register"
        ? "创建小逻Agent OS 账号"
        : recoveryStep === "reset"
          ? "设置新密码"
          : recoveryStep === "complete"
            ? "密码已重置"
            : "通过手机号找回密码";

  return (
    <main className="auth-screen">
      <section className="auth-story">
        <div className="auth-story-copy">
          <span className="auth-kicker">Connected AI Operating System</span>
          <h1>让每一个想法，都可以被理解。</h1>
          <div className="auth-manifesto">
            <p>让每一个目标，都可以被执行。</p>
            <p>让每一次创造，都可以沉淀为可复用的智能资产。</p>
          </div>
        </div>
      </section>
      <section className="auth-panel">
        <form className="auth-card" onSubmit={submit}>
          <span className="eyebrow">
            {mode === "login"
              ? "WELCOME BACK"
              : mode === "register"
                ? "CREATE ACCOUNT"
                : "SECURE RECOVERY"}
          </span>
          <h2>{title}</h2>

          {mode === "recover" && recoveryStep === "complete" ? (
            <div className="auth-complete">
              <ShieldCheck size={34} />
              <strong>旧会话已经全部退出</strong>
              <span>请使用新密码重新登录。</span>
              <button
                type="button"
                className="primary-button auth-submit"
                onClick={() => switchMode("login")}
              >
                返回登录 <ArrowRight size={16} />
              </button>
            </div>
          ) : (
            <>
              {mode === "register" && (
                <>
                  <label>
                    <span>用户名</span>
                    <input
                      type="text"
                      value={username}
                      onChange={(event) =>
                        setUsername(
                          event.target.value
                            .toLowerCase()
                            .replace(/[^a-z0-9_]/g, "")
                            .slice(0, 32),
                        )
                      }
                      autoComplete="username"
                      minLength={3}
                      maxLength={32}
                      pattern="[a-z0-9][a-z0-9_]{2,31}"
                      placeholder="用于登录，全局唯一"
                      required
                    />
                  </label>
                  <label>
                    <span>显示名称</span>
                    <input
                      type="text"
                      value={displayName}
                      onChange={(event) => setDisplayName(event.target.value)}
                      autoComplete="name"
                      minLength={2}
                      maxLength={80}
                      required
                    />
                  </label>
                </>
              )}
              {mode !== "recover" && (
                <label>
                  <span>{mode === "login" ? "账号" : "邮箱"}</span>
                  <input
                    type={mode === "login" ? "text" : "email"}
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    autoComplete={mode === "login" ? "username" : "email"}
                    placeholder={mode === "login" ? "邮箱或用户名" : undefined}
                    required
                  />
                </label>
              )}
              {(mode === "register" ||
                (mode === "recover" && recoveryStep === "verify")) && (
                <>
                  <label>
                    <span>手机号</span>
                    <input
                      type="tel"
                      value={phone}
                      onChange={(event) => setPhone(event.target.value)}
                      autoComplete="tel"
                      placeholder="中国大陆手机号或 +国家码"
                      required
                    />
                  </label>
                  <label>
                    <span>短信验证码</span>
                    <div className="auth-code-row">
                      <input
                        type="text"
                        inputMode="numeric"
                        value={code}
                        onChange={(event) =>
                          setCode(event.target.value.replace(/\D/g, "").slice(0, 6))
                        }
                        autoComplete="one-time-code"
                        maxLength={6}
                        required
                      />
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={sendCode}
                        disabled={codePending || !phone.trim()}
                      >
                        {codePending ? <LoaderCircle size={15} className="spin" /> : "发送验证码"}
                      </button>
                    </div>
                  </label>
                  {codeHint && <div className="auth-code-hint">{codeHint}</div>}
                </>
              )}
              {(mode !== "recover" || recoveryStep === "reset") && (
                <label>
                  <span>{mode === "recover" ? "新密码" : "密码"}</span>
                  <input
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    autoComplete={
                      mode === "login" ? "current-password" : "new-password"
                    }
                    minLength={6}
                    required
                  />
                </label>
              )}
              {error && <div className="auth-error" role="alert">{error}</div>}
              <div className={mode === "login" ? "auth-actions" : undefined}>
                <button
                  type="submit"
                  className="primary-button auth-submit"
                  disabled={pending}
                >
                  {pending ? (
                    <><LoaderCircle size={16} className="spin" /> 正在处理</>
                  ) : (
                    <>
                      {mode === "login"
                        ? "登录"
                        : mode === "register"
                          ? "验证并创建账号"
                          : recoveryStep === "verify"
                            ? "验证手机号"
                            : "保存新密码"}
                      <ArrowRight size={16} />
                    </>
                  )}
                </button>
              </div>
              {mode === "login" && (
                <div className="auth-switches">
                  <button type="button" className="text-button" onClick={() => switchMode("register")}>
                    创建账号
                  </button>
                  <button type="button" className="text-button" onClick={() => switchMode("recover")}>
                    忘记密码
                  </button>
                </div>
              )}
              {mode !== "login" && (
                <button
                  type="button"
                  className="text-button auth-mode-switch"
                  onClick={() => switchMode("login")}
                >
                  <ArrowLeft size={14} /> 返回登录
                </button>
              )}
            </>
          )}
        </form>

        {/* SERVER-URL 登录页快捷入口：登录前即可修改服务地址 */}
        <ServerUrlQuick />
      </section>
    </main>
  );
}
