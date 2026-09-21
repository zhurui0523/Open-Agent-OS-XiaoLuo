"use client";

import {
  Activity,
  Braces,
  Check,
  CircleAlert,
  Code2,
  Cpu,
  Download,
  FileArchive,
  FileJson,
  Github,
  LoaderCircle,
  PackagePlus,
  PanelsTopLeft,
  Play,
  PlugZap,
  RefreshCw,
  Server,
  ShieldCheck,
  SquarePen,
  Trash2,
  Upload,
  Workflow,
  X,
} from "lucide-react";
import { createRuntimeId } from "../lib/runtime-id";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IntentOSController } from "../hooks/use-intent-os";
import type {
  AccountUser,
  Capability,
  InstalledPackage,
  GithubCompatibilityReport,
  GithubPackageImportResult,
  MarketplacePackage,
  MediaPluginType,
  NodeKind,
  WorkflowMarketplaceItem,
} from "../types";
import { skillManifestFromMarkdown } from "../lib/skill-markdown";
import { packageInstallStatus } from "../lib/package-install-status";
import {
  MEDIA_PLUGIN_TYPES,
  mediaPluginTypes,
  normalizeMediaPluginTypes,
} from "../lib/media-plugin";
import { useAppDialog } from "./app-dialog";
import { SchemaOptionBuilder } from "./schema-option-builder";

const packageTypeLabel = {
  skill: "SKILL",
  agent: "Agent",
  workflow: "Workflow",
  plugin: "插件",
  "model-provider": "模型 Provider",
  adapter: "Adapter",
};

const runtimeMeta = {
  declarative: { label: "声明式", icon: Braces },
  "sandbox-ui": { label: "iframe 沙盒", icon: PanelsTopLeft },
  "remote-api": { label: "远程 API", icon: Server },
  "isolated-worker": { label: "隔离 Worker", icon: Cpu },
};

const accessScopeLabel = {
  personal: "私有",
  workspace: "企业共享",
  marketplace: "共享",
};

const skillTypeLabel: Record<NodeKind, string> = {
  text: "文本",
  image: "图片",
  video: "视频",
  audio: "音频",
  document: "文档",
};

