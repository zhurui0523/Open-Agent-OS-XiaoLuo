/**
 * 小逻 v3 —— 对话型 Agent 核心类型
 *
 * v2 的规划型类型（TaskPlan / BrainPorts / BrainOutcome / BrainSuspension 及
 * plan_to_canvas 四工具协议）已随"小逻大脑对话规划"整体移除。
 * 现在的形态：小逻 = 对话型 Agent（多轮记忆 + 工具调用 + 卡片交付）。
 *
 * 保留的领域类型：CodeArtifact / NodeRunResult / PlanStep（节点描述）等，
 * 它们服务于代码域与画布生成，与"规划对话"无关。
 */

import type { DeliveryPackage } from "./delivery";

// ---------- 基础领域类型（与现有 kernel / capability 对齐） ----------

export type Modality = "text" | "image" | "video" | "audio" | "document" | "code";

/** 画布执行节点描述（generate_media 直派节点 / Skill 管线共用） */
export interface PlanStep {
  /** 节点 id */
  id: string;
  /** 交付模态，决定节点类型与尺寸表 */
  modality: Modality;
  /** 节点标题（画布显示） */
  title: string;
  /** 挂接的 Skill（capability id）；缺省 = 纯模型生成 */
  skillId?: string;
  /** 指定模型（用户显式选定时禁止静默回退——透传即可） */
  modelId?: string;
  /** 生成提示词（Skill 免提示词场景可为空，素材走 inputFrom） */
  prompt?: string;
  /** 上游节点 id：执行顺序依赖 */
  dependsOn?: string[];
  /** 素材来源节点 id：其产物作为本节点输入（如歌词→歌曲） */
  inputFrom?: string[];
}

// ---------- 对话内消息与工具协议 ----------

export type ChatRole = "user" | "assistant" | "tool" | "system";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** 工具调用（assistant 轮） */
  toolCalls?: ToolCall[];
  /** 工具结果（tool 轮），与 toolCallId 对应 */
  toolCallId?: string;
  toolName?: string;
}

export interface ToolCall {
  id: string;
  /** 工具名（对话型工具集见 chat-tools.ts 的 ChatToolName） */
  name: string;
  arguments: Record<string, unknown>;
}

// ---------- 交互（ask_user 的 UI 载体） ----------

export interface AskUserRequest {
  /** 问题正文 */
  question: string;
  /** 可选项；为空则用户自由输入 */
  options?: string[];
  /** 是否要求上传素材（如缺角色图时） */
  requireAttachment?: boolean;
  /** 阻塞级别：true = 本轮挂起等待；false = 可跳过 */
  blocking: boolean;
}

export interface AskUserAnswer {
  text?: string;
  selected?: string;
  /** 素材地址列表（走现有上传通道） */
  attachments?: string[];
  /** 用户选择跳过（仅非阻塞问题） */
  skipped?: boolean;
}

// ---------- 执行结果回流（generate_media 的观察数据） ----------

export interface NodeRunResult {
  stepId: string;
  nodeId: string;
  status: "succeeded" | "failed" | "cancelled";
  /** 产物摘要：文本取前 N 字，媒体给 URL */
  outputSummary: string;
  /** 产物地址（图片/视频/音频/文档） */
  assetUrl?: string;
  /** 代码产物（write_code 工具 / code 节点） */
  code?: CodeArtifact;
  /** 交付包（code-deliver 节点产出：清单 + 安装/运行指引 + 风险提醒） */
  delivery?: DeliveryPackage;
  /** 失败原因（failed 时必填） */
  error?: string;
  /** 复用上游结果的标记（对齐 reuseKernelOutput） */
  reused?: boolean;
}

// ---------- 代码产物 ----------

export interface CodeFile {
  /** 相对路径（如 src/utils/date.ts），交付时按此落盘 */
  path: string;
  /** 语言标识（typescript / python / sql / shell …） */
  language: string;
  /** 文件内容全文 */
  content: string;
}

export interface CodeArtifact {
  files: CodeFile[];
  /** 主入口文件路径（展示与用户落盘引导用），应在 files 内 */
  entryFile?: string;
  /** 使用说明：依赖安装/运行方式/注意事项 */
  notes?: string;
  /** 实测/期望的测试信号（沙箱执行或测试规格节点回填） */
  testReport?: {
    passed?: number;
    failed?: number;
    summary?: string;
  };
}

