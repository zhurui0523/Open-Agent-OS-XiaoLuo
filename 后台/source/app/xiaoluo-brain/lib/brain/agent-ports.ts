/**
 * 小逻 v3 —— ChatAgent 端口协议（P2：app-server 化的边界契约）
 *
 * 本文件只描述「引擎向宿主索要什么、宿主向引擎交出什么」，不实现任何东西：
 *  - 全部依赖都是 `import type`，编译后无运行时导入 → 浏览器、Node CLI、桌面主进程
 *    三种宿主都能原样引用同一份契约，不需要 React、不需要 Next、不需要沙箱；
 *  - ChatAgent 只通过 ChatAgentPorts 触碰外界，宿主实现哪些口，对应工具就注册哪些；
 *  - postUI 的事件载荷（ChatUIEventMeta）在这里定型，换宿主只需把这几种卡片画出来，
 *    引擎侧一行不改。
 *
 * 迁移自 chat-agent.ts / types.ts（协议与实现分文件是 app-server 化的第一步）；
 * 真正的进程边界（stdio/HTTP 包装这些口）尚未接线，但契约已可独立实现。
 */

import type { ChatToolCapabilities } from "./chat-tools";
import type { RuntimeToolCaps } from "./prompts";
import type { PreviewDocument } from "./preview";
import type {
  AskUserRequest,
  BrowserPort,
  ChatMessage,
  CodeArtifact,
  CommandPort,
  DeployProgramResult,
  FileSystemPort,
  GitPort,
  McpPort,
  NodeRunResult,
  ServicePort,
  ToolCall,
} from "./types";
import type { MemoryStore } from "./memory-store";
import type {
  DesktopInspectArgs,
  DesktopOperateArgs,
  GenerateMediaArgs,
  OperateUiArgs,
  SshExecArgs,
  WebOperateArgs,
  WebRecordArgs,
  WebReplayArgs,
} from "./chat-tools";

// ---------- 宿主配置与回合产出 ----------

export interface ChatAgentConfig {
  /** 每轮对话内最多工具步数（默认 40） */
  maxStepsPerTurn: number;
  /** token 软顶：超过后注入"尽快收尾本轮"提示（默认 120000） */
  tokenBudgetSoft: number;
  /** token 硬顶：超过后触发压缩续跑不再直接截断，安全阀压缩次数用尽才收尾（默认 200000） */
  tokenBudgetHard: number;
  /** 同一工具同样错误连败 N 次熔断（默认 2） */
  stuckThreshold: number;
  /** 历史 token 预算：超过即在轮首压缩早前对话（默认 140000） */
  contextBudget: number;
  /** 安全阀：单轮最多压缩次数，用尽后硬顶处收尾（默认 3） */
  maxCompactsPerTurn: number;
  /** 上下文用到多少百分比就触发压缩（缺省 80；100 = 撑满才压） */
  compactAtContextPct?: number;
  /** 工具结果回流历史的最大字符数（默认 4000，超出保首尾、中间挖除；可按工具覆盖） */
  maxToolResultChars: number;
  /** 整轮墙钟软闸（毫秒）：超过注入收尾提醒，一次即止（默认 10 分钟） */
  turnWallClockSoftMs: number;
  /** 整轮墙钟硬闸（毫秒）：超过强制收尾，防单个挂死工具拖住整轮（默认 25 分钟） */
  turnWallClockHardMs: number;
}

export const DEFAULT_CHAT_AGENT_CONFIG: ChatAgentConfig = {
  maxStepsPerTurn: 40,
  tokenBudgetSoft: 120000,
  tokenBudgetHard: 200000,
  stuckThreshold: 2,
  contextBudget: 140000,
  maxCompactsPerTurn: 3,
  maxToolResultChars: 4000,
  turnWallClockSoftMs: 10 * 60_000,
  turnWallClockHardMs: 25 * 60_000,
};

/** 一轮对话的产出 */
export interface ChatTurnOutcome {
  /** 本轮消耗的 token（累计） */
  usedTokens: number;
  /** 本轮工具步数 */
  steps: number;
  /** LLM 中断：历史已保留，老板下一条消息即续跑 */
  interrupted?: boolean;
  /** 用户中止 */
  stopped?: boolean;
  /** 安全阀截断（压缩次数用尽） */
  budgetExhausted?: boolean;
  /** 步数到顶的收尾方式：soft = 已补一次只写总结的收尾回合 */
  closedBy?: "soft";
}