const skillTypeOrder: NodeKind[] = [
  "text",
  "image",
  "video",
  "audio",
  "document",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeKind(value: unknown): value is NodeKind {
  return skillTypeOrder.includes(value as NodeKind);
}

function getSkillTypeLabels(
  item: InstalledPackage | MarketplacePackage,
  capabilities: Capability[],
) {
  const modalities = new Set<NodeKind>();
  const contributes = isRecord(item.manifest?.contributes)
    ? item.manifest.contributes
    : null;
  const skills = contributes && Array.isArray(contributes.skills)
    ? contributes.skills
    : [];

  skills.forEach((skill) => {
    if (isRecord(skill) && isNodeKind(skill.modality)) {
      modalities.add(skill.modality);
    }
  });

  capabilities.forEach((capability) => {
    if (
      capability.packageId === item.id &&
      capability.contributionType === "skill" &&
      isNodeKind(capability.modality)
    ) {
      modalities.add(capability.modality);
    }
  });

  if ("nodeContributions" in item) {
    item.nodeContributions?.forEach((contribution) => {
      if (isNodeKind(contribution.modality)) {
        modalities.add(contribution.modality);
      }
    });
  }

  const labels = skillTypeOrder
    .filter((modality) => modalities.has(modality))
    .map((modality) => skillTypeLabel[modality]);

  return labels.length ? labels : ["未标注类型"];
}

const starterManifest = `{
  "schemaVersion": "2.0",
  "id": "com.yourcompany.plugin-name",
  "name": "你的插件名称",
  "version": "1.0.0",
  "description": "插件功能说明",
  "type": "plugin",
  "assetTypes": ["image", "video", "audio"],
  "access": {
    "scope": "personal"
  },
  "runtime": {
    "type": "sandbox-ui",
    "entry": "https://plugin.example.com/panel"
  },
  "permissions": ["assets:read"],
  "contributes": {
    "panels": [
      {
        "id": "com.yourcompany.panel.main",
        "title": "插件面板"
      }
    ]
  }
}`;

interface CapabilitiesViewProps {
  os: IntentOSController;
  user: AccountUser;
}

export function CapabilitiesView({ os, user }: CapabilitiesViewProps) {
  const dialog = useAppDialog();
  const [packageDialog, setPackageDialog] = useState<
    InstalledPackage | "new" | null
  >(null);
  const [skillDialog, setSkillDialog] = useState<Capability | "new" | null>(
    null,
  );
  const [skillDialogTargetPackageId, setSkillDialogTargetPackageId] =
    useState<string | null>(null);
  const [sandbox, setSandbox] = useState<{
    title: string;
    url: string;
  } | null>(null);
  const [notice, setNotice] = useState<{
    tone: "success" | "error" | "info";
    text: string;
  } | null>(null);
  const [workflows, setWorkflows] = useState<WorkflowMarketplaceItem[]>([]);
  const [marketplacePackages, setMarketplacePackages] = useState<
    MarketplacePackage[]
  >([]);
  const [marketplaceStatus, setMarketplaceStatus] = useState<
    "loading" | "ready" | "error"
  >("loading");
  const [marketplaceError, setMarketplaceError] = useState("");

  const refreshMarketplace = useCallback(async () => {
    if (!os.workspaceId) return;
    setMarketplaceStatus("loading");
    setMarketplaceError("");
    try {
      const current = new URLSearchParams(window.location.search);
      const query = new URLSearchParams({ workspaceId: os.workspaceId });
      if (current.get("workflow")) query.set("id", current.get("workflow") as string);
      if (current.get("token")) query.set("token", current.get("token") as string);
      const [workflowResponse, packageResponse] = await Promise.all([
        fetch(`/api/v2/workflows/marketplace?${query.toString()}`),
        fetch(`/api/v2/packages/marketplace?${query.toString()}`),
      ]);
      const payload = (await workflowResponse.json().catch(() => ({}))) as {
        workflows?: WorkflowMarketplaceItem[];
        error?: string;
      };
      const packagePayload = (await packageResponse.json().catch(() => ({}))) as {
        packages?: MarketplacePackage[];
        error?: string;
      };
      if (!workflowResponse.ok) {
        throw new Error(payload.error ?? "读取能力商城失败");
      }
      if (!packageResponse.ok) {
        throw new Error(packagePayload.error ?? "读取 Skill / 插件商城失败");
      }
      setWorkflows(payload.workflows ?? []);
      setMarketplacePackages(packagePayload.packages ?? []);
      setMarketplaceStatus("ready");
    } catch (error) {
      setMarketplaceError(
        error instanceof Error ? error.message : "读取能力商城失败",
      );
      setMarketplaceStatus("error");
    }
  }, [os.workspaceId]);

  async function refreshCapabilities() {
    await Promise.all([os.refreshRegistry(), refreshMarketplace()]);
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refreshMarketplace();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [refreshMarketplace]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 5_000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  function showNotice(
    text: string,
    tone: "success" | "error" | "info" = "success",
  ) {
    setNotice({ text, tone });
  }

  return (
    <section className="content-view capability-view" aria-label="能力中心">
      <header className="content-header extension-header">
        <div>
          <span className="eyebrow">CAPABILITY CENTER · CONTRACT V2</span>
          <h1>能力中心</h1>
          <p>Skill、插件与 Workflow 分层管理；Agent 只服务于 Intent 对话与规划。</p>
        </div>
        <div className="header-button-group">
          <button
            type="button"
            className="secondary-button"
            title="创建私有或共享 Skill"
            onClick={() => {
              setSkillDialogTargetPackageId(null);
              setSkillDialog("new");
            }}
          >
            <Code2 size={16} /> 创建 Skill
          </button>
          <button
            type="button"
            className="primary-button"
            title="导入 Skill Markdown 或 Package"
            onClick={() => setPackageDialog("new")}
          >
            <PackagePlus size={16} /> 导入 Package
          </button>
        </div>
      </header>

      {os.registryStatus === "error" && (
        <div className="registry-banner is-error" role="alert">
          <CircleAlert size={16} />
          <span>{os.registryError}</span>
          <button type="button" onClick={() => void os.refreshRegistry()}>
            重试
          </button>
        </div>
      )}

      <MarketplacePanel
        os={os}
        dialog={dialog}
        isSystemAdmin={user.platformRole === "system_admin"}
        userId={user.id}
        workflows={workflows}
        marketplacePackages={marketplacePackages}
        status={marketplaceStatus}
        error={marketplaceError}
        onRefresh={refreshCapabilities}
        onEditPackage={(item) => setPackageDialog(item)}
        onEditSkill={(item) => {
          const capability = os.capabilities.find(
            (candidate) => candidate.packageId === item.id,
          );
          if (capability) {
            setSkillDialogTargetPackageId(
              item.availabilitySource === "added" &&
                user.platformRole === "system_admin"
                ? item.id
                : null,
            );
            setSkillDialog(capability);
            return;
          }
          showNotice("该 Skill 尚未生成可编辑的能力契约。", "error");
        }}
        onNotice={showNotice}
      />
      {notice && (
        <div className={`extension-toast is-${notice.tone}`} role="status">
          {notice.tone === "success" ? (
            <Check size={15} />
          ) : notice.tone === "error" ? (
            <CircleAlert size={15} />
          ) : (
            <Activity size={15} />
          )}
          <span>{notice.text}</span>
          <button type="button" aria-label="关闭提示" onClick={() => setNotice(null)}>
            <X size={14} />
          </button>
        </div>
      )}

      {packageDialog && (
        <PackageDialog
          initial={packageDialog === "new" ? undefined : packageDialog}
          packages={os.packages}
          onClose={() => setPackageDialog(null)}
          onInstall={async (input) => {
            const result =
              input.kind === "archive"
                ? await os.installPackageArchive(
                    input.file,
                    input.accessScope,
                  )
                : input.kind === "github"
                  ? await os.installPackageFromGithub({
                      url: input.url,
                      ref: input.ref,
                      accessScope: input.accessScope,
                    })
                  : await os.installPackage(input.raw);
            if (result.status === "needs_adaptation") return result;
            await refreshMarketplace();
            if (result.source?.executionReady === false) {
              showNotice(
                `${result.package.name} 源码已导入并固定 Commit；该项目需要隔离构建，完成前不会执行第三方代码。`,
                "info",
              );
            } else {
              showNotice(
                `${result.package.name} 已${result.action === "installed" ? "安装" : "更新"}，画布节点选项已刷新。`,
              );
            }
            return result;
          }}
        />
      )}
      {skillDialog && (
        <SkillBuilderDialog
          initial={skillDialog === "new" ? undefined : skillDialog}
          packages={os.packages}
          onClose={() => {
            setSkillDialog(null);
            setSkillDialogTargetPackageId(null);
          }}
          onInstall={async (raw) => {
            const result = await os.installPackage(raw, {
              targetPackageId: skillDialogTargetPackageId ?? undefined,
            });
            setSkillDialog(null);
            setSkillDialogTargetPackageId(null);
            await refreshMarketplace();
            showNotice(
              `${result.package.name} 已${result.action === "installed" ? "创建" : "更新"}，节点选项与模型兼容规则已同步。`,
            );
          }}
        />
      )}
      {sandbox && (
        <SandboxDialog
          title={sandbox.title}
          url={sandbox.url}
          onClose={() => setSandbox(null)}
        />
      )}
    </section>
  );
}

const mediaPluginTypeLabel: Record<MediaPluginType, string> = {
  image: "图片",
  video: "视频",
  audio: "音频",
};

function PluginCardQuickSettings({
  item,
  disabled,
  onSave,
}: {
  item: InstalledPackage;
  disabled: boolean;
  onSave: (settings: {
    accessScope?: "personal" | "marketplace";
    assetTypes?: MediaPluginType[];
  }) => Promise<boolean>;
}) {
  const [accessScope, setAccessScope] = useState<"personal" | "marketplace">(
    item.accessScope === "marketplace" ? "marketplace" : "personal",
  );
  const [assetTypes, setAssetTypes] = useState<MediaPluginType[]>(() =>
    mediaPluginTypes(item),
  );
  const [saving, setSaving] = useState(false);

  async function changeAccessScope(nextScope: "personal" | "marketplace") {
    if (nextScope === accessScope) return;
    const previousScope = accessScope;
    setAccessScope(nextScope);
    setSaving(true);
    const saved = await onSave({ accessScope: nextScope });
    if (!saved) setAccessScope(previousScope);
    setSaving(false);
  }

  async function toggleAssetType(type: MediaPluginType) {
    const previousTypes = assetTypes;
    const nextTypes = assetTypes.includes(type)
      ? assetTypes.filter((value) => value !== type)
      : MEDIA_PLUGIN_TYPES.filter(
          (value) => value === type || assetTypes.includes(value),
        );
    setAssetTypes(nextTypes);
    setSaving(true);
    const saved = await onSave({ assetTypes: nextTypes });
    if (!saved) setAssetTypes(previousTypes);
    setSaving(false);
  }

  const isDisabled = disabled || saving;

  return (
    <div className="package-card-quick-settings">
      <label className="package-card-quick-field">
        <span>可见范围</span>
        <select
          value={accessScope}
          disabled={isDisabled}
          onChange={(event) =>
            void changeAccessScope(
              event.target.value as "personal" | "marketplace",
            )
          }
        >
          <option value="personal">私有</option>
          <option value="marketplace">共享</option>
        </select>
      </label>
      <div className="package-card-quick-types">
        <span>适用类型</span>
        <details className="package-card-quick-type-dropdown">
          <summary aria-label="选择适用类型">
            {assetTypes.length
              ? assetTypes.map((type) => mediaPluginTypeLabel[type]).join("、")
              : "未选择"}
          </summary>
          <div className="package-card-quick-type-options" aria-label="适用类型">
            {MEDIA_PLUGIN_TYPES.map((type) => {
              const selected = assetTypes.includes(type);
              return (
                <button
                  key={type}
                  type="button"
                  className={selected ? "is-active" : ""}
                  role="checkbox"
                  aria-checked={selected}
                  disabled={isDisabled}
                  onClick={() => void toggleAssetType(type)}
                >
                  <span>{selected ? <Check size={11} /> : null}</span>
                  {mediaPluginTypeLabel[type]}
                </button>
              );
            })}
          </div>
        </details>
      </div>
      {saving && <LoaderCircle className="spin" size={14} aria-label="保存中" />}
    </div>
  );
}

/** 技能市场条目（小逻工作区 SKILL.md 流通层；与 Package 契约不同） */
interface SkillMarketListing {
  name: string;
  description: string;
  publisherId: string;
  publisherName: string;
  publishedAt: string;
  localCopy: boolean;
}

function MarketplacePanel({
  os,
  dialog,
  isSystemAdmin,
  userId,
  workflows,
  marketplacePackages,
  status,
  error,
  onRefresh,
  onEditPackage,
  onEditSkill,
  onNotice,
}: {
  os: IntentOSController;
  dialog: ReturnType<typeof useAppDialog>;
  isSystemAdmin: boolean;
  userId: string;
  workflows: WorkflowMarketplaceItem[];
  marketplacePackages: MarketplacePackage[];
  status: "loading" | "ready" | "error";
  error: string;
  onRefresh: () => Promise<void>;
  onEditPackage: (item: InstalledPackage) => void;
  onEditSkill: (item: InstalledPackage) => void;
  onNotice: (
    text: string,
    tone?: "success" | "error" | "info",
  ) => void;
}) {
  const [category, setCategory] = useState<"skill" | "plugin" | "workflow">(
    "skill",
  );
  const [source, setSource] = useState<
    "installed" | "private" | "shared" | "market"
  >("installed");
  const [workspaceSkills, setWorkspaceSkills] = useState<
    Array<{ name: string; description: string; source: string }>
  >([]);

  // 工作区技能扫描（工作区 skills/ + 插件自带技能）：能力中心显示便于管理，对话 /名字 引用
  useEffect(() => {
    if (category !== "skill") return;
    let live = true;
    type FsEntry = { path: string; isDir?: boolean };
    const fsAction = async (action: "list" | "read", path: string) => {
      const bridge = (
        window as unknown as {
          xiaoluoDesktop?: {
            fsAction?: (payload: unknown) => Promise<{
              error?: string;
              entries?: FsEntry[];
              content?: string;
            }>;
          };
        }
      ).xiaoluoDesktop;
      if (bridge && typeof bridge.fsAction === "function") {
        const res = await bridge.fsAction({ action, path, mode: "default" });
        if (res.error) throw new Error(res.error);
        return res;
      }
      const resp = await fetch("/api/v2/brain/fs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, path, mode: "default" }),
      });
      const data = (await resp.json().catch(() => ({}))) as {
        error?: string;
        entries?: FsEntry[];
        content?: string;
      };
      if (!resp.ok) throw new Error(data.error ?? "读取失败");
      return data;
    };
    const readDescription = async (rel: string) => {
      try {
        const res = await fsAction("read", rel);
        const matched = /description:\s*(.+)/.exec(res.content ?? "");
        return matched ? matched[1].trim() : "";
      } catch {
        return "";
      }
    };
    void (async () => {
      try {
        const items: Array<{ name: string; description: string; source: string }> = [];
        const dirs = ((await fsAction("list", "skills")).entries ?? [])
          .filter((entry) => entry.isDir)
          .slice(0, 50);
        for (const dir of dirs) {
          const name = String(dir.path).split("/").pop() ?? "";
          if (!name) continue;
          items.push({
            name,
            description: await readDescription(`skills/${name}/SKILL.md`),
            source: "工作区",
          });
        }
        try {
          const pluginDirs = ((await fsAction("list", "plugins")).entries ?? [])
            .filter((entry) => entry.isDir)
            .slice(0, 5);
          for (const pluginDir of pluginDirs) {
            const pluginName = String(pluginDir.path).split("/").pop() ?? "";
            if (!pluginName) continue;
            try {
              const skillDirs = (
                (await fsAction("list", `plugins/${pluginName}/skills`))
                  .entries ?? []
              )
                .filter((entry) => entry.isDir)
                .slice(0, 20);
              for (const skillDir of skillDirs) {
                const skillName = String(skillDir.path).split("/").pop() ?? "";
                if (!skillName) continue;
                items.push({
                  name: skillName,
                  description: await readDescription(
                    `plugins/${pluginName}/skills/${skillName}/SKILL.md`,
                  ),
                  source: `插件 ${pluginName}`,
                });
              }
            } catch {
              /* 插件无 skills 目录跳过 */
            }
          }
        } catch {
          /* plugins 目录不存在跳过 */
        }
        if (live) setWorkspaceSkills(items);
      } catch {
        /* 工作区不存在按空库处理 */
      }
    })();
    return () => {
      live = false;
    };
  }, [category]);
  // ---- 技能市场（小逻工作区 SKILL.md 流通层；与 Package 体系不同契约，独立子页签承载） ----
  const [skillMarketListings, setSkillMarketListings] = useState<
    SkillMarketListing[]
  >([]);
  const [marketStatus, setMarketStatus] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [marketError, setMarketError] = useState("");
  const [busyId, setBusyId] = useState("");
  const myPackageItems = os.packages.filter(
    (item) =>
      item.packageType === category &&
      item.lifecycleState !== "uninstalled",
  );

  async function loadSkillMarket() {
    setMarketStatus("loading");
    setMarketError("");
    try {
      const resp = await fetch("/api/v2/brain/skill-market");
      const payload = (await resp.json().catch(() => ({}))) as {
        listings?: SkillMarketListing[];
        error?: string;
      };
      if (!resp.ok) {
        throw new Error(payload.error ?? "读取技能市场失败 (" + resp.status + ")");
      }
      setSkillMarketListings(payload.listings ?? []);
      setMarketStatus("ready");
    } catch (reason) {
      setMarketError(reason instanceof Error ? reason.message : "读取技能市场失败");
      setMarketStatus("error");
    }
  }

  useEffect(() => {
    if (category === "skill" && source === "market") void loadSkillMarket();
  }, [category, source]);

  async function marketAct(
    listing: SkillMarketListing,
    action: "install" | "unpublish",
  ) {
    if (action === "unpublish") {
      const confirmed = await dialog.confirm(
        "下架该技能后，它将不再出现在其他用户的技能市场；已安装到别人工作区的副本不受影响。确认下架 " + listing.name + " ？",
        { title: "下架技能", confirmText: "确认下架", tone: "danger" },
      );
      if (!confirmed) return;
    }
    setBusyId("market:" + listing.publisherId + "/" + listing.name);
    try {
      const resp = await fetch("/api/v2/brain/skill-market", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          action === "install"
            ? { action, name: listing.name, publisherId: listing.publisherId }
            : { action, name: listing.name },
        ),
      });
      const payload = (await resp.json().catch(() => ({}))) as { error?: string };
      if (!resp.ok) {
        throw new Error(payload.error ?? (action === "install" ? "安装失败" : "下架失败"));
      }
      if (action === "install") {
        onNotice(listing.name + " 已安装到小逻工作区技能库。");
      } else {
        onNotice(listing.name + " 已下架。");
      }
      await loadSkillMarket();
    } catch (reason) {
      onNotice(reason instanceof Error ? reason.message : "操作失败", "error");
    } finally {
      setBusyId("");
    }
  }
  const publicPackageItems = marketplacePackages.filter(
    (item) => item.packageType === category,
  );
  const privatePackageItems = myPackageItems.filter(
    (item) =>
      item.ownerScope === "personal" &&
      item.accessScope === "personal",
  );
  const ownedSharedPackageItems = myPackageItems.filter(
    (item) =>
      item.ownerScope === "personal" &&
      item.accessScope !== "personal",
  );
  const ownedSharedKeys = new Set(
    ownedSharedPackageItems.map((item) => item.packageKey).filter(Boolean),
  );
  const otherSharedPackageItems = publicPackageItems.filter(
    (item) => !ownedSharedKeys.has(item.packageKey),
  );

  async function install(item: WorkflowMarketplaceItem) {
    setBusyId(item.id);
    try {
      const query = new URLSearchParams(window.location.search);
      const result = await os.installWorkflow(
        item.id,
        item.version,
        query.get("token") ?? undefined,
      );
      const missing = [
        ...result.missing.skills.map((value) => `Skill：${value}`),
        ...result.missing.plugins.map((value) => `插件：${value}`),
        ...result.missing.models.map((value) => `模型：${value}`),
      ];
      onNotice(
        missing.length
          ? `Workflow 已安装，待补齐 ${missing.join("、")}`
          : "Workflow 已安装为独立画布，依赖已完成映射。",
        missing.length ? "info" : "success",
      );
    } catch (reason) {
      onNotice(reason instanceof Error ? reason.message : "安装失败", "error");
    } finally {
      setBusyId("");
    }
  }

  async function deleteWorkflow(item: WorkflowMarketplaceItem) {
    const confirmed = await dialog.confirm(
      `确认删除共享画布“${item.title}”？它将从所有用户的 Workflow 列表中移除，但已经安装生成的独立画布会保留。`,
      {
        title: "删除共享画布",
        confirmText: "确认删除",
        tone: "danger",
      },
    );
    if (!confirmed) return;

    setBusyId(item.id);
    try {
      const response = await fetch(
        `/api/v2/workflows/marketplace?id=${encodeURIComponent(item.id)}`,
        { method: "DELETE" },
      );
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error ?? "删除共享画布失败");
      }
      await onRefresh();
      onNotice(`${item.title} 已从 Workflow 列表中删除。`);
    } catch (reason) {
      onNotice(
        reason instanceof Error ? reason.message : "删除共享画布失败",
        "error",
      );
    } finally {
      setBusyId("");
    }
  }

  async function addMarketplacePackage(item: MarketplacePackage) {
    setBusyId(item.id);
    try {
      if (item.packageType === "skill") {
        const result = await os.addPackageToAvailable(item.id);
        await onRefresh();
        onNotice(`${result.package.name} 已添加到可用 Skill。`);
        return;
      }
      const result = await os.installPackage(JSON.stringify(item.manifest));
      await onRefresh();
      onNotice(`${result.package.name} 已安装。`);
    } catch (reason) {
      onNotice(
        reason instanceof Error
          ? reason.message
          : item.packageType === "skill"
            ? "添加到可用 Skill 失败"
            : "安装失败",
        "error",
      );
    } finally {
      setBusyId("");
    }
  }

  async function removeAvailableSkill(item: InstalledPackage) {
    const confirmed = await dialog.confirm(
      `从你的“可用 Skill”中移除“${item.name}”？共享 Skill 本身不会被删除，也不会影响其他用户。`,
      {
        title: "移除可用 Skill",
        confirmText: "确认移除",
        tone: "danger",
      },
    );
    if (!confirmed) return;

    setBusyId(item.id);
    try {
      const result = await os.removePackageFromAvailable(item.id);
      await onRefresh();
      onNotice(`${result.package.name} 已从你的可用 Skill 中移除。`);
    } catch (reason) {
      onNotice(
        reason instanceof Error ? reason.message : "移除可用 Skill 失败",
        "error",
      );
    } finally {
      setBusyId("");
    }
  }

  async function savePluginSettings(
    item: InstalledPackage,
    settings: {
      accessScope?: "personal" | "marketplace";
      assetTypes?: MediaPluginType[];
    },
  ) {
    if (
      settings.accessScope &&
      settings.accessScope !== item.accessScope
    ) {
      const nextLabel =
        settings.accessScope === "personal" ? "私有" : "共享";
      const confirmed = await dialog.confirm(
        `确认将“${item.name}”改为${nextLabel}插件？`,
        {
          title: "修改插件可见范围",
          confirmText: `改为${nextLabel}`,
        },
      );
      if (!confirmed) return false;
    }

    setBusyId(item.id);
    try {
      await os.updatePackageSettings(item.id, settings);
      await onRefresh();
      if (settings.accessScope && source !== "installed") {
        setSource(
          settings.accessScope === "personal" ? "private" : "shared",
        );
      }
      onNotice(`${item.name} 的插件设置已保存。`);
      return true;
    } catch (reason) {
      onNotice(
        reason instanceof Error ? reason.message : "保存插件设置失败",
        "error",
      );
      return false;
    } finally {
      setBusyId("");
    }
  }

  async function deleteSharedSkill(
    item: Pick<InstalledPackage, "id" | "name" | "packageType">,
  ) {
    const confirmed = await dialog.confirm(
      `删除共享 Skill“${item.name}”后，它将从所有用户的共享列表中移除。已经添加到个人账户的副本不会被强制删除。`,
      {
        title: "删除共享 Skill",
        confirmText: "确认删除",
        tone: "danger",
      },
    );
    if (!confirmed) return;
    setBusyId(item.id);
    try {
      await os.uninstallPackage(item.id);
      await onRefresh();
      onNotice(`${item.name} 已从共享 Skill 中删除。`);
    } catch (reason) {
      onNotice(
        reason instanceof Error ? reason.message : "删除共享 Skill 失败",
        "error",
      );
    } finally {
      setBusyId("");
    }
  }

  return (
    <div className="workflow-marketplace">
      <div className="marketplace-toolbar">
        <div className="marketplace-categories" role="tablist">
          {([
            ["skill", "Skill"],
            ["plugin", "插件"],
            ["workflow", "Workflow"],
          ] as const).map(([value, label]) => (
            <button
              type="button"
              role="tab"
              aria-selected={category === value}
              className={category === value ? "is-active" : ""}
              key={value}
              onClick={() => {
                setCategory(value);
                if (value !== "skill" && source === "market") setSource("installed");
              }}
            >
              {value === "workflow" ? (
                <Workflow size={15} />
              ) : value === "plugin" ? (
                <PlugZap size={15} />
              ) : (
                <Code2 size={15} />
              )}
              {label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="secondary-button compact"
          onClick={() => void onRefresh()}
        >
          <RefreshCw size={14} /> 刷新
        </button>
      </div>

      {category !== "workflow" && (
        <div className="marketplace-source-tabs" role="tablist" aria-label="能力来源">
          <button
            type="button"
            role="tab"
            aria-selected={source === "installed"}
            className={source === "installed" ? "is-active" : ""}
            onClick={() => setSource("installed")}
          >
            {category === "skill" ? "可用 Skill" : "可用插件"}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={source === "private"}
            className={source === "private" ? "is-active" : ""}
            onClick={() => setSource("private")}
          >
            {category === "skill" ? "私有 Skill" : "私有插件"}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={source === "shared"}
            className={source === "shared" ? "is-active" : ""}
            onClick={() => setSource("shared")}
          >
            {category === "skill" ? "共享 Skill" : "共享插件"}
          </button>
          {category === "skill" && (
            <button
              type="button"
              role="tab"
              aria-selected={source === "market"}
              className={source === "market" ? "is-active" : ""}
              onClick={() => setSource("market")}
            >
              技能市场
            </button>
          )}
        </div>
      )}

      {category === "skill" &&
        source === "installed" &&
        workspaceSkills.length > 0 && (
          <section aria-label="工作区技能" style={{ marginBottom: 18 }}>
            <div className="section-title-row">
              <div>
                <h2>工作区技能</h2>
                <p>
                  小逻对话工作区沉淀与插件自带的技能；对话输入框键入 / 加名字即可引用。
                </p>
              </div>
              <span className="registry-version">
                {workspaceSkills.length} 个
              </span>
            </div>
            <div className="workflow-market-grid">
              {workspaceSkills.map((skill) => (
                <article
                  className="workflow-market-card package-market-card"
                  key={`${skill.source}/${skill.name}`}
                >
                  <header>
                    <span>
                      <Code2 size={19} />
                    </span>
                    <div>
                      <h3>{skill.name}</h3>
                      <small>{skill.source}</small>
                    </div>
                    <b>工作区</b>
                  </header>
                  <p>{skill.description || "未填写说明"}</p>
                  <div className="workflow-card-tags">
                    <span>/{skill.name}</span>
                    <span>对话输入 / 引用</span>
                  </div>
                </article>
              ))}
            </div>
          </section>
        )}

      {category === "workflow" ? (
        status === "loading" ? (
          <RegistryLoading label="正在读取 Workflow 商城" />
        ) : status === "error" ? (
          <div className="registry-banner is-error">
            <CircleAlert size={16} />
            <span>{error}</span>
            <button type="button" onClick={() => void onRefresh()}>
              重试
            </button>
          </div>
        ) : workflows.length ? (
          <div className="workflow-market-grid">
            {workflows.map((item) => (
              <article className="workflow-market-card" key={item.id}>
                <header>
                  <span><Workflow size={19} /></span>
                  <div>
                    <h3>{item.title}</h3>
                    <small>
                      @{item.author.username} · v{item.version} · {item.visibility}
                    </small>
                  </div>
                  <b>{item.category}</b>
                </header>
                <p>{item.description}</p>
                <div className="workflow-card-counts">
                  <span>{item.materialCount} 素材位</span>
                  <span>{item.pluginCount} 插件</span>
                  <span>{item.executionCount} 执行节点</span>
                  <span>{item.resultCount} 结果位</span>
                </div>
                <div className="workflow-card-tags">
                  {item.tags.map((tag) => <span key={tag}>#{tag}</span>)}
                  {!item.tags.length && <span>#通用</span>}
                </div>
                <div className="workflow-card-requirements">
                  <small>
                    依赖 {item.requirements.skills.length} 个 Skill ·{" "}
                    {item.requirements.plugins.length} 个插件 ·{" "}
                    {item.requirements.models.length} 类模型
                  </small>
                  <small>已安装 {item.installCount} 次</small>
                </div>
                <footer>
                  {isSystemAdmin && (
                    <button
                      type="button"
                      className="workflow-admin-delete"
                      aria-label={`删除画布 ${item.title}`}
                      title="删除共享画布"
                      disabled={busyId === item.id}
                      onClick={() => void deleteWorkflow(item)}
                    >
                      {busyId === item.id ? (
                        <LoaderCircle size={15} className="spin" />
                      ) : (
                        <Trash2 size={15} />
                      )}
                      <span>删除画布</span>
                    </button>
                  )}
                  <button
                    type="button"
                    className="primary-button compact"
                    disabled={busyId === item.id}
                    onClick={() => void install(item)}
                  >
                    {busyId === item.id ? (
                      <LoaderCircle size={14} className="spin" />
                    ) : (
                      <Download size={14} />
                    )}
                    安装到当前项目
                  </button>
                </footer>
              </article>
            ))}
          </div>
        ) : (
          <div className="extension-empty">
            <span><Workflow size={24} /></span>
            <h3>还没有可用的 Workflow</h3>
            <p>回到画布点击“分享”，即可发布第一个可安装 Workflow。</p>
          </div>
        )
      ) : status === "loading" ? (
        <RegistryLoading label="正在读取 Skill / 插件商城" />
      ) : status === "error" ? (
        <div className="registry-banner is-error">
          <CircleAlert size={16} />
          <span>{error}</span>
          <button type="button" onClick={() => void onRefresh()}>
            重试
          </button>
        </div>
      ) : source === "installed" && myPackageItems.length ? (
        <div className="workflow-market-grid">
          {myPackageItems.map((item) => (
            <article className={`workflow-market-card package-market-card is-${packageInstallStatus(item).kind}`} key={item.id}>
              <header>
                <span>
                  {category === "skill" ? <Code2 size={19} /> : <PlugZap size={19} />}
                </span>
                <div>
                  <h3>{item.name}</h3>
                  <small>v{item.version} · {runtimeMeta[item.runtimeType].label}</small>
                </div>
                <b>{accessScopeLabel[item.accessScope ?? "personal"]}</b>
              </header>
              <p>{item.description || "未填写说明"}</p>
              <div className="workflow-card-tags">
                {category === "skill" ? (
                  getSkillTypeLabels(item, os.capabilities).map((label) => (
                    <span key={label}>{label}</span>
                  ))
                ) : (
                  <>
                    <span>{item.contributionCount} 项能力</span>
                    <span>{item.trustState ?? "unverified"}</span>
                  </>
                )}
              </div>
              <footer>
                <div className={`package-install-status is-${packageInstallStatus(item).kind}`}>
                  {packageInstallStatus(item).kind === "installing" ? (
                    <LoaderCircle size={13} className="spin" />
                  ) : packageInstallStatus(item).kind === "success" ? (
                    <Check size={13} />
                  ) : (
                    <CircleAlert size={13} />
                  )}
                  <strong>{packageInstallStatus(item).label}</strong>
                  <span>{packageInstallStatus(item).detail}</span>
                </div>
                {(item.canManage ||
                  (item.packageType === "skill" &&
                    item.availabilitySource === "added")) && (
                  <div className="package-manage-actions">
                    {item.canManage && (
                      <button
                        type="button"
                        className="secondary-button compact"
                        disabled={busyId === item.id}
                        onClick={() =>
                          item.packageType === "skill"
                            ? onEditSkill(item)
                            : onEditPackage(item)
                        }
                      >
                        <SquarePen size={14} />
                        {item.packageType === "skill"
                          ? "修改 Skill"
                          : "修改插件"}
                      </button>
                    )}
                    {item.canManage && item.packageType === "plugin" && (
                      <PluginCardQuickSettings
                        key={`${item.id}:${item.accessScope}:${mediaPluginTypes(item).join(",")}`}
                        item={item}
                        disabled={busyId === item.id}
                        onSave={(settings) =>
                          savePluginSettings(item, settings)
                        }
                      />
                    )}
                    {item.packageType === "skill" &&
                    item.availabilitySource === "added" ? (
                      <button
                        type="button"
                        className="danger-text-button"
                        disabled={busyId === item.id}
                        onClick={() => void removeAvailableSkill(item)}
                      >
                        <Trash2 size={14} />
                        移除
                      </button>
                    ) : item.canManage ? (
                      <button
                        type="button"
                        className="danger-text-button"
                        disabled={busyId === item.id}
                        onClick={async () => {
                          if (!(await dialog.confirm(
                            `删除“${item.name}”后，画布中的对应选项也会同步移除。`,
                            {
                              title: "删除扩展能力",
                              confirmText: "确认删除",
                              tone: "danger",
                            },
                          ))) return;
                          setBusyId(item.id);
                          try {
                            await os.uninstallPackage(item.id);
                            await onRefresh();
                            onNotice(`${item.name} 已删除。`);
                          } catch (reason) {
                            onNotice(
                              reason instanceof Error
                                ? reason.message
                                : "删除失败",
                              "error",
                            );
                          } finally {
                            setBusyId("");
                          }
                        }}
                      >
                        <Trash2 size={14} />
                        删除
                      </button>
                    ) : null}
                  </div>
                )}
              </footer>
            </article>
          ))}
        </div>
      ) : source === "private" && privatePackageItems.length ? (
        <div className="workflow-market-grid">
          {privatePackageItems.map((item) => (
            <article className="workflow-market-card package-market-card" key={item.id}>
              <header>
                <span>
                  {category === "skill" ? <Code2 size={19} /> : <PlugZap size={19} />}
                </span>
                <div>
                  <h3>{item.name}</h3>
                  <small>v{item.version} · {runtimeMeta[item.runtimeType].label}</small>
                </div>
                <b>私有</b>
              </header>
              <p>{item.description || "未填写说明"}</p>
              <div className="workflow-card-tags">
                {category === "skill" ? (
                  getSkillTypeLabels(item, os.capabilities).map((label) => (
                    <span key={label}>{label}</span>
                  ))
                ) : (
                  <>
                    <span>{item.contributionCount} 项能力</span>
                    <span>仅自己可见</span>
                  </>
                )}
              </div>
              {item.canManage && item.packageType === "plugin" && (
                <footer>
                  <div className="package-manage-actions">
                    <button
                      type="button"
                      className="secondary-button compact"
                      disabled={busyId === item.id}
                      onClick={() => onEditPackage(item)}
                    >
                      <SquarePen size={14} />
                      修改
                    </button>
                    <PluginCardQuickSettings
                      key={`${item.id}:${item.accessScope}:${mediaPluginTypes(item).join(",")}`}
                      item={item}
                      disabled={busyId === item.id}
                      onSave={(settings) =>
                        savePluginSettings(item, settings)
                      }
                    />
                  </div>
                </footer>
              )}
            </article>
          ))}
        </div>
      ) : source === "shared" &&
        (ownedSharedPackageItems.length || otherSharedPackageItems.length) ? (
        <div className="workflow-market-grid">
          {ownedSharedPackageItems.map((item) => (
            <article
              className="workflow-market-card package-market-card"
              key={item.id}
            >
              <header>
                <span>
                  {category === "skill" ? (
                    <Code2 size={19} />
                  ) : (
                    <PlugZap size={19} />
                  )}
                </span>
                <div>
                  <h3>{item.name}</h3>
                  <small>
                    v{item.version} · {runtimeMeta[item.runtimeType].label}
                  </small>
                </div>
                <b>我的共享</b>
              </header>
              <p>{item.description || "未填写说明"}</p>
              <div className="workflow-card-tags">
                {category === "skill" ? (
                  getSkillTypeLabels(item, os.capabilities).map((label) => (
                    <span key={label}>{label}</span>
                  ))
                ) : (
                  <>
                    <span>{item.contributionCount} 项能力</span>
                    <span>
                      {item.enabled
                        ? "已发布"
                        : item.trustState === "quarantined"
                          ? "已隔离"
                          : "等待安全审核"}
                    </span>
                  </>
                )}
              </div>
              {item.canManage && (
                <footer>
                  <div className="package-manage-actions">
                    <button
                      type="button"
                      className="secondary-button compact"
                      disabled={busyId === item.id}
                      onClick={() =>
                        item.packageType === "plugin"
                          ? onEditPackage(item)
                          : onEditSkill(item)
                      }
                    >
                      {busyId === item.id ? (
                        <LoaderCircle size={14} className="spin" />
                      ) : (
                        <SquarePen size={14} />
                      )}
                      修改
                    </button>
                    {item.packageType === "plugin" && (
                      <PluginCardQuickSettings
                        key={`${item.id}:${item.accessScope}:${mediaPluginTypes(item).join(",")}`}
                        item={item}
                        disabled={busyId === item.id}
                        onSave={(settings) =>
                          savePluginSettings(item, settings)
                        }
                      />
                    )}
                    {item.packageType === "skill" && (
                      <button
                        type="button"
                        className="danger-text-button"
                        disabled={busyId === item.id}
                        onClick={() => void deleteSharedSkill(item)}
                      >
                        <Trash2 size={14} />
                        删除
                      </button>
                    )}
                  </div>
                </footer>
              )}
            </article>
          ))}
          {otherSharedPackageItems.map((item) => (
            <article className="workflow-market-card package-market-card" key={item.id}>
              <header>
                <span>
                  {category === "skill" ? <Code2 size={19} /> : <PlugZap size={19} />}
                </span>
                <div>
                  <h3>{item.name}</h3>
                  <small>
                    @{item.publisher.username} · v{item.version} ·{" "}
                    {runtimeMeta[item.runtimeType].label}
                  </small>
                </div>
                <b>
                  {item.publisher.platformRole === "system_admin"
                    ? "管理员共享"
                    : "用户共享"}
                </b>
              </header>
              <p>{item.description || "未填写说明"}</p>
              <div className="workflow-card-tags">
                {category === "skill" ? (
                  getSkillTypeLabels(item, os.capabilities).map((label) => (
                    <span key={label}>{label}</span>
                  ))
                ) : item.permissions.length ? (
                  item.permissions.slice(0, 4).map((permission) => (
                    <span key={permission}>{permission}</span>
                  ))
                ) : (
                  <span>零权限</span>
                )}
              </div>
              <footer>
                <button
                  type="button"
                  className="primary-button compact"
                  disabled={item.installed || busyId === item.id}
                  onClick={() => void addMarketplacePackage(item)}
                >
                  {busyId === item.id ? (
                    <LoaderCircle size={14} className="spin" />
                  ) : (
                    item.packageType === "skill" ? (
                      <PackagePlus size={14} />
                    ) : (
                      <Download size={14} />
                    )
                  )}
                  {item.installed
                    ? item.packageType === "skill"
                      ? "已添加"
                      : "已安装"
                    : item.packageType === "skill"
                      ? "添加到可用 Skill"
                      : "安装"}
                </button>
                {isSystemAdmin && item.packageType === "skill" && (
                  <button
                    type="button"
                    className="danger-text-button"
                    disabled={busyId === item.id}
                    onClick={() => void deleteSharedSkill(item)}
                  >
                    <Trash2 size={14} />
                    删除
                  </button>
                )}
              </footer>
            </article>
          ))}
        </div>
      ) : source === "market" && category === "skill" ? (
        marketStatus === "loading" ? (
          <RegistryLoading label="正在读取技能市场" />
        ) : marketStatus === "error" ? (
          <div className="registry-banner is-error">
            <CircleAlert size={16} />
            <span>{marketError}</span>
            <button type="button" onClick={() => void loadSkillMarket()}>
              重试
            </button>
          </div>
        ) : skillMarketListings.length ? (
          <div className="workflow-market-grid">
            {skillMarketListings.map((item) => {
              const key = item.publisherId + "/" + item.name;
              const mine = item.publisherId === userId;
              return (
                <article className="workflow-market-card package-market-card" key={key}>
                  <header>
                    <span>
                      <Code2 size={19} />
                    </span>
                    <div>
                      <h3>{item.name}</h3>
                      <small>
                        @{item.publisherName || "匿名"} · {item.publishedAt.slice(0, 10)}
                      </small>
                    </div>
                    <b>{mine ? "我发布的" : item.localCopy ? "已安装" : "技能市场"}</b>
                  </header>
                  <p>{item.description || "未填写说明"}</p>
                  <div className="workflow-card-tags">
                    <span>SKILL.md</span>
                    {item.localCopy ? <span>本地已有</span> : null}
                  </div>
                  <footer>
                    <button
                      type="button"
                      className="primary-button compact"
                      disabled={item.localCopy || busyId === key}
                      onClick={() => void marketAct(item, "install")}
                    >
                      {busyId === key ? (
                        <LoaderCircle size={14} className="spin" />
                      ) : (
                        <PackagePlus size={14} />
                      )}
                      {item.localCopy ? "已安装" : "安装到小逻工作区"}
                    </button>
                    {mine ? (
                      <button
                        type="button"
                        className="danger-text-button"
                        disabled={busyId === key}
                        onClick={() => void marketAct(item, "unpublish")}
                      >
                        <Trash2 size={14} />
                        下架
                      </button>
                    ) : null}
                  </footer>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="extension-empty">
            <span>
              <Code2 size={24} />
            </span>
            <h3>技能市场还是空的</h3>
            <p>在小逻面板展开技能市场，把自己的技能发布出去，就会出现在这里，别的小逻可以一键安装。</p>
          </div>
        )
      ) : (
        <div className="extension-empty">
          <span>{category === "skill" ? <Code2 size={24} /> : <PlugZap size={24} />}</span>
          <h3>
            {source === "installed"
              ? `当前账号还没有可用${category === "skill" ? " Skill" : "插件"}`
              : source === "private"
                ? `还没有私有${category === "skill" ? " Skill" : "插件"}`
                : `暂时没有共享${category === "skill" ? " Skill" : "插件"}`}
          </h3>
          <p>
            {source === "installed"
              ? "通过“创建 Skill”或“导入 Package”接入后，会同步到这里和画布。"
              : source === "private"
                ? `创建或安装${category === "skill" ? " Skill" : "插件"}时选择“私有”，它只会对你本人显示。`
                : `系统管理员发布的${category === "skill" ? " Skill" : "插件"}，以及用户主动设为共享的${category === "skill" ? " Skill" : "插件"}，都会显示在这里供所有用户添加。`}
          </p>
        </div>
      )}
    </div>
  );
}

function PackagesPanel({
  os,
  dialog,
  onImport,
  onEdit,
  onEditSkill,
  onNotice,
  onSandbox,
}: {
  os: IntentOSController;
  dialog: ReturnType<typeof useAppDialog>;
  onImport: () => void;
  onEdit: (item: InstalledPackage) => void;
  onEditSkill: (item: InstalledPackage) => void;
  onNotice: (
    text: string,
    tone?: "success" | "error" | "info",
  ) => void;
  onSandbox: (item: InstalledPackage) => void;
}) {
  const [busyId, setBusyId] = useState("");

  async function act(id: string, task: () => Promise<void>) {
    setBusyId(id);
    try {
      await task();
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "操作失败", "error");
    } finally {
      setBusyId("");
    }
  }

  if (os.registryStatus === "loading" && !os.packages.length) {
    return <RegistryLoading label="正在同步 Package Registry" />;
  }

  return (
    <div className="extension-panel-grid">
      <div className="registry-column">
        <div className="section-title-row">
          <div>
            <h2>已安装 Package</h2>
            <p>安装、更新、停用与卸载都会写入审计事件。</p>
          </div>
          <span className="registry-version">Package Contract v2.0</span>
        </div>

        {!os.packages.length ? (
          <div className="extension-empty">
            <span><PackagePlus size={24} /></span>
            <h3>注册表还是空的</h3>
            <p>
              系统不会预装开发文档中的具体 Skill；只有你创建或导入后，能力才会进入节点。
            </p>
            <button type="button" className="primary-button" onClick={onImport}>
              <Upload size={15} /> 导入第一个 Package
            </button>
          </div>
        ) : (
          <div className="package-list">
            {os.packages.map((item) => {
              const RuntimeIcon = runtimeMeta[item.runtimeType].icon;
              const busy = busyId === item.id;
              return (
                <article
                  className={`package-card ${item.enabled ? "" : "is-disabled"}`}
                  key={item.id}
                >
                  <div className="package-card-main">
                    <span className={`runtime-icon runtime-${item.runtimeType}`}>
                      <RuntimeIcon size={18} />
                    </span>
                    <div className="package-identity">
                      <div>
                        <h3>{item.name}</h3>
                        <span className="version-chip">v{item.version}</span>
                      </div>
                      <p>{item.description || "未填写说明"}</p>
                      <code>{item.id}</code>
                    </div>
                    <div className="package-badges">
                      <span>{packageTypeLabel[item.packageType]}</span>
                      <span>{runtimeMeta[item.runtimeType].label}</span>
                      <span>{item.contributionCount} 项贡献</span>
                      <span>信任：{item.trustState ?? "unverified"}</span>
                      <span>
                        权限：{accessScopeLabel[item.accessScope ?? "personal"]}
                      </span>
                    </div>
                  </div>

                  <div className="permission-row">
                    <ShieldCheck size={13} />
                    {item.permissions.length ? (
                      item.permissions.map((permission) => (
                        <span key={permission}>{permission}</span>
                      ))
                    ) : (
                      <span>零权限</span>
                    )}
                  </div>

                  <div className="package-actions">
                    <button
                      type="button"
                      className={`switch-button ${item.enabled ? "is-on" : ""}`}
                      aria-pressed={item.enabled}
                      disabled={busy || !item.canManage}
                      onClick={() =>
                        void act(item.id, async () => {
                          await os.setPackageEnabled(item.id, !item.enabled);
                          onNotice(`${item.name} 已${item.enabled ? "停用" : "启用"}。`);
                        })
                      }
                    >
                      <i />
                      {item.enabled ? "已启用" : "已停用"}
                    </button>
                    <button
                      type="button"
                      className="secondary-button compact"
                      disabled={busy || !item.enabled || !item.canManage}
                      onClick={() =>
                        void act(item.id, async () => {
                          const result = await os.testPlugin(item.id);
                          onNotice(result.message, result.ok ? "success" : "error");
                          if (result.previewUrl) onSandbox(item);
                        })
                      }
                    >
                      {busy ? (
                        <LoaderCircle size={14} className="spin" />
                      ) : (
                        <Play size={14} />
                      )}
                      {item.runtimeType === "sandbox-ui" ? "打开沙盒" : "运行检测"}
                    </button>
                    {item.packageType === "plugin" && (
                      <button
                        type="button"
                        className="secondary-button compact"
                        disabled={busy || !item.canManage || !item.manifest}
                        onClick={() => onEdit(item)}
                      >
                        <SquarePen size={14} /> 修改
                      </button>
                    )}
                    {item.packageType === "skill" && (
                      <button
                        type="button"
                        className="secondary-button compact"
                        disabled={busy || !item.canManage}
                        onClick={() => onEditSkill(item)}
                      >
                        <SquarePen size={14} /> 修改 Skill
                      </button>
                    )}
                    <button
                      type="button"
                      className="danger-text-button"
                      disabled={busy || !item.canManage}
                      onClick={async () => {
                        if (!(await dialog.confirm(
                          `卸载“${item.name}”后，对应的画布节点选项也会同步移除。`,
                          {
                            title: "卸载扩展能力",
                            confirmText: "确认卸载",
                            tone: "danger",
                          },
                        ))) return;
                        void act(item.id, async () => {
                          await os.uninstallPackage(item.id);
                          onNotice(`${item.name} 已卸载。`);
                        });
                      }}
                    >
                      <Trash2 size={14} /> 卸载
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>

      <aside className="runtime-column">
        <div className="section-title-row">
          <div>
            <h2>运行时边界</h2>
            <p>按插件类型选择最小权限环境。</p>
          </div>
        </div>
        <RuntimeCard
          icon={Braces}
          title="声明式"
          detail="Schema、Prompt 与工作流定义，不执行任意代码。"
          status="默认安全"
        />
        <RuntimeCard
          icon={PanelsTopLeft}
          title="UI 沙盒"
          detail="iframe 无同源权限，通过消息桥申请受控能力。"
          status="浏览器隔离"
        />
        <RuntimeCard
          icon={Server}
          title="远程 API"
          detail="仅访问 Manifest 精确声明的 HTTPS Origin。"
          status="网络白名单"
        />
        <RuntimeCard
          icon={Cpu}
          title="隔离 Worker"
          detail="可信签名 Package 才能进入外部 Node / Python / CLI 隔离集群。"
          status="资源硬限制"
        />
        <div className="audit-card">
          <div className="audit-heading">
            <span><Activity size={15} /> 最近事件</span>
            <button type="button" onClick={() => void os.refreshRegistry()}>
              <RefreshCw size={13} />
            </button>
          </div>
          {!os.registryEvents.length ? (
            <p className="audit-empty">安装或测试后，这里会出现审计记录。</p>
          ) : (
            os.registryEvents.slice(0, 6).map((event) => (
              <div className="audit-event" key={event.id}>
                <i />
                <span>
                  <b>{event.eventType}</b>
                  <small>{event.entityId}</small>
                </span>
                <time>{formatTime(event.createdAt)}</time>
              </div>
            ))
          )}
        </div>
      </aside>
    </div>
  );
}

function RuntimeCard({
  icon: Icon,
  title,
  detail,
  status,
}: {
  icon: typeof Braces;
  title: string;
  detail: string;
  status: string;
}) {
  return (
    <article className="runtime-card">
      <span><Icon size={17} /></span>
      <div><h3>{title}</h3><p>{detail}</p></div>
      <small>{status}</small>
    </article>
  );
}

function RegistryLoading({ label }: { label: string }) {
  return (
    <div className="registry-loading">
      <LoaderCircle size={20} className="spin" />
      <span>{label}</span>
    </div>
  );
}

type PackageInstallRequest =
  | {
      kind: "manifest";
      raw: string;
      accessScope: "personal" | "marketplace";
    }
  | {
      kind: "archive";
      file: File;
      accessScope: "personal" | "marketplace";
    }
  | {
      kind: "github";
      url: string;
      ref?: string;
      accessScope: "personal" | "marketplace";
    };

function PackageDialog({
  initial,
  packages,
  onClose,
  onInstall,
}: {
  initial?: InstalledPackage;
  packages: InstalledPackage[];
  onClose: () => void;
  onInstall: (
    input: PackageInstallRequest,
  ) => Promise<GithubPackageImportResult>;
}) {
  const [mode, setMode] = useState<"archive" | "github" | "manifest">(
    initial ? "manifest" : "archive",
  );
  const [raw, setRaw] = useState(() => {
    if (!initial?.manifest) return "";
    return JSON.stringify(
      {
        ...initial.manifest,
        version: incrementPatchVersion(initial.version),
      },
      null,
      2,
    );
  });
  const [assetTypes, setAssetTypes] = useState<MediaPluginType[]>(() =>
    normalizeMediaPluginTypes(initial?.manifest?.assetTypes),
  );
  const [accessScope, setAccessScope] = useState<
    "personal" | "marketplace"
  >(
    initial?.accessScope === "marketplace"
      ? "marketplace"
      : "personal",
  );
  const [archiveFile, setArchiveFile] = useState<File | null>(null);
  const [githubUrl, setGithubUrl] = useState("");
  const [githubRef, setGithubRef] = useState("");
  const [compatibility, setCompatibility] =
    useState<GithubCompatibilityReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [installPhase, setInstallPhase] = useState<
    "idle" | "analyzing" | "downloading" | "verifying" | "building" | "complete" | "build_pending" | "failed"
  >("idle");
  const [installMessage, setInstallMessage] = useState("");
  function replaceManifestRaw(nextRaw: string) {
    setRaw(nextRaw);
    try {
      const parsed = JSON.parse(nextRaw) as Record<string, unknown>;
      setAssetTypes(normalizeMediaPluginTypes(parsed.assetTypes));
    } catch {
      // Keep the last valid type selection while the user is editing JSON.
    }
  }

  function toggleAssetType(type: MediaPluginType) {
    setAssetTypes((current) => {
      const next = current.includes(type)
        ? current.filter((item) => item !== type)
        : MEDIA_PLUGIN_TYPES.filter(
            (item) => item === type || current.includes(item),
          );
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (parsed.type === "plugin") {
          parsed.assetTypes = next;
          setRaw(JSON.stringify(parsed, null, 2));
        }
      } catch {
        // The selected values are still kept in state and are applied on submit.
      }
      return next;
    });
  }

  async function submit() {
    setBusy(true);
    setError("");
    setCompatibility(null);
    setInstallMessage("");
    setInstallPhase("analyzing");
    const progressTimers = [
      window.setTimeout(() => setInstallPhase("downloading"), 450),
      window.setTimeout(() => setInstallPhase("verifying"), 1100),
      window.setTimeout(() => setInstallPhase("building"), 1900),
    ];
    try {
      let result: GithubPackageImportResult;
      if (mode === "archive") {
        if (!archiveFile) throw new Error("请先选择 .xlpkg 或 .zip 插件包");
        result = await onInstall({
          kind: "archive",
          file: archiveFile,
          accessScope,
        });
      } else if (mode === "github") {
        if (!githubUrl.trim()) throw new Error("请输入 GitHub 仓库地址");
        result = await onInstall({
          kind: "github",
          url: githubUrl.trim(),
          accessScope,
          ...(githubRef.trim() ? { ref: githubRef.trim() } : {}),
        });
      } else {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        parsed.access = { scope: accessScope };
        if (parsed.type === "plugin") {
          parsed.assetTypes = assetTypes;
        } else {
          delete parsed.assetTypes;
        }
        result = await onInstall({
          kind: "manifest",
          raw: JSON.stringify(parsed, null, 2),
          accessScope,
        });
      }
      if (result.status === "needs_adaptation") {
        setCompatibility(result.compatibility);
        setInstallPhase("failed");
        setInstallMessage("仓库需要完成插件适配后才能安装");
      } else if (result.source?.executionReady === false) {
        setCompatibility(result.source.compatibility ?? null);
        setInstallPhase("build_pending");
        setInstallMessage(
          `${result.source.compatibility?.projectTypeLabel ?? "源码项目"}已导入；源码和元数据已保存，配置隔离运行环境后即可启用`,
        );
      } else {
        setCompatibility(result.source?.compatibility ?? null);
        setInstallPhase("complete");
        setInstallMessage(
          `${result.package.name} 已安装完成${result.source?.compatibility?.projectTypeLabel ? `（已识别为${result.source.compatibility.projectTypeLabel}）` : ""}，可以添加到画布`,
        );
      }
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "安装失败";
      setError(message);
      setInstallPhase("failed");
      setInstallMessage(message);
    } finally {
      progressTimers.forEach(window.clearTimeout);
      setBusy(false);
    }
  }

  async function chooseManifestFile(file: File) {
    if (/\.(xlpkg|zip)$/i.test(file.name)) {
      const header = new Uint8Array(await file.slice(0, 4).arrayBuffer());
      if (
        header[0] === 0x50 &&
        header[1] === 0x4b &&
        [0x03, 0x05, 0x07].includes(header[2])
      ) {
        setArchiveFile(file);
        setMode("archive");
        setError("");
        return;
      }
    }
    const content = await file.text();
    if (/\.md$/i.test(file.name)) {
      const manifest = skillManifestFromMarkdown(content, file.name);
      const installed = packages.find(
        (item) => item.packageKey === manifest.id,
      );
      if (installed) {
        manifest.version = incrementPatchVersion(installed.version);
      }
      manifest.access = {
        scope: accessScope,
      };
      replaceManifestRaw(JSON.stringify(manifest, null, 2));
    } else {
      replaceManifestRaw(content);
    }
    setMode("manifest");
    setError("");
  }

  const canSubmit =
    mode === "archive"
      ? Boolean(archiveFile)
      : mode === "github"
        ? Boolean(githubUrl.trim())
        : Boolean(raw.trim());

  const manifestIsPlugin = useMemo(() => {
    if (mode !== "manifest") return false;
    try {
      const parsed = JSON.parse(raw) as { type?: unknown };
      return parsed.type === "plugin";
    } catch {
      return initial?.packageType === "plugin";
    }
  }, [initial?.packageType, mode, raw]);

  return (
    <div className="extension-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="extension-modal package-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="package-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        {installPhase !== "idle" && (
          <div className="package-progress-backdrop" role="status" aria-live="polite">
            <section className={`package-progress-dialog is-${installPhase}`}>
              <div className="package-progress-icon">
                {installPhase === "complete" ? <Check size={26} /> :
                  installPhase === "failed" || installPhase === "build_pending" ? <CircleAlert size={26} /> :
                    <LoaderCircle size={26} className="spin" />}
              </div>
              <span className="eyebrow">PACKAGE INSTALLER</span>
              <h3>{
                installPhase === "analyzing" ? "正在分析插件" :
                  installPhase === "downloading" ? "正在下载插件" :
                    installPhase === "verifying" ? "正在安全校验" :
                      installPhase === "building" ? "正在构建运行环境" :
                        installPhase === "complete" ? "安装完成" :
                          installPhase === "build_pending" ? "源码已导入" : "安装失败"
              }</h3>
              <div className="package-progress-steps">
                {[
                  ["analyzing", "分析仓库"], ["downloading", "下载文件"],
                  ["verifying", "安全校验"], ["building", "构建环境"],
                  ["complete", "安装完成"],
                ].map(([phase, label], index) => {
                  const order = ["analyzing", "downloading", "verifying", "building", "complete"];
                  const current = installPhase === "build_pending" ? 3 : order.indexOf(installPhase);
                  const done = installPhase === "complete" || index < current;
                  const active = index === current && installPhase !== "failed";
                  return (
                    <div className={`${done ? "is-done" : ""} ${active ? "is-active" : ""}`} key={phase}>
                      <i>{done ? <Check size={12} /> : index + 1}</i><span>{label}</span>
                    </div>
                  );
                })}
              </div>
              <p>{installMessage || "请保持当前窗口打开，安装完成后即可使用插件。"}</p>
              {!busy && (
                <button
                  type="button"
                  className={installPhase === "failed" ? "secondary-button" : "primary-button"}
                  onClick={() => {
                    if (installPhase === "complete" || installPhase === "build_pending") onClose();
                    else setInstallPhase("idle");
                  }}
                >
                  {installPhase === "complete" || installPhase === "build_pending" ? "完成" : "返回修改"}
                </button>
              )}
            </section>
          </div>
        )}
        <div className="modal-heading">
          <div>
            <span className="eyebrow">PACKAGE INSTALLER</span>
            <h2 id="package-dialog-title">
              {initial ? `修改 ${initial.name}` : "导入 XiaoLuo Package"}
            </h2>
            <p>
              支持标准 Package，也支持直接导入普通开源 ZIP、GitHub 仓库与 Release。
            </p>
          </div>
          <button type="button" aria-label="关闭" onClick={onClose}><X size={18} /></button>
        </div>
        {!initial && (
          <div className="package-install-tabs" role="tablist" aria-label="安装来源">
            <button
              type="button"
              role="tab"
              aria-selected={mode === "archive"}
              className={mode === "archive" ? "is-active" : ""}
              onClick={() => {
                setMode("archive");
                setError("");
                setCompatibility(null);
              }}
            >
              <FileArchive size={18} />
              <span>
                <b>压缩包</b>
                <small>上传 .xlpkg 或 .zip</small>
              </span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "github"}
              className={mode === "github" ? "is-active" : ""}
              onClick={() => {
                setMode("github");
                setError("");
                setCompatibility(null);
              }}
            >
              <Github size={18} />
              <span>
                <b>GitHub 仓库</b>
                <small>从仓库或 Release 导入</small>
              </span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "manifest"}
              className={mode === "manifest" ? "is-active" : ""}
              onClick={() => {
                setMode("manifest");
                setError("");
                setCompatibility(null);
              }}
            >
              <FileJson size={18} />
              <span>
                <b>Manifest / Skill</b>
                <small>导入 .json 或 .md</small>
              </span>
            </button>
          </div>
        )}

        <div className="package-install-body">
        <section className="package-access-picker">
          <label className="package-access-select">
            <span>可见范围</span>
            <select
              value={accessScope}
              onChange={(event) =>
                setAccessScope(
                  event.target.value as "personal" | "marketplace",
                )
              }
            >
              <option value="personal">私有（仅自己可见和使用）</option>
              <option value="marketplace">
                共享（审核通过后供所有用户添加）
              </option>
            </select>
          </label>
          {manifestIsPlugin && (
            <div className="package-asset-types">
              <span>适用类型</span>
              <div className="package-asset-type-options" aria-label="插件适用类型">
                {(
                  [
                    ["image", "图片"],
                    ["video", "视频"],
                    ["audio", "音频"],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    role="checkbox"
                    aria-checked={assetTypes.includes(value)}
                    className={assetTypes.includes(value) ? "is-active" : ""}
                    onClick={() => toggleAssetType(value)}
                  >
                    <span aria-hidden="true">
                      {assetTypes.includes(value) ? <Check size={13} /> : null}
                    </span>
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </section>
        {mode === "archive" && (
          <div className="package-source-panel package-archive-panel">
            <div className="package-source-heading">
              <span>本地文件</span>
              <div>
                <h3>上传插件压缩包</h3>
                <p>有无 XiaoLuo Manifest 均可；系统会识别项目类型并自动生成内部清单。</p>
              </div>
            </div>
            <label className="package-file-button is-large">
              <Upload size={20} />
              <span>
                <b>{archiveFile ? archiveFile.name : "选择插件压缩包"}</b>
                <small>
                  {archiveFile
                    ? `${(archiveFile.size / 1024 / 1024).toFixed(2)} MB · 等待安全校验`
                    : ".xlpkg 或 .zip，最大 50 MB"}
                </small>
              </span>
              <input
                type="file"
                accept=".xlpkg,.zip,application/zip,application/x-zip-compressed"
                onChange={(event) => {
                  const file = event.target.files?.[0] ?? null;
                  setArchiveFile(file);
                  setError("");
                  setCompatibility(null);
                }}
              />
            </label>
            <div className="package-format-guide">
              <b>通用源码安装</b>
              <code>Manifest 可选</code>
              <span>Skill、静态站点和 Vite 前端会自动适配；后端与 CLI 源码先安全导入，再进入隔离运行配置。</span>
            </div>
          </div>
        )}

        {mode === "github" && (
          <div className="package-source-panel">
            <label className="package-source-field">
              <span>GitHub 仓库地址</span>
              <input
                value={githubUrl}
                onChange={(event) => setGithubUrl(event.target.value)}
                placeholder="https://github.com/owner/repository"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <label className="package-source-field">
              <span>分支、标签或 Commit（可选）</span>
              <input
                value={githubRef}
                onChange={(event) => setGithubRef(event.target.value)}
                placeholder="留空使用最新 .xlpkg Release 或默认分支"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <p className="package-source-help">
              安装器优先读取 Release 中的 .xlpkg；否则锁定仓库 Commit 并查找
              xiaoluo.plugin.json。没有清单时会自动识别并生成适配包装；需要构建的项目
              会进入隔离构建准备状态，不会放进主服务进程执行。
            </p>
          </div>
        )}

        {mode === "manifest" && (
          <div className="package-source-panel package-manifest-upload">
            <div className="package-drop-row">
              <label className="package-file-button">
                <Upload size={17} />
                <span>
                  <b>选择 Manifest 或 Skill 文件</b>
                  <small>.md、.json，也兼容旧版 JSON .xlpkg</small>
                </span>
                <input
                  type="file"
                  accept=".md,.xlpkg,.json,.zip,text/markdown,text/plain,application/json,application/zip"
                  onChange={async (event) => {
                    const file = event.target.files?.[0];
                    if (!file) return;
                    try {
                      await chooseManifestFile(file);
                    } catch (reason) {
                      setError(
                        reason instanceof Error
                          ? reason.message
                          : "文件解析失败",
                      );
                    }
                  }}
                />
              </label>
              <button
                type="button"
                className="secondary-button"
                onClick={() => replaceManifestRaw(starterManifest)}
              >
                填入插件清单模板
              </button>
            </div>
          </div>
        )}

        {mode === "manifest" && (
          <label className="manifest-editor-label">
            <span>{initial ? "Package Manifest（已自动提升补丁版本）" : "Package Manifest"}</span>
            <textarea
              className="manifest-editor"
              value={raw}
              onChange={(event) => replaceManifestRaw(event.target.value)}
              placeholder="将 manifest JSON 粘贴到这里…"
              spellCheck={false}
            />
          </label>
        )}

        {compatibility && (
          <div className="package-compatibility-report" role="status">
            <header>
              <CircleAlert size={17} />
              <div>
                <b>源码识别结果：{compatibility.projectTypeLabel}</b>
                <small>
                  {compatibility.repository} · {compatibility.commit.slice(0, 12)}
                </small>
              </div>
            </header>
            <div className="package-detection-tags">
              {(compatibility.detectedStack.length
                ? compatibility.detectedStack
                : ["未识别前端框架"]
              ).map((item) => <span key={item}>{item}</span>)}
            </div>
            <ul>
              {compatibility.issues.map((item) => <li key={item}>{item}</li>)}
            </ul>
            <p>
              <code>xiaoluo.plugin.json</code> 是可选增强文件；静态前端与 Skill
              可自动启用，其他运行时会在隔离环境配置完成后启用。
            </p>
          </div>
        )}
        {error && <div className="modal-error"><CircleAlert size={14} /> {error}</div>}
        </div>
        <div className="package-modal-footer">
          <div className="security-note">
            <ShieldCheck size={17} />
            <p>
              自动检查压缩包、敏感文件、Manifest 与权限；GitHub 来源固定到具体 Commit。
            </p>
          </div>
          <div className="modal-actions">
            <button type="button" className="secondary-button" onClick={onClose}>
              取消
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={!canSubmit || busy}
              onClick={() => void submit()}
            >
              {busy ? <LoaderCircle size={15} className="spin" /> : <PackagePlus size={15} />}
              {initial
                ? "校验并更新"
                : mode === "github"
                  ? "分析并安装"
                  : "校验并安装"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function skillPorts(modality: NodeKind) {
  const output = {
    id: modality,
    label:
      modality === "text"
        ? "文本"
        : modality === "image"
          ? "图片"
          : modality === "video"
            ? "视频"
            : modality === "audio"
              ? "音频"
              : "文档",
    direction: "output",
    dataTypes: [modality],
  };
  if (modality === "text") {
    return [
      {
        id: "context",
        label: "上下文",
        direction: "input",
        dataTypes: ["text", "document", "json"],
      },
      output,
    ];
  }
  return [
    {
      id: "prompt",
      label: "提示词",
      direction: "input",
      dataTypes: ["text", "document", "json"],
    },
    ...(modality === "image" || modality === "video"
      ? [
          {
            id: "reference",
            label: "参考素材",
            direction: "input",
            dataTypes:
              modality === "image" ? ["image"] : ["image", "video"],
          },
        ]
      : []),
    output,
  ];
}

function incrementPatchVersion(version: string) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!match) return "1.0.1";
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

function SkillBuilderDialog({
  initial,
  packages,
  onClose,
  onInstall,
}: {
  initial?: Capability;
  packages: InstalledPackage[];
  onClose: () => void;
  onInstall: (raw: string) => Promise<void>;
}) {
  const initialOwner = initial?.packageId
    ? packages.find((item) => item.id === initial.packageId)
    : undefined;
  const [name, setName] = useState(initial?.title ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [modality, setModality] = useState<NodeKind>(
    initial?.modality ?? "text",
  );
  const [instructions, setInstructions] = useState(
    initial?.instructions ?? "",
  );
  const [accessScope, setAccessScope] = useState<
    "personal" | "marketplace"
  >(
    initialOwner?.accessScope === "marketplace"
      ? "marketplace"
      : "personal",
  );
  const [inputSchema, setInputSchema] = useState<Record<string, unknown>>(
    initial?.inputSchema ?? {
      type: "object",
      properties: {},
    },
  );
  const [uiSchema, setUiSchema] = useState<Record<string, unknown>>(
    initial?.uiSchema ?? {},
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    const title = name.trim();
    if (!title) {
      setError("请输入 Skill 名称");
      return;
    }
    const suffix =
      title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 24) || "custom";
    const owner = initial?.packageId
      ? packages.find((item) => item.id === initial.packageId)
      : undefined;
    const packageId =
      owner?.packageKey ??
      `user.skill.${suffix}-${Date.now().toString(36)}`;
    const nextVersion = initial
      ? incrementPatchVersion(initial.packageVersion)
      : "1.0.0";
    const manifest = {
      schemaVersion: "2.0",
      id: packageId,
      name: title,
      version: nextVersion,
      description: description.trim(),
      type: "skill",
      access: { scope: accessScope },
      runtime: { type: "declarative" },
      permissions: ["models:list", "models:invoke"],
      contributes: {
        skills: [
          {
            id: initial?.capabilityKey ?? `${packageId}.main`,
            title,
            description: description.trim(),
            modality,
            executionMode: "model",
            ports: skillPorts(modality),
            inputSchema: {
              ...inputSchema,
              ...(instructions.trim()
                ? { "x-xiaoluo-instructions": instructions.trim() }
                : {}),
            },
            outputSchema: {
              type: "object",
              properties:
                modality === "text"
                  ? { text: { type: "string", title: "文本结果" } }
                  : {
                      assetUrl: {
                        type: "string",
                        format: modality,
                        title: `${title}结果`,
                      },
                    },
            },
            uiSchema,
            modelRequirements: {
              required: true,
            },
          },
        ],
      },
    };
    setBusy(true);
    setError("");
    try {
      await onInstall(JSON.stringify(manifest));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "创建 Skill 失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="extension-modal-backdrop"
      role="presentation"
      onMouseDown={onClose}
    >
      <div
        className="extension-modal skill-builder-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="skill-builder-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-heading">
          <div>
            <span className="eyebrow">CUSTOM SKILL</span>
            <h2 id="skill-builder-title">
              {initial ? "编辑 Skill 选项" : "创建自己的 Skill"}
            </h2>
            <p>
              保存后，选项、端口和兼容模型会同步到画布节点，并保留历史版本快照。
            </p>
          </div>
          <button type="button" aria-label="关闭" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <div className="skill-builder-grid">
          <label>
            Skill 名称
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如：品牌主视觉生成"
            />
          </label>
          <label>
            节点类型
            <select
              value={modality}
              onChange={(event) =>
                setModality(event.target.value as NodeKind)
              }
            >
              <option value="text">文本</option>
              <option value="image">图片</option>
              <option value="video">视频</option>
              <option value="audio">音频</option>
              <option value="document">文档</option>
            </select>
          </label>
          <label className="skill-access-scope">
            使用权限
            <select
              value={accessScope}
              onChange={(event) =>
                setAccessScope(
                  event.target.value as "personal" | "marketplace",
                )
              }
            >
              <option value="personal">私有 Skill（仅自己可见）</option>
              <option value="marketplace">
                共享 Skill（所有用户可见并可添加）
              </option>
            </select>
          </label>
          <label className="skill-builder-span">
            说明
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="说明这个 Skill 在节点中完成什么任务"
            />
          </label>
          <label className="skill-builder-span">
            执行规则 / Prompt
            <textarea
              className="skill-instructions-editor"
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              placeholder="写入 Skill 的完整执行规则；从 .md 安装时会自动使用 Markdown 正文。"
            />
          </label>
        </div>
        <SchemaOptionBuilder
          title="Skill 节点选项"
          schema={inputSchema}
          uiSchema={uiSchema}
          onChange={(schema, nextUiSchema) => {
            setInputSchema(schema);
            setUiSchema(nextUiSchema);
          }}
        />
        {error && (
          <div className="modal-error">
            <CircleAlert size={14} /> {error}
          </div>
        )}
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={busy}
            onClick={() => void submit()}
          >
            {busy ? (
              <LoaderCircle size={15} className="spin" />
            ) : (
              <Code2 size={15} />
            )}
            {initial ? "保存并同步" : "创建并同步"}
          </button>
        </div>
      </div>
    </div>
  );
}

function SandboxDialog({
  title,
  url,
  onClose,
}: {
  title: string;
  url: string;
  onClose: () => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [bridgeState, setBridgeState] = useState("等待插件握手");
  const [frameFailed, setFrameFailed] = useState(false);
  const [frameVersion, setFrameVersion] = useState(0);
  const bridgeToken = useRef(createRuntimeId());

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setBridgeState("插件未完成握手，已启用安全回退");
      setFrameFailed(true);
    }, 8_000);
    function receive(event: MessageEvent) {
      if (
        event.source !== frame.current?.contentWindow ||
        event.origin !== "null" ||
        !event.data ||
        typeof event.data !== "object"
      ) {
        return;
      }
      const message = event.data as {
        type?: string;
        requestId?: string;
        bridgeToken?: string;
      };
      if (message?.type === "xiaoluo:ready") {
        window.clearTimeout(timeout);
        setFrameFailed(false);
        setBridgeState("消息桥已连接");
        frame.current?.contentWindow?.postMessage(
          {
            type: "xiaoluo:host-ready",
            contractVersion: "2.0",
            grantedCapabilities: [],
            bridgeToken: bridgeToken.current,
          },
          "*",
        );
      }
      if (message?.type === "xiaoluo:request") {
        frame.current?.contentWindow?.postMessage(
          {
            type: "xiaoluo:response",
            requestId: message.requestId,
            ok: false,
            error:
              message.bridgeToken === bridgeToken.current
                ? "Capability 未授权"
                : "消息桥令牌无效",
          },
          "*",
        );
      }
    }
    window.addEventListener("message", receive);
    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener("message", receive);
    };
  }, [frameVersion]);

  return (
    <div className="extension-modal-backdrop sandbox-backdrop" role="presentation">
      <div className="sandbox-modal" role="dialog" aria-modal="true" aria-label={`${title} 沙盒`}>
        <header>
          <div>
            <span className="sandbox-dot" />
            <b>{title}</b>
            <small><ShieldCheck size={12} /> {bridgeState}</small>
          </div>
          <button type="button" aria-label="关闭沙盒" onClick={onClose}><X size={18} /></button>
        </header>
        <div className="sandbox-permission-strip">
          <span>allow-scripts</span>
          <span>无 allow-same-origin</span>
          <span>摄像头 / 麦克风 / 定位：禁止</span>
        </div>
        {frameFailed ? (
          <div className="sandbox-fallback" role="alert">
            <CircleAlert size={24} />
            <strong>插件界面未能安全加载</strong>
            <p>核心应用仍可继续使用。你可以重试加载，或返回通用 Schema 界面。</p>
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                setBridgeState("等待插件握手");
                setFrameFailed(false);
                setFrameVersion((current) => current + 1);
              }}
            >
              重新加载插件
            </button>
          </div>
        ) : (
          <iframe
            key={frameVersion}
            ref={frame}
            title={`${title} 插件沙盒`}
            src={url}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'"
            onError={() => {
              setBridgeState("插件加载失败，已启用安全回退");
              setFrameFailed(true);
            }}
          />
        )}
      </div>
    </div>
  );
}

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
