"use client";

import {
  Activity,
  Box,
  Braces,
  Check,
  CircleAlert,
  Code2,
  Cpu,
  Database,
  FileJson,
  Image as ImageIcon,
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
  Type,
  Upload,
  Video,
  AudioLines,
  FileOutput,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { IntentOSController } from "../hooks/use-intent-os";
import type {
  Capability,
  InstalledPackage,
  ModelProtocol,
  NodeKind,
} from "../types";
import { SchemaOptionBuilder } from "./schema-option-builder";

const modalityIcon = {
  text: Type,
  image: ImageIcon,
  video: Video,
  audio: AudioLines,
  document: FileOutput,
};

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

const starterManifest = `{
  "schemaVersion": "2.0",
  "id": "com.yourcompany.plugin-name",
  "name": "你的插件名称",
  "version": "1.0.0",
  "description": "插件功能说明",
  "type": "plugin",
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
}

type RegistryTab = "capabilities" | "packages";

export function CapabilitiesView({ os }: CapabilitiesViewProps) {
  const [tab, setTab] = useState<RegistryTab>("packages");
  const [packageDialog, setPackageDialog] = useState(false);
  const [skillDialog, setSkillDialog] = useState<Capability | "new" | null>(
    null,
  );
  const [sandbox, setSandbox] = useState<{
    title: string;
    url: string;
  } | null>(null);
  const [notice, setNotice] = useState<{
    tone: "success" | "error" | "info";
    text: string;
  } | null>(null);

  const extensionCount = os.packages.filter(
    (item) => item.packageType !== "skill",
  ).length;
  const skillCount = os.packages.filter(
    (item) => item.packageType === "skill",
  ).length;

  function showNotice(
    text: string,
    tone: "success" | "error" | "info" = "success",
  ) {
    setNotice({ text, tone });
  }

  return (
    <section className="content-view capability-view" aria-label="扩展中心">
      <header className="content-header extension-header">
        <div>
          <span className="eyebrow">EXTENSION PLATFORM · CONTRACT V2</span>
          <h1>扩展中心</h1>
          <p>Skill、Agent、Workflow 与插件共用注册表、权限边界和运行时路由。</p>
        </div>
        <div className="header-button-group">
          <button
            type="button"
            className="secondary-button"
            onClick={() => setSkillDialog("new")}
          >
            <Code2 size={16} /> 创建 Skill
          </button>
          <button
            type="button"
            className="primary-button"
            onClick={() => setPackageDialog(true)}
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

      <div className="registry-stats registry-stats-three">
        <button type="button" onClick={() => setTab("capabilities")}>
          <span className="stat-icon stat-indigo">
            <Box size={19} />
          </span>
          <p>能力投影</p>
          <strong>{os.capabilities.length}</strong>
          <small>节点与 Intent 即时可见</small>
        </button>
        <button type="button" onClick={() => setTab("packages")}>
          <span className="stat-icon stat-violet">
            <PlugZap size={19} />
          </span>
          <p>扩展包</p>
          <strong>{extensionCount}</strong>
          <small>Agent · Workflow · Plugin</small>
        </button>
        <button type="button" onClick={() => setTab("packages")}>
          <span className="stat-icon stat-amber">
            <FileJson size={19} />
          </span>
          <p>SKILL Package</p>
          <strong>{skillCount}</strong>
          <small>内容由你后续接入</small>
        </button>
      </div>

      <div className="registry-tabs" role="tablist" aria-label="扩展分类">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "packages"}
          className={tab === "packages" ? "is-active" : ""}
          onClick={() => setTab("packages")}
        >
          <PlugZap size={15} /> Package 管理
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "capabilities"}
          className={tab === "capabilities" ? "is-active" : ""}
          onClick={() => setTab("capabilities")}
        >
          <Database size={15} /> 能力投影
        </button>
      </div>

      {tab === "packages" && (
        <PackagesPanel
          os={os}
          onImport={() => setPackageDialog(true)}
          onNotice={showNotice}
          onSandbox={(item) =>
            item.runtimeUrl &&
            setSandbox({ title: item.name, url: item.runtimeUrl })
          }
        />
      )}
      {tab === "capabilities" && (
        <CapabilitiesPanel os={os} onEdit={setSkillDialog} />
      )}

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
          onClose={() => setPackageDialog(false)}
          onInstall={async (raw) => {
            const result = await os.installPackage(raw);
            setPackageDialog(false);
            setTab("packages");
            showNotice(
              `${result.package.name} 已${result.action === "installed" ? "安装" : "更新"}，能力投影已刷新。`,
            );
          }}
        />
      )}
      {skillDialog && (
        <SkillBuilderDialog
          initial={skillDialog === "new" ? undefined : skillDialog}
          packages={os.packages}
          onClose={() => setSkillDialog(null)}
          onInstall={async (raw) => {
            const result = await os.installPackage(raw);
            setSkillDialog(null);
            setTab("capabilities");
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

function PackagesPanel({
  os,
  onImport,
  onNotice,
  onSandbox,
}: {
  os: IntentOSController;
  onImport: () => void;
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
                      disabled={busy}
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
                      disabled={busy || !item.enabled}
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
                    <button
                      type="button"
                      className="danger-text-button"
                      disabled={busy}
                      onClick={() => {
                        if (!window.confirm(`确认卸载 ${item.name}？能力投影会同步移除。`)) return;
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

function CapabilitiesPanel({
  os,
  onEdit,
}: {
  os: IntentOSController;
  onEdit: (capability: Capability) => void;
}) {
  return (
    <div className="registry-column">
      <div className="section-title-row">
        <div>
          <h2>统一能力投影</h2>
          <p>系统契约与已安装 Package 会自动同步到画布节点选择器。</p>
        </div>
        <span className="registry-version">Live Projection</span>
      </div>
      <div className="contract-grid capability-contract-grid">
        {os.capabilities.map((capability) => (
          <CapabilityContract
            key={capability.id}
            capability={capability}
            editable={Boolean(
              capability.packageId &&
                os.packages
                  .find((item) => item.id === capability.packageId)
                  ?.packageKey?.startsWith("user.skill."),
            )}
            onEdit={() => onEdit(capability)}
          />
        ))}
      </div>
      <div className="skill-reserved-panel">
        <span className="reserved-icon"><Code2 size={22} /></span>
        <div>
          <h3>Skill 契约与节点保持同步</h3>
          <p>
            创建或导入自己的 Skill 后，参数 Schema、端口和模型兼容规则会自动投影到画布；
            已放入画布的节点保留版本快照，避免升级时静默破坏。
          </p>
          <div className="reserved-contracts">
            <span>manifest.json</span>
            <span>inputSchema</span>
            <span>outputSchema</span>
            <span>uiSchema</span>
          </div>
        </div>
        <span className="ready-seal"><Check size={13} /> ENGINE READY</span>
      </div>
    </div>
  );
}

function CapabilityContract({
  capability,
  editable,
  onEdit,
}: {
  capability: Capability;
  editable: boolean;
  onEdit: () => void;
}) {
  const Icon = modalityIcon[capability.modality];
  return (
    <article className={`contract-card ${capability.enabled ? "" : "is-disabled"}`}>
      <div className="contract-card-heading">
        <span className={`contract-icon contract-${capability.modality}`}>
          <Icon size={18} />
        </span>
        <span className="contract-source">{capability.category}</span>
      </div>
      <h3>{capability.title}</h3>
      <p>{capability.description}</p>
      {capability.packageId && <code>{capability.packageId}</code>}
      {editable && (
        <button
          type="button"
          className="contract-edit-button"
          onClick={onEdit}
        >
          <SquarePen size={13} /> 编辑选项
        </button>
      )}
      <div className="contract-schema">
        <span>{capability.parameterHint}</span>
        <span>v{capability.packageVersion}</span>
      </div>
    </article>
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

function PackageDialog({
  onClose,
  onInstall,
}: {
  onClose: () => void;
  onInstall: (raw: string) => Promise<void>;
}) {
  const [raw, setRaw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    setBusy(true);
    setError("");
    try {
      await onInstall(raw);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "安装失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="extension-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="extension-modal package-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="package-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-heading">
          <div>
            <span className="eyebrow">PACKAGE INSTALLER</span>
            <h2 id="package-dialog-title">导入 XiaoLuo Package</h2>
            <p>支持 JSON 格式的 .xlpkg 与 manifest.json。</p>
          </div>
          <button type="button" aria-label="关闭" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="package-drop-row">
          <label className="package-file-button">
            <Upload size={17} />
            <span><b>选择 Package 文件</b><small>.xlpkg 或 .json</small></span>
            <input
              type="file"
              accept=".xlpkg,.json,application/json"
              onChange={async (event) => {
                const file = event.target.files?.[0];
                if (file) setRaw(await file.text());
              }}
            />
          </label>
          <button
            type="button"
            className="secondary-button"
            onClick={() => setRaw(starterManifest)}
          >
            填入插件清单模板
          </button>
        </div>
        <label className="manifest-editor-label">
          <span>Package Manifest</span>
          <textarea
            className="manifest-editor"
            value={raw}
            onChange={(event) => setRaw(event.target.value)}
            placeholder="将 manifest JSON 粘贴到这里…"
            spellCheck={false}
          />
        </label>
        <div className="security-note">
          <ShieldCheck size={16} />
          <p>
            安装前会校验版本、ID、Schema、运行时与权限。Skill 不允许执行任意代码；
            远程 API 必须声明精确 HTTPS Origin。
          </p>
        </div>
        {error && <div className="modal-error"><CircleAlert size={14} /> {error}</div>}
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={!raw.trim() || busy}
            onClick={() => void submit()}
          >
            {busy ? <LoaderCircle size={15} className="spin" /> : <PackagePlus size={15} />}
            校验并安装
          </button>
        </div>
      </div>
    </div>
  );
}

const skillProtocols: Array<{ value: ModelProtocol; label: string }> = [
  { value: "openai-compatible", label: "OpenAI 兼容" },
  { value: "anthropic-compatible", label: "Anthropic 兼容" },
  { value: "gemini", label: "Gemini" },
  { value: "ark", label: "火山方舟" },
  { value: "async-video", label: "异步视频" },
];

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
  const [name, setName] = useState(initial?.title ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [modality, setModality] = useState<NodeKind>(
    initial?.modality ?? "text",
  );
  const [protocols, setProtocols] = useState<ModelProtocol[]>(
    initial?.modelRequirements?.protocols ?? [],
  );
  const [tags, setTags] = useState(
    initial?.modelRequirements?.capabilityTags?.join(", ") ?? "",
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
            inputSchema,
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
              ...(protocols.length ? { protocols } : {}),
              capabilityTags: tags
                .split(/[,，]/)
                .map((item) => item.trim().toLowerCase())
                .filter(Boolean),
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
          <label className="skill-builder-span">
            说明
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="说明这个 Skill 在节点中完成什么任务"
            />
          </label>
          <label className="skill-builder-span">
            要求的模型能力标签
            <input
              value={tags}
              onChange={(event) => setTags(event.target.value)}
              placeholder="例如：vision, image-edit；留空表示不限制"
            />
          </label>
        </div>
        <fieldset className="modality-picker skill-protocol-picker">
          <legend>兼容模型协议（不选择表示全部兼容）</legend>
          {skillProtocols.map((protocol) => (
            <label key={protocol.value}>
              <input
                type="checkbox"
                checked={protocols.includes(protocol.value)}
                onChange={() =>
                  setProtocols((current) =>
                    current.includes(protocol.value)
                      ? current.filter((item) => item !== protocol.value)
                      : [...current, protocol.value],
                  )
                }
              />
              {protocol.label}
            </label>
          ))}
        </fieldset>
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
  const bridgeToken = useRef(crypto.randomUUID());

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