// ---------- UI 事件载荷（宿主渲染的唯一依据） ----------

/** 对话流卡片类型（宿主 useChatAgent hook 映射到消息流） */
export type ChatUIKind =
  | "assistant" //    小逻正文回复
  | "status" //       过程旁白（弱化显示）
  | "code-card" //    代码卡（meta: { artifact }）
  | "preview-card" // 预览卡（meta: { preview }）
  | "media-card" //   媒体结果卡（meta: { result }）
  | "ask-card" //    反问卡（meta: { ask }）
  | "delivery-card" // 交付卡（meta: { delivery }：deploy/package 落盘凭据）
  | "plan-card"; //    规划卡（meta: { todos }：todo_write 任务清单）

/** review_code 的单条发现（LLM 结构化输出，宿主可分级渲染） */
export interface ReviewFinding {
  dimension: string;
  severity: string;
  file?: string;
  issue: string;
  fix?: string;
}

/** 交付卡载荷：deploy_program / package_program 的落盘凭据 */
export interface ChatUIDelivery {
  mode: "deploy" | "package";
  dir: string;
  fileCount: number;
  entryFile?: string;
  installHint?: string;
  runHint?: string;
  warnings?: string[];
}

/** 文件清单行（write_code / preview_code 附带的产物概览） */
export interface ChatUIFileInfo {
  path: string;
  language: string;
  chars: number;
}

/**
 * postUI 的事件载荷：卡片类型之外的结构化附属数据。
 * 命名字段是协议（宿主可按它渲染代码卡/预览卡/反问卡/交付卡），
 * 其余键允许工具自带扩展（tool/target/ok/detail/output/diff/spillPath/testReport 等
 * 走 TimeLine 通用渲染，宿主不认识就忽略，不报错）。
 */
export interface ChatUIEventMeta {
  /** 流式定稿去重：正文已由 streamUI 逐字打出，宿主原地定稿那条占位气泡而非新贴一条 */
  fromStream?: boolean;
  /** 产生本事件的工具名（时间线归组用） */
  tool?: string;
  /** 工具是否成功 */
  ok?: boolean;
  /** 目标（路径/命令/URL/会话 id） */
  target?: string;
  /** 结果摘录（弱化显示） */
  detail?: string;
  /** 命令/会话输出摘录 */
  output?: string;
  /** 自愈诊断（run_command / start_service 失败时回流） */
  diagnosis?: string;
  /** 测试信号（沙箱解析到的通过/失败数） */
  testReport?: { passed?: number; failed?: number; summary?: string };
  /** 超长输出的落盘路径（read_file 可分页读全文） */
  spillPath?: string;
  /** edit_file 的改动对照 */
  diff?: { oldText: string; newText: string };
  /** 代码卡正文 */
  artifact?: CodeArtifact;
  /** 预览卡文档 */
  preview?: PreviewDocument;
  /** 媒体卡结果 */
  result?: NodeRunResult;
  /** 反问卡请求 */
  ask?: AskUserRequest;
  /** 交付卡凭据 */
  delivery?: ChatUIDelivery;
  /** todo_write 任务清单 */
  todos?: Array<{ content: string; status: string }>;
  /** review_code 发现（已截断到前 12 条） */
  findings?: ReviewFinding[];
  /** 产物文件概览 */
  files?: ChatUIFileInfo[];
  /** 工具自带扩展 */
  [key: string]: unknown;
}

// ---------- 视觉/桌面/浏览器口 ----------

/** 视觉/操作口：内嵌浏览器截屏/真鼠标/DOM 快照/自主导航（桌面端通道；不实现则不注册） */
export interface VisionPort {
  capture(region: "browser" | "window"): Promise<{ dataUrl: string; width: number; height: number }>;
  operate(req: OperateUiArgs): Promise<string>;
  dom(urlMatch?: string): Promise<string>;
  navigate(url: string): Promise<string>;
  /** 当前模型是否具备视觉能力（宿主判定）：false 时 inspect_screen 降级为 DOM 快照 */
  modelVision?: boolean;
}

