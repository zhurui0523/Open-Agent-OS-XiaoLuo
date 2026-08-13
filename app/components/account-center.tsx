"use client";

import {
  Building2,
  Check,
  FileText,
  HardDrive,
  Image as ImageIcon,
  LoaderCircle,
  LogOut,
  Music,
  RotateCcw,
  ShieldCheck,
  Trash2,
  UsersRound,
  Video,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { AccountUser, OrganizationSummary } from "../types";
import { useAppDialog } from "./app-dialog";

interface AccountCenterProps {
  user: AccountUser;
  onClose: () => void;
}

interface OrganizationMember {
  userId: string;
  username: string;
  displayName: string;
  email: string;
  phoneLast4: string | null;
  role: "admin" | "member";
  status: "active" | "disabled";
  textCount: number;
  imageCount: number;
  videoCount: number;
  audioCount: number;
  storageBytes: number;
}

interface OutgoingInvitation {
  id: string;
  inviteeUserId: string;
  username: string;
  displayName: string;
  phoneLast4: string | null;
  role: "admin" | "member";
  expiresAt: string;
}

interface IncomingInvitation {
  id: string;
  organizationId: string;
  organizationName: string;
  role: "admin" | "member";
  invitedByName: string;
  invitedByUsername: string;
  expiresAt: string;
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
  return `${(value / 1024 ** 3).toFixed(1)} GB`;
}

export function AccountCenter({ user, onClose }: AccountCenterProps) {
  const dialog = useAppDialog();
  const [organizations, setOrganizations] = useState<OrganizationSummary[]>([]);
  const [selectedOrganizationId, setSelectedOrganizationId] = useState("");
  const [members, setMembers] = useState<OrganizationMember[]>([]);
  const [outgoingInvitations, setOutgoingInvitations] = useState<
    OutgoingInvitation[]
  >([]);
  const [incomingInvitations, setIncomingInvitations] = useState<
    IncomingInvitation[]
  >([]);
  const [companyName, setCompanyName] = useState("");
  const [registrationCode, setRegistrationCode] = useState("");
  const [applicationNote, setApplicationNote] = useState("");
  const [memberIdentifier, setMemberIdentifier] = useState("");
  const [memberRole, setMemberRole] = useState<"admin" | "member">("member");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const loadOrganizations = useCallback(async () => {
    const payload = await requestJson<{ organizations: OrganizationSummary[] }>(
      "/api/v2/organizations",
    );
    setOrganizations(payload.organizations);
    setSelectedOrganizationId((current) => {
      if (payload.organizations.some((organization) => organization.id === current)) {
        return current;
      }
      return (
        payload.organizations.find(
          (organization) =>
            organization.status === "active" && organization.role === "admin",
        )?.id ??
        payload.organizations.find(
          (organization) => organization.status === "active" && organization.role,
        )?.id ??
        ""
      );
    });
  }, []);

  const loadMembers = useCallback(async (organizationId: string) => {
    if (!organizationId) {
      setMembers([]);
      setOutgoingInvitations([]);
      return;
    }
    const payload = await requestJson<{
      members: OrganizationMember[];
      invitations: OutgoingInvitation[];
    }>(
      `/api/v2/organizations/members?organizationId=${encodeURIComponent(organizationId)}`,
    );
    setMembers(payload.members);
    setOutgoingInvitations(payload.invitations);
  }, []);

  const loadInvitations = useCallback(async () => {
    const payload = await requestJson<{ invitations: IncomingInvitation[] }>(
      "/api/v2/organizations/invitations",
    );
    setIncomingInvitations(payload.invitations);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      void loadOrganizations().catch((loadError) =>
        setError(loadError instanceof Error ? loadError.message : "账户信息加载失败"),
      );
    }, 0);
    return () => clearTimeout(timer);
  }, [loadOrganizations]);

  useEffect(() => {
    const timer = setTimeout(() => {
      void loadInvitations().catch((loadError) =>
        setError(loadError instanceof Error ? loadError.message : "企业邀请加载失败"),
      );
    }, 0);
    return () => clearTimeout(timer);
  }, [loadInvitations]);

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
          identifier: memberIdentifier,
          role: memberRole,
        }),
      });
      setMemberIdentifier("");
      setMessage("邀请已发送，等待对方确认后才会正式加入企业。");
      await loadMembers(selectedOrganizationId);
    });
  }

  async function respondToInvitation(
    invitation: IncomingInvitation,
    action: "accept" | "decline",
  ) {
    if (action === "accept") {
      const confirmed = await dialog.confirm(
        `确认加入“${invitation.organizationName}”？企业成员共享企业管理员的空间，加入后你将不再拥有个人空间，现有的个人画布、项目与素材资产将被删除；被移出或退出企业后才能重新拥有全新的个人空间。`,
        {
          title: "接受企业邀请",
          confirmText: "确认加入",
          tone: "danger",
        },
      );
      if (!confirmed) return;
    }
    void perform(async () => {
      await requestJson("/api/v2/organizations/invitations", {
        method: "PATCH",
        body: JSON.stringify({ invitationId: invitation.id, action }),
      });
      setMessage(action === "accept" ? `已加入“${invitation.organizationName}”` : "已拒绝企业邀请");
      await Promise.all([loadInvitations(), loadOrganizations()]);
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

  async function removeMember(member: OrganizationMember) {
    const confirmed = await dialog.confirm(
      `确认将“${member.displayName}”从企业成员列表中移除？移除后其在企业工作期间产生的画布、项目与素材资产将被全部删除，对方转为普通用户并仅保留一个全新的空个人空间；如需再次加入须重新邀请并由对方确认。`,
      {
        title: "移出企业成员",
        confirmText: "确认移出",
        tone: "danger",
      },
    );
    if (!confirmed) return;

    void perform(async () => {
      await requestJson("/api/v2/organizations/members", {
        method: "DELETE",
        body: JSON.stringify({
          organizationId: selectedOrganizationId,
          userId: member.userId,
        }),
      });
      setMessage(`“${member.displayName}”已从企业成员列表中移除。`);
      await loadMembers(selectedOrganizationId);
    });
  }

  async function leaveOrganization(organization: OrganizationSummary) {
    const confirmed = await dialog.confirm(
      `确认退出“${organization.name}”？退出后你在企业工作期间产生的画布、项目与素材资产将被全部删除，仅保留一个全新的空个人空间；如需再次加入须由管理员重新邀请。`,
      {
        title: "退出企业",
        confirmText: "确认退出",
        tone: "danger",
      },
    );
    if (!confirmed) return;

    void perform(async () => {
      await requestJson("/api/v2/organizations/leave", {
        method: "POST",
        body: JSON.stringify({ organizationId: organization.id }),
      });
      setMessage(`已退出“${organization.name}”。`);
      await loadOrganizations();
    });
  }

  async function dissolveOrganization(organization: OrganizationSummary) {
    const roster =
      organization.id === selectedOrganizationId
        ? members
        : (
            await requestJson<{ members: OrganizationMember[] }>(
              `/api/v2/organizations/members?organizationId=${encodeURIComponent(organization.id)}`,
            )
          ).members;
    const remaining = roster.filter((member) => member.userId !== user.id);
    if (remaining.length > 0) {
      await dialog.alert(
        `解散企业前必须先将所有成员从企业中移出（当前仍有 ${remaining.length} 名成员）。请在下方成员列表中移除全部成员后再试。`,
        { title: "无法解散企业", confirmText: "我知道了", tone: "warning" },
      );
      return;
    }
    const confirmed = await dialog.confirm(
      `确认解散“${organization.name}”？解散后企业空间及其全部项目、画布与素材将被永久删除，且无法恢复。仅当所有成员都已移出企业时才允许解散。`,
      {
        title: "解散企业",
        confirmText: "确认解散",
        tone: "danger",
      },
    );
    if (!confirmed) return;

    void perform(async () => {
      await requestJson("/api/v2/organizations/dissolve", {
        method: "POST",
        body: JSON.stringify({ organizationId: organization.id }),
      });
      setMessage(`“${organization.name}”已解散。`);
      await loadOrganizations();
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

          {incomingInvitations.length > 0 && (
            <section className="account-section account-invitations-section">
              <div className="account-section-title">
                <div>
                  <UsersRound size={18} />
                  <span>
                    <b>待确认的企业邀请</b>
                    <small>接受后才会正式成为企业成员，加入后将共享企业空间；也可以选择拒绝。</small>
                  </span>
                </div>
              </div>
              <div className="account-invitation-list">
                {incomingInvitations.map((invitation) => (
                  <div key={invitation.id}>
                    <span>
                      <b>{invitation.organizationName}</b>
                      <small>
                        @{invitation.invitedByUsername} 邀请你成为
                        {invitation.role === "admin" ? "企业管理员" : "企业普通用户"}
                      </small>
                    </span>
                    <div className="account-invitation-actions">
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={pending}
                        onClick={() => respondToInvitation(invitation, "decline")}
                      >
                        拒绝
                      </button>
                      <button
                        type="button"
                        className="primary-button"
                        disabled={pending}
                        onClick={() => respondToInvitation(invitation, "accept")}
                      >
                        接受邀请
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="account-section">
            <div className="account-section-title">
              <div><Building2 size={18} /><span><b>我的企业</b><small>个人空间始终保留，企业空间独立管理。</small></span></div>
            </div>
            {organizations.length ? (
              <div className="organization-list">
                {organizations.map((organization) => (
                  <div key={organization.id} className="organization-item">
                    <button
                      type="button"
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
                    {organization.status === "active" && (
                      <span className="organization-storage" title={"企业管理员空间的使用量"}>
                        <HardDrive size={14} />
                        <span>
                          <b>已使用 {formatBytes(organization.storageUsedBytes)}</b>
                          <small>剩余 {formatBytes(organization.storageRemainingBytes)} · 管理员空间</small>
                        </span>
                      </span>
                    )}
                    {organization.status === "active" &&
                      (organization.role === "admin" ? (
                        <button
                          type="button"
                          className="organization-leave"
                          disabled={pending}
                          aria-label="解散企业"
                          onClick={() => void dissolveOrganization(organization)}
                        >
                          <Trash2 size={14} />
                          解散企业
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="organization-leave"
                          disabled={pending}
                          onClick={() => void leaveOrganization(organization)}
                        >
                          <LogOut size={14} />
                          退出企业
                        </button>
                      ))}
                  </div>
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
                <div><UsersRound size={18} /><span><b>企业成员</b><small>可用用户名或已绑定手机号邀请；对方接受后才会正式加入。</small></span></div>
              </div>
              {selectedOrganization.role === "admin" && (
                <form className="member-add-form" onSubmit={addMember}>
                  <input value={memberIdentifier} onChange={(event) => setMemberIdentifier(event.target.value)} placeholder="用户名或已绑定手机号" required />
                  <select value={memberRole} onChange={(event) => setMemberRole(event.target.value as "admin" | "member")}>
                    <option value="member">企业普通用户</option>
                    <option value="admin">企业管理员</option>
                  </select>
                  <button className="secondary-button" disabled={pending}>发送邀请</button>
                </form>
              )}
              {selectedOrganization.role === "admin" && outgoingInvitations.length > 0 && (
                <div className="account-outgoing-invitations">
                  <strong>等待对方确认</strong>
                  {outgoingInvitations.map((invitation) => (
                    <div key={invitation.id}>
                      <span>
                        <b>{invitation.displayName}</b>
                        <small>
                          @{invitation.username}
                          {invitation.phoneLast4 ? ` · 手机尾号 ${invitation.phoneLast4}` : ""}
                        </small>
                      </span>
                      <em>待确认</em>
                    </div>
                  ))}
                </div>
              )}
              <div className="account-table account-member-table">
                <div className="account-member-table-head">
                  <span>成员信息</span>
                  <span>使用情况</span>
                  <span>角色</span>
                  <span>状态</span>
                  <span>操作</span>
                </div>
                {members.map((member) => {
                  const canOperate =
                    selectedOrganization.role === "admin" && member.userId !== user.id;
                  return (
                    <div key={member.userId}>
                      <span><b>{member.displayName}</b><small>@{member.username}</small></span>
                      <div className="account-member-usage">
                        <div className="admin-usage-counts">
                          <span title="文本调用次数">
                            <FileText size={13} /> 文本 {member.textCount}
                          </span>
                          <span title="图片调用次数">
                            <ImageIcon size={13} /> 图片 {member.imageCount}
                          </span>
                          <span title="视频调用次数">
                            <Video size={13} /> 视频 {member.videoCount}
                          </span>
                          <span title="音乐调用次数">
                            <Music size={13} /> 音乐 {member.audioCount}
                          </span>
                        </div>
                        <div className="admin-storage-cell">
                          <HardDrive size={15} />
                          <span>
                            <b>{formatBytes(member.storageBytes)}</b>
                            <small>文件与画布资产</small>
                          </span>
                        </div>
                      </div>
                      <span className="account-member-cell">
                        <em className={member.role === "admin" ? "is-role-admin" : ""}>
                          {member.role === "admin" ? "企业管理员" : "企业普通用户"}
                        </em>
                      </span>
                      <span className="account-member-cell">
                        <em className={member.status === "disabled" ? "is-disabled" : ""}>
                          {member.status === "disabled" ? "已停用" : "活跃"}
                        </em>
                      </span>
                      {canOperate ? (
                        member.status === "disabled" ? (
                          <div className="account-member-actions account-member-actions-disabled">
                            <button
                              type="button"
                              className="account-member-reactivate"
                              disabled={pending}
                              onClick={() => updateMember(member, { status: "active" })}
                            >
                              <RotateCcw size={14} />
                              重新启用
                            </button>
                            <button
                              type="button"
                              className="account-member-remove"
                              disabled={pending}
                              onClick={() => void removeMember(member)}
                            >
                              <Trash2 size={14} />
                              移除
                            </button>
                          </div>
                        ) : (
                          <div className="account-member-actions">
                            <button type="button" disabled={pending} onClick={() => updateMember(member, { role: member.role === "admin" ? "member" : "admin" })}>
                              {member.role === "admin" ? "改为普通用户" : "设为管理员"}
                            </button>
                            <button type="button" disabled={pending} onClick={() => updateMember(member, { status: "disabled" })}>
                              停用
                            </button>
                          </div>
                        )
                      ) : (
                        <span className="account-member-cell account-member-cell-empty">—</span>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          )}

        </div>
        {pending && <div className="account-pending"><LoaderCircle className="spin" size={18} /> 正在处理</div>}
      </section>
    </div>
  );
}