// ---------- 程序库（write_code 产物的落盘持久化） ----------

/** 程序文件（含全文）：客户端上报 / 服务端读回的单位 */
export interface ProgramFile {
  path: string;
  language: string;
  content: string;
}

/** 程序身份证：.data/brain-programs/ 下每个程序文件夹的 meta.json */
export interface ProgramMeta {
  /** 文件夹名 = 唯一 id（时间戳-名称slug） */
  id: string;
  name: string;
  /** 入口文件路径 */
  entry: string;
  /** 文件清单（仅元信息，不带全文：列表页秒开） */
  files: Array<{ path: string; language: string; chars: number }>;
  createdAt: string;
  updatedAt: string;
  /** 同一对话多次覆盖保存，版本递增 */
  version: number;
  source: { conversationId: string };
  model?: string;
}

/** 程序全量记录：meta + 文件全文（GET 单条的返回形态） */
export interface ProgramRecord extends ProgramMeta {
  contents: ProgramFile[];
}

// ---------- 宿主能力端口（Codex 化工具面；不实现则对应工具不注册） ----------

/** 文件系统条目（list_dir 的返回单元） */
export interface FileEntry {
  path: string;
  isDir: boolean;
  /** 字节数（目录可缺省） */
  size?: number;
}

/** read_file 窗口参数（按行，1 起） */
export interface FsReadWindow {
  /** 窗口起始行（默认 1） */
  offset?: number;
  /** 读取行数（默认 500，上限 2000） */
  limit?: number;
}

/** read_file 窗口化结果（带截断标记，防大文件撑爆上下文） */
export interface FsReadResult {
  content: string;
  /** 当前窗口之外还有内容 */
  truncated?: boolean;
  totalLines?: number;
}

/** 内容搜索命中（grep_files） */
export interface FsGrepHit {
  path: string;
  line: number;
  text: string;
}

/** MCP 工具信息（带服务器命名空间前缀，mcp__<server>__<tool>，与 Claude Code/Codex 同形状） */
export interface McpToolInfo {
  /** 公开名（已归一化 [A-Za-z0-9_-]，≤64 字符） */
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

/** MCP 口：外部 Model Context Protocol 服务器（stdio 传输，宿主在桌面主进程托管子进程） */
export interface McpPort {
  /** 本会话已发现的 MCP 工具（注册进工具面供模型调用） */
  tools: McpToolInfo[];
  /** 按公开名调用；宿主内部反查 (server, rawName) 映射后走 tools/call */
  callTool(qualifiedName: string, args: Record<string, unknown>): Promise<string>;
}

/** 文件系统口：read_file / list_dir / write_file / grep_files / find_files 的宿主实现 */
export interface FileSystemPort {
  listDir(path: string): Promise<FileEntry[]>;
  readFile(path: string, window?: FsReadWindow): Promise<FsReadResult>;
  writeFile(path: string, content: string): Promise<void>;
  /** 内容搜索（正则逐行）；未实现则 grep_files 回流提示 */
  grep?(pattern: string, opts?: { path?: string; maxResults?: number }): Promise<FsGrepHit[]>;
  /** 文件名搜索（正则）；未实现则 find_files 回流提示 */
  find?(name: string, opts?: { path?: string; maxResults?: number }): Promise<string[]>;
}

/** 终端命令执行结果 */
export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** 输出超长时全文落盘的相对路径（read_file 可分页读全文） */
  spillPath?: string;
}

/** 受控命令口：run_command 工具的宿主实现（建议接 sandbox.ts 的分级闸门） */
export interface CommandPort {
  run(command: string, opts?: { cwd?: string; timeoutMs?: number }): Promise<CommandResult>;
}

/** 服务运行快照（二期服务管理器回流结构） */
export interface ServiceRunInfo {
  id: string;
  command: string;
  pid: number;
  port?: number;
  url?: string;
  status: "starting" | "running" | "exited";
  listening?: boolean;
  exitCode?: number;
  ageMs: number;
  logTail: string;
}