/** 整桌控制口：全屏截图/全局键鼠（桌面端通道；默认关闭，需老板显式开启） */
export interface DesktopPort {
  capture(): Promise<{ dataUrl: string; width: number; height: number }>;
  operate(req: DesktopOperateArgs): Promise<string>;
}

/** 外部浏览器口：CDP 接管系统 Edge/Chrome，DOM 级导航/读取/操作/截图（桌面端通道；不实现则不注册） */
export interface WebDriverPort {
  navigate(url: string): Promise<string>;
  dom(mode?: "dom" | "text", max?: number): Promise<string>;
  capture(): Promise<{ dataUrl: string; width: number; height: number }>;
  operate(req: WebOperateArgs): Promise<string>;
  eval(js: string, awaitPromise?: boolean): Promise<string>;
  record(req: WebRecordArgs): Promise<string>;
  replay(req: WebReplayArgs): Promise<string>; // RECORD-AGENT
}

/** 桌面控件语义口：Windows UI Automation 枚举窗口/控件树、按语义定位并操作（桌面端通道；不实现则 desktop_inspect 不可用） */
export interface UiaPort {
  inspect(req: DesktopInspectArgs): Promise<string>;
}

/** SSH 远程执行口：在远程主机跑命令（系统 OpenSSH，只密钥认证；不实现则 ssh_exec 不可用） */
export interface SshPort {
  exec(req: SshExecArgs): Promise<string>;
}

// ---------- 端口总表 ----------

export interface ChatAgentPorts {
  /** LLM 网关（现有模型通道，需支持 tool calling；流中断抛 BrainLLMError；signal 中止在途调用） */
  callLLM(req: {
    messages: ChatMessage[];
    tools: unknown[];
    model: string;
    /** 本轮中止信号：老板点停止时掐断在途请求，防 fetch 挂死拖死整轮 */
    signal?: AbortSignal;
    /** 流式正文增量回调（适配器边收边喂）：仅驱动 UI 逐字显形，不影响 Agent 逻辑 */
    onDelta?: (text: string) => void;
  }): Promise<{
    content: string;
    toolCalls?: ToolCall[];
    usage: { promptTokens: number; completionTokens: number };
    /** 上游收口原因：length/max_tokens = 输出被长度上限掐断（截断续跑闸依据） */
    finishReason?: string;
  }>;

  /** UI 事件出口：把卡片/旁白推进对话消息流（含 ask-card；老板应答走 answerAsk()） */
  postUI(kind: ChatUIKind, content: string, meta?: ChatUIEventMeta): void;

  /** 流式 UI 通道（可选）：begin 挂占位气泡，delta 逐字增长，end 收口；定稿走 postUI fromStream 去重 */
  streamUI?: {
    begin(): void;
    delta(text: string): void;
    end(): void;
  };

  /** 画布媒体生成（直派节点，无计划确认）；不实现则 generate_media 工具不可用 */
  generateMedia?(req: GenerateMediaArgs): Promise<NodeRunResult>;

  /** 联网检索（可选；不实现则 web_search 不注册） */
  webSearch?(query: string): Promise<string>;

  /** 历史检索（首轮注入，失败静默降级） */
  consultHistory?(goal: string): Promise<string>;

  /** 文件系统口（read_file / list_dir / write_file；不实现则不注册） */
  fs?: FileSystemPort;

  /** 子 Agent 口（dispatch_subagent；宿主给这个键才注册，子 Agent 自己不带，防递归） */
  subagent?: {
    maxDepth?: number;
    /** 允许子 Agent 写文件（默认只读；宿主显式开才生效） */
    write?: boolean;
  };

  /** MCP 口（mcp__<server>__<tool> 外部工具；不实现则不注册） */
  mcp?: McpPort;

  /** 受控命令口（run_command；建议宿主接 sandbox.ts 分级闸门） */
  command?: CommandPort;

  /** 服务管理口（二期：start_service / stop_service / service_status） */
  service?: ServicePort;

  /** 仓库口（git status/log/diff/commit） */
  git?: GitPort;

  /** 视觉/操作口（inspect_screen / operate_ui / read_browser_dom / navigate_browser；不实现则不注册） */
  vision?: VisionPort;

