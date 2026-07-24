"use client";

import {
  Building2,
  Check,
  LoaderCircle,
  ShieldCheck,
  UserRoundCog,
  UsersRound,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { AccountUser, OrganizationSummary } from "../types";

interface AccountCenterProps {
  user: AccountUser;
  onClose: () => void;
}

interface OrganizationMember {
  userId: string;
  displayName: string;
  email: string;
  phoneLast4: string | null;
  role: "admin" | "member";
  status: "active" | "disabled";
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
}

interface ManagedUser {
  id: string;
  email: string;
  displayName: string;
  phoneLast4: string | null;
  platformRole: "system_admin" | "user";
  status: "active" | "disabled";
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

export function AccountCenter({ user, onClose }: AccountCenterProps) {
  const [organizations, setOrganizations] = useState<OrganizationSummary[]>([]);
  const [selectedOrganizationId, setSelectedOrganizationId] = useState("");
  const [members, setMembers] = useState<OrganizationMember[]>([]);
  const [applications, setApplications] = useState<EnterpriseApplication[]>([]);
  const [managedUsers, setManagedUsers] = useState<ManagedUser[]>([]);
  const [companyName, setCompanyName] = useState("");
  const [registrationCode, setRegistrationCode] = useState("");
  const [applicationNote, setApplicationNote] = useState("");
  const [memberPhone, setMemberPhone] = useState("");
  const [memberRole, setMemberRole] = useState<"admin" | "member">("member");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const loadOrganizations = useCallback(async () => {
    const payload = await requestJson<{ organizations: OrganizationSummary[] }>(
      "/api/v2/organizations",
    );
    setOrganizations(payload.organizations);
    const activeAdmin = payload.organizations.find(
      (organization) =>
        organization.status === "active" && organization.role === "admin",
    );
    if (activeAdmin) setSelectedOrganizationId(activeAdmin.id);
  }, []);

  const loadAdminData = useCallback(async () => {
    if (user.platformRole !== "system_admin") return;
    const [applicationPayload, userPayload] = await Promise.all([
      requestJson<{ applications: EnterpriseApplication[] }>(
        "/api/v2/admin/enterprises",
      ),
      requestJson<{ users: ManagedUser[] }>("/api/v2/admin/users"),
    ]);
    setApplications(applicationPayload.applications);
    setManagedUsers(userPayload.users);
  }, [user.platformRole]);

  const loadMembers = useCallback(async (organizationId: string) => {
    if (!organizationId) {
      setMembers([]);
      return;
    }
    const payload = await requestJson<{ members: OrganizationMember[] }>(
      `/api/v2/organizations/members?organizationId=${encodeURIComponent(organizationId)}`,
    );
    setMembers(payload.members);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      void Promise.all([loadOrganizations(), loadAdminData()]).catch((loadError) =>
        setError(loadError instanceof Error ? loadError.message : "账户信息加载失败"),
      );
    }, 0);
    return () => clearTimeout(timer);
  }, [loadAdminData, loadOrganizations]);

  useEffect(() => {
    const timer = setTimeout(() => {
      void loadMembers(selectedOrganizationId).catch((loadError) =>
        setError(loadError instanceof Error ? loadError.message : "成员加载失败"),
      );
    }, 0);
    return () => clearTimeout(timer);
  }, [loadMembers, selectedOrganizationId]);

  async function perform(operation: () => Promise<void>) {
    setPending(true);
    setError("");
    setMessage("");
    try {
      await operation();
    } catch (operationError) {
      setError(
        operationError instanceof Error ? operationError.message : "操作失败",
      );
    } finally {
      setPending(false);
    }
  }

  function submitEnterprise(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void perform(async () => {
      await requestJson("/api/v2/organizations", {
        method: "POST",
        body: JSON.stringify({
          name: companyName,
          registrationCode,
          note: applicationNote,
        }),
      });
      setCompanyName("");
      setRegistrationCode("");
      setApplicationNote("");
      setMessage("企业申请已提交，等待系统管理员审核。");
      await loadOrganizations();
    });
  }

  function addMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void perform(async () => {
      await requestJson("/api/v2/organizations/members", {
        method: "POST",
        body: JSON.stringify({
          organizationId: selectedOrganizationId,
          phone: memberPhone,
          role: memberRole,
        }),
      });
      setMemberPhone("");
      setMessage("成员已加入企业。");
      await loadMembers(selectedOrganizationId);
    });
  }

  function reviewApplication(applicationId: string, decision: "approve" | "reject") {
    void perform(async () => {
      await requestJson("/api/v2/admin/enterprises", {
        method: "PATCH",
        body: JSON.stringify({ applicationId, decision }),
      });
      setMessage(decision === "approve" ? "企业已通过审核。" : "企业申请已拒绝。");
      await loadAdminData();
    });
  }

  function updateMember(
    member: OrganizationMember,
    patch: { role?: "admin" | "member"; status?: "active" | "disabled" },
  ) {
    void perform(async () => {
      await requestJson("/api/v2/organizations/members", {
        method: "PATCH",
        body: JSON.stringify({
          organizationId: selectedOrganizationId,
          userId: member.userId,
          ...patch,
        }),
      });
      await loadMembers(selectedOrganizationId);
    });
  }

  function updateUserStatus(target: ManagedUser) {
    void perform(async () => {
      await requestJson("/api/v2/admin/users", {
        method: "PATCH",
        body: JSON.stringify({
          userId: target.id,
          status: target.status === "active" ? "disabled" : "active",
        }),
      });
      await loadAdminData();
    });
  }

  const selectedOrganization = organizations.find(
    (organization) => organization.id === selectedOrganizationId,
  );

  return (
    <div className="account-center-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="account-center"
        role="dialog"
        aria-modal="true"
        aria-label="账户与企业管理"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span className="eyebrow">ACCOUNT & ORGANIZATION</span>
            <h2>账户与企业管理</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </header>

        <div className="account-center-scroll">
          <section className="account-profile-card">
            <span className="account-profile-avatar">
              {user.displayName.trim().slice(0, 1) || "洛"}
            </span>
            <div>
              <strong>{user.displayName}</strong>
              <span>{user.email} · 手机尾号 {user.phoneLast4 ?? "未绑定"}</span>
            </div>
            <em>
              {user.platformRole === "system_admin" ? (
                <><ShieldCheck size={14} /> 系统管理员</>
              ) : (
                <><Check size={14} /> 普通用户</>
              )}
            </em>
          </section>

          {error && <div className="auth-error">{error}</div>}
          {message && <div className="account-success">{message}</div>}

          <section className="account-section">
            <div className="account-section-title">
              <div><Building2 size={18} /><span><b>我的企业</b><small>个人空间始终保留，企业空间独立管理。</small></span></div>
            </div>
            {organizations.length ? (
              <div className="organization-list">
                {organizations.map((organization) => (
                  <button
                    type="button"
                    key={organization.id}
                    className={selectedOrganizationId === organization.id ? "active" : ""}
                    onClick={() => setSelectedOrganizationId(organization.id)}
                  >
                    <span><b>{organization.name}</b><small>
                      {organization.status === "active"
                        ? organization.role === "admin" ? "企业管理员" : "企业普通用户"
                        : organization.status === "pending" ? "审核中" : "未通过"}
                    </small></span>
                    <em>{organization.status}</em>
                  </button>
                ))}
              </div>
            ) : (
              <form className="account-form" onSubmit={submitEnterprise}>
                <input value={companyName} onChange={(event) => setCompanyName(event.target.value)} placeholder="企业名称" required />
                <input value={registrationCode} onChange={(event) => setRegistrationCode(event.target.value)} placeholder="统一社会信用代码（可选）" />
                <textarea value={applicationNote} onChange={(event) => setApplicationNote(event.target.value)} placeholder="申请说明（可选）" />
                <button className="primary-button" disabled={pending}>申请创建企业</button>
              </form>
            )}
          </section>

          {selectedOrganization?.status === "active" && (
            <section className="account-section">
              <div className="account-section-title">
                <div><UsersRound size={18} /><span><b>企业成员</b><small>仅企业管理员与企业普通用户两种角色。</small></span></div>
              </div>
              {selectedOrganization.role === "admin" && (
                <form className="member-add-form" onSubmit={addMember}>
                  <input type="tel" value={memberPhone} onChange={(event) => setMemberPhone(event.target.value)} placeholder="已注册成员手机号" required />
                  <select value={memberRole} onChange={(event) => setMemberRole(event.target.value as "admin" | "member")}>
                    <option value="member">企业普通用户</option>
                    <option value="admin">企业管理员</option>
                  </select>
                  <button className="secondary-button" disabled={pending}>添加成员</button>
                </form>
              )}
              <div className="account-table">
                {members.map((member) => (
                  <div key={member.userId}>
                    <span><b>{member.displayName}</b><small>{member.email} · 尾号 {member.phoneLast4 ?? "—"}</small></span>
                    <em>{member.role === "admin" ? "企业管理员" : "企业普通用户"}</em>
                    {selectedOrganization.role === "admin" && member.userId !== user.id && (
                      <>
                        <button type="button" onClick={() => updateMember(member, { role: member.role === "admin" ? "member" : "admin" })}>
                          {member.role === "admin" ? "改为普通用户" : "设为管理员"}
                        </button>
                        <button type="button" onClick={() => updateMember(member, { status: member.status === "active" ? "disabled" : "active" })}>
                          {member.status === "active" ? "停用" : "启用"}
                        </button>
                      </>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          {user.platformRole === "system_admin" && (
            <>
              <section className="account-section system-section">
                <div className="account-section-title">
                  <div><ShieldCheck size={18} /><span><b>企业审核</b><small>系统管理员统一处理企业准入。</small></span></div>
                </div>
                <div className="admin-application-list">
                  {applications.length === 0 && <p>当前没有待审核申请。</p>}
                  {applications.map((application) => (
                    <article key={application.id}>
                      <div><b>{application.organizationName}</b><small>{application.applicantName} · {application.applicantEmail} · 尾号 {application.phoneLast4 ?? "—"}</small></div>
                      <p>{application.note || "未填写申请说明"}</p>
                      <span>
                        <button type="button" className="secondary-button" onClick={() => reviewApplication(application.id, "reject")} disabled={pending}>拒绝</button>
                        <button type="button" className="primary-button" onClick={() => reviewApplication(application.id, "approve")} disabled={pending}>通过</button>
                      </span>
                    </article>
                  ))}
                </div>
              </section>
              <section className="account-section system-section">
                <div className="account-section-title">
                  <div><UserRoundCog size={18} /><span><b>用户管理</b><small>系统管理员可启用或停用普通用户。</small></span></div>
                </div>
                <div className="account-table">
                  {managedUsers.map((managedUser) => (
                    <div key={managedUser.id}>
                      <span><b>{managedUser.displayName}</b><small>{managedUser.email} · 尾号 {managedUser.phoneLast4 ?? "—"}</small></span>
                      <em>{managedUser.platformRole === "system_admin" ? "系统管理员" : managedUser.status === "active" ? "正常" : "已停用"}</em>
                      {managedUser.platformRole === "user" && (
                        <button type="button" onClick={() => updateUserStatus(managedUser)} disabled={pending}>
                          {managedUser.status === "active" ? "停用" : "启用"}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            </>
          )}
        </div>
        {pending && <div className="account-pending"><LoaderCircle className="spin" size={18} /> 正在处理</div>}
      </section>
    </div>
  );
}