/** 本机落盘结果（deploy_program：程序文件写入本地工作区后的去向） */
export interface DeployProgramResult {
  /** 相对本地工作区的目录名（run_command / start_service 的 cwd 用它） */
  dir: string;
  fileCount: number;
}

/** 服务管理口（二期）：start_service / stop_service / service_status 的宿主实现 */
export interface ServicePort {
  start(command: string, opts?: { ttlMs?: number; cwd?: string }): Promise<ServiceRunInfo>;
  stop(id: string): Promise<ServiceRunInfo>;
  status(id?: string): Promise<ServiceRunInfo[]>;
}

/** git 支持的操作面（只读优先，写操作 commit/push；push 需老板批准；branch/checkout/merge/pull 分支面） */
export type GitOp = "status" | "log" | "diff" | "commit" | "push" | "branch" | "checkout" | "merge" | "pull";

/** 仓库口：git 工具的宿主实现（本地仓库/Electron 主进程代理均可） */
export interface GitPort {
  exec(op: GitOp, repoPath: string, opts?: { message?: string; limit?: number; ref?: string }): Promise<string>;
}

/** 网页抓取结果（browse_page 工具用；宿主做正文提取） */
export interface PageDigest {
  title: string;
  text: string;
}

/** 网页浏览口：browse_page 工具的宿主实现 */
export interface BrowserPort {
  fetchPage(url: string): Promise<PageDigest>;
}

// ---------- LLM 网关异常契约 ----------

/**
 * 流中断/网络错误时抛出此类型：
 * partial = 已接收到的部分正文（弱网下不丢已产出内容）；
 * retryable = 允许 Agent 自动重试一次（如超时/断流），4xx 类错误设为 false。
 */
export class BrainLLMError extends Error {
  partial?: string;
  retryable?: boolean;
  constructor(message: string, opts?: { partial?: string; retryable?: boolean }) {
    super(message);
    this.name = "BrainLLMError";
    this.partial = opts?.partial;
    this.retryable = opts?.retryable ?? true;
  }
}

// ---------- 对话持久化（localStorage 起步，服务端接口预留） ----------

/** 对话历史序列化单元：刷新页面后小逻"还记得"聊过什么 */
export interface ChatPersistence {
  version: 1;
  conversationId: string;
  /** LLM 消息历史（含 system 提示词轮） */
  messages: ChatMessage[];
  /** 累计 token（预算跨刷新延续） */
  usedTokens: number;
  /** 挂起的反问卡（刷新后重新挂回消息流） */
  pendingAsk?: AskUserRequest;
  /** 上次 write_code 的产物（刷新后仍可 preview_code / 继续修改） */
  lastCode?: CodeArtifact;
  /** UI 消息流全量快照（刷新后原样恢复对话） */
  uiMessages?: unknown[];
  /** 上次因 LLM 中断挂起（提示老板发消息续聊） */
  interrupted?: boolean;
  savedAt: number;
}

// ---------- 对话持久化接缝（⑦ 服务端迁移预留） ----------

/**
 * 持久化口：默认 localStorage 实现（LocalStorageChatStore）；
 * 服务端实现见 api.ts（HttpChatStore，基址 http://127.0.0.1:3001）。
 * 异步签名：HTTP 实现天然需要 await，localStorage 实现包 Promise 即可。
 */
export interface ChatStore {
  load(conversationId: string): Promise<ChatPersistence | null>;
  save(conversationId: string, data: ChatPersistence): Promise<void>;
}

/** 默认实现：localStorage（key: xiaoluo-chat:{cid}） */
export class LocalStorageChatStore implements ChatStore {
  async load(conversationId: string): Promise<ChatPersistence | null> {
    try {
      const raw = localStorage.getItem(`xiaoluo-chat:${conversationId}`);
      return raw ? (JSON.parse(raw) as ChatPersistence) : null;
    } catch {
      return null;
    }
  }
  async save(conversationId: string, data: ChatPersistence): Promise<void> {
    try {
      localStorage.setItem(`xiaoluo-chat:${conversationId}`, JSON.stringify(data));
    } catch {
      /* 存储满则放弃持久化，对话仍可在线进行 */
    }
  }
}
