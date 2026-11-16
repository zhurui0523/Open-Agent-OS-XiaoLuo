/**
 * 小逻 v3 —— 宿主工厂（P2：app-server 化的装配线）
 *
 * 引擎侧只需要一份 ChatAgentPorts（见 agent-ports.ts），但每个宿主还得知道：
 * 默认配置是什么、系统提示词怎么拼、恢复历史时构造参数怎么传。这几行散在 React hook 里，
 * CLI 或桌面主进程想复用就得抄一遍——抄一遍就会漂。
 *
 * 本文件把那点装配知识收进一个函数：宿主只交端口和模型 id，拿到的是同一个内核。
 * 依赖只有内核 + 提示词 + 端口协议，全是框架无关模块，Node 里也能直接跑。
 */

import { ChatAgent } from "./chat-agent";
import { DEFAULT_CHAT_AGENT_CONFIG, type ChatAgentConfig, type ChatAgentPorts } from "./agent-ports";
import { envLayer, resolveConfig } from "../../../../shared/agent-config.mjs";
import { buildXiaoluoChatPrompt } from "./prompts";
import type { ChatMessage, CodeArtifact } from "./types";

/**
 * 配置层 → 引擎档位（P2-6）。
 * 宿主若没显式传 config，就用「默认 + env 层」解析出来的值，
 * 让 XIAOLUO_MAX_STEPS_PER_TURN 这类变量真的生效，而不是写死在代码里。
 */
function configFromConfigLayer(): Partial<ChatAgentConfig> {
  const values = resolveConfig({ env: envLayer(process.env as Record<string, string | undefined>) })
    .values as Record<string, unknown>;
  return {
    maxStepsPerTurn: Number(values["agent.maxStepsPerTurn"]),
    tokenBudgetSoft: Number(values["agent.tokenBudgetSoft"]),
    tokenBudgetHard: Number(values["agent.tokenBudgetHard"]),
    contextBudget: Number(values["agent.contextBudget"]),
    maxCompactsPerTurn: Number(values["agent.maxCompactsPerTurn"]),
    compactAtContextPct: Number(values["agent.compactAtContextPct"]),
    maxToolResultChars: Number(values["agent.maxToolResultChars"]),
    turnWallClockSoftMs: Number(values["agent.turnWallClockSoftMs"]),
    turnWallClockHardMs: Number(values["agent.turnWallClockHardMs"]),
  };
}

export interface CreateChatAgentOptions {
  ports: ChatAgentPorts;
  model: string;
  conversationId: string;
  /** 能力清单文本（capabilities 注册表 → 每行一个 Skill/模型）；空串 = 不列清单 */
  capabilityCatalog?: string;
  /** 覆盖默认档位（步数/预算/闸值）；缺省用 DEFAULT_CHAT_AGENT_CONFIG */
  config?: ChatAgentConfig;
  /** 本机执行形态（桌面宿主为 true，影响提示词里的路径与命令口径） */
  localExecution?: boolean;
  /** 整份替换系统提示词（给了它就不再用 capabilityCatalog 拼） */
  systemPrompt?: string;
}

/** 装配一个对话型小逻；恢复历史时把存档的 messages / lastCode 传给构造函数的后两个参数 */
export function createChatAgent(
  opts: CreateChatAgentOptions,
  restoreMessages?: ChatMessage[],
  restoreLastCode?: CodeArtifact,
): ChatAgent {
  return new ChatAgent(
    {
      config: opts.config ?? { ...DEFAULT_CHAT_AGENT_CONFIG, ...configFromConfigLayer() },
      ports: opts.ports,
      model: opts.model,
      conversationId: opts.conversationId,
      capabilityCatalog: opts.capabilityCatalog,
      systemPrompt:
        opts.systemPrompt ??
        buildXiaoluoChatPrompt(opts.capabilityCatalog ?? "", { localExecution: opts.localExecution ?? false }),
    },
    restoreMessages,
    restoreLastCode,
  );
}