  /** 整桌控制口（desktop_screenshot / desktop_operate；不实现则不注册） */
  desktop?: DesktopPort;
  /** 外部浏览器口（web_* 五工具；CDP 接管系统 Edge/Chrome；不实现则不注册） */
  webdriver?: WebDriverPort;
  /** 桌面控件语义口（desktop_inspect；Windows UI Automation；不实现则不注册） */ // UIA-AGENT
  uia?: UiaPort;
  /** SSH 远程执行口（ssh_exec；系统 OpenSSH，只密钥认证；不实现则不注册） */ // SSH-AGENT
  ssh?: SshPort;
  /** 网页浏览口（browse_page） */
  browser?: BrowserPort;

  /** 长期记忆口（add_memory + 首轮注入；传入即常注册） */
  memory?: MemoryStore;

  /** 程序库落盘口：write_code 成功 → 自动保存（宿主实现存储；失败不得抛出） */
  saveProgram?(artifact: CodeArtifact): Promise<void>;

  /** 本机落盘口：deploy_program 把产物写入本地工作区（桌面端通道；未实现则工具不注册） */
  deployProgram?(artifact: CodeArtifact, name?: string): Promise<DeployProgramResult>;
}

// ---------- 能力推导（注册与说明共用一份，宿主换谁都是同一张表） ----------

/**
 * ports → 工具注册开关。ChatAgent 每轮建工具面时调用；
 * CLI/桌面宿主报告能力面时也调用它，保证「说有的」和「注册的」永远一致。
 * 新增一口只改这里一处。
 */
export function chatToolCapabilities(ports: ChatAgentPorts): ChatToolCapabilities {
  return {
    webSearchEnabled: Boolean(ports.webSearch),
    fsEnabled: Boolean(ports.fs),
    fsOpsEnabled: Boolean(ports.fs?.movePath && ports.fs?.deletePath),
    subagentEnabled: Boolean(ports.subagent),
    commandEnabled: Boolean(ports.command),
    interactiveEnabled: Boolean(ports.command?.startSession && ports.command?.writeSession),
    sessionListEnabled: Boolean(ports.command?.listSessions),
    gitEnabled: Boolean(ports.git),
    serviceEnabled: Boolean(ports.service),
    visionEnabled: Boolean(ports.vision),
    desktopEnabled: Boolean(ports.desktop),
    uiaEnabled: Boolean(ports.uia), // UIA-AGENT-CAPS
    webEnabled: Boolean(ports.webdriver),
    reviewEnabled: true, // REVIEW-AGENT
    sshEnabled: Boolean(ports.ssh), // SSH-AGENT
    browserEnabled: Boolean(ports.browser),
    memoryEnabled: Boolean(ports.memory),
    deployEnabled: Boolean(ports.deployProgram),
    mcpTools: ports.mcp?.tools ?? [],
    mcpResourcesEnabled: Boolean(ports.mcp?.listResources && ports.mcp?.readResource),
  };
}

/** ports → 能力说明段开关（与 chatToolCapabilities 同源，提示词不再自行判断接入与否） */
export function runtimeToolCaps(ports: ChatAgentPorts): RuntimeToolCaps {
  const caps = chatToolCapabilities(ports);
  return {
    webSearch: caps.webSearchEnabled,
    fs: caps.fsEnabled,
    command: caps.commandEnabled,
    git: caps.gitEnabled,
    service: caps.serviceEnabled ?? false,
    vision: caps.visionEnabled ?? false,
    desktop: caps.desktopEnabled ?? false,
    uia: caps.uiaEnabled ?? false, // UIA-CAPS
    web: caps.webEnabled ?? false, // WEB-DRIVE-CAPS
    review: true, // REVIEW-CAPS
    ssh: caps.sshEnabled ?? false, // SSH-CAPS
    browser: caps.browserEnabled,
    memory: caps.memoryEnabled ?? false,
    deploy: caps.deployEnabled ?? false,
    mcpTools: caps.mcpTools?.length ?? 0,
  };
}

/** ChatAgent 构造入参：宿主只提供这一份（配置 + 端口 + 模型 + 对话身份 + 系统提示词） */
export interface ChatAgentOptions {
  config: ChatAgentConfig;
  ports: ChatAgentPorts;
  model: string;
  conversationId: string;
  /** 对话型小逻系统提示词（含能力清单） */
  systemPrompt: string;
}
