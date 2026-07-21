"use client";

import {
  Box,
  Check,
  ChevronRight,
  CircleAlert,
  Code2,
  Cpu,
  FileJson,
  Image as ImageIcon,
  LoaderCircle,
  Plus,
  RefreshCw,
  Settings2,
  Sparkles,
  Type,
  Video,
} from "lucide-react";
import type { IntentOSController } from "../hooks/use-intent-os";
import type { Capability } from "../types";

const modalityIcon = {
  text: Type,
  image: ImageIcon,
  video: Video,
};

interface CapabilitiesViewProps {
  os: IntentOSController;
}

export function CapabilitiesView({ os }: CapabilitiesViewProps) {
  return (
    <section className="content-view capability-view" aria-label="能力中心">
      <header className="content-header">
        <div>
          <span className="eyebrow">CAPABILITY REGISTRY</span>
          <h1>能力中心</h1>
          <p>统一管理能力契约和模型连接。SKILL 接入位已预留，由你后续添加。</p>
        </div>
        <button type="button" className="primary-button">
          <Plus size={16} /> 添加模型连接
        </button>
      </header>

      <div className="registry-stats">
        <div>
          <span className="stat-icon stat-indigo">
            <Box size={19} />
          </span>
          <p>系统能力</p>
          <strong>{os.capabilities.length}</strong>
          <small>文本 · 图像 · 视频</small>
        </div>
        <div>
          <span className="stat-icon stat-green">
            <Cpu size={19} />
          </span>
          <p>模型连接</p>
          <strong>{os.models.length}</strong>
          <small>{os.models.filter((model) => model.state === "healthy").length} 个健康</small>
        </div>
        <div>
          <span className="stat-icon stat-amber">
            <FileJson size={19} />
          </span>
          <p>SKILL Package</p>
          <strong>0</strong>
          <small>等待你后续接入</small>
        </div>
      </div>

      <div className="capability-layout">
        <div className="registry-column">
          <div className="section-title-row">
            <div>
              <h2>系统模态契约</h2>
              <p>节点、Intent 和 Runtime 共用同一份能力投影。</p>
            </div>
            <span className="registry-version">Projection v18</span>
          </div>
          <div className="contract-grid">
            {os.capabilities.map((capability) => (
              <CapabilityContract key={capability.id} capability={capability} />
            ))}
          </div>

          <div className="skill-reserved-panel">
            <span className="reserved-icon">
              <Code2 size={22} />
            </span>
            <div>
              <h3>SKILL 接入区域已留空</h3>
              <p>
                程序没有创建开发文档中的 14 个 SKILL。后续接入 Package 后，
                Registry 会把能力同步到 Intent、节点卡片和选择器。
              </p>
              <div className="reserved-contracts">
                <span>manifest.json</span>
                <span>inputSchema</span>
                <span>outputSchema</span>
                <span>uiSchema</span>
              </div>
            </div>
            <button type="button" className="secondary-button" disabled>
              等待接入
            </button>
          </div>
        </div>

        <aside className="model-column">
          <div className="section-title-row">
            <div>
              <h2>模型连接</h2>
              <p>健康状态决定节点可用模型。</p>
            </div>
            <button type="button" className="text-button">
              查看全部 <ChevronRight size={14} />
            </button>
          </div>
          <div className="model-list">
            {os.models.map((model) => (
              <article key={model.id} className="model-card">
                <div className="model-card-heading">
                  <span className="model-logo">
                    <Sparkles size={17} />
                  </span>
                  <div>
                    <h3>{model.name}</h3>
                    <p>{model.provider}</p>
                  </div>
                  <span className={`model-state state-${model.state}`}>
                    {model.state === "checking" ? (
                      <LoaderCircle size={13} className="spin" />
                    ) : model.state === "healthy" ? (
                      <Check size={13} />
                    ) : (
                      <CircleAlert size={13} />
                    )}
                    {model.state === "checking"
                      ? "检测中"
                      : model.state === "healthy"
                        ? "健康"
                        : "需复检"}
                  </span>
                </div>
                <div className="model-meta">
                  <span>{model.modalities.join(" · ")}</span>
                  <span>{model.latency}</span>
                </div>
                <div className="model-actions">
                  <button
                    type="button"
                    className="secondary-button compact"
                    onClick={() => os.testModel(model.id)}
                    disabled={model.state === "checking"}
                  >
                    <RefreshCw size={14} /> 测试连接
                  </button>
                  <button type="button" className="icon-text-button">
                    <Settings2 size={15} /> 配置
                  </button>
                </div>
              </article>
            ))}
          </div>
        </aside>
      </div>
    </section>
  );
}

function CapabilityContract({ capability }: { capability: Capability }) {
  const Icon = modalityIcon[capability.modality];
  return (
    <article className="contract-card">
      <div className="contract-card-heading">
        <span className={`contract-icon contract-${capability.modality}`}>
          <Icon size={18} />
        </span>
        <span className="contract-enabled">
          <Check size={12} /> 已启用
        </span>
      </div>
      <h3>{capability.title}</h3>
      <p>{capability.description}</p>
      <div className="contract-schema">
        <span>{capability.parameterHint}</span>
        <span>v{capability.packageVersion}</span>
      </div>
    </article>
  );
}

