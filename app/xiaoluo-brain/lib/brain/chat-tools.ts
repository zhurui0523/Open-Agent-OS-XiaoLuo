/**
 * 小逻 v3 —— 对话型 Agent 工具面（worker tools，Codex 化）
 *
 * 与 v2 规划型的根本区别：
 *  - 没有 plan_to_canvas / run_nodes / finish——不做"先计划、再确认、再执行"的仪式；
 *  - 小逻边聊边干：要代码就写代码（write_code），要看效果就预览（preview_code），
 *    要图片视频就直接派画布节点（generate_media），信息不够就反问（ask_user）。
 *  - 治理仍然在：每轮步数预算、失败熔断、中断保留——只是不再以"计划"为单位。
 *
 * 路线图②补全：新增文件/命令/git/网页/多视角工具，全部按宿主能力动态注册
 * （角色隔离在注册层：未实现的口 → 对应工具不注册，模型看不到也不会试）。
 */

import type { GitOp, McpToolInfo, Modality } from "./types";

// ---------- 工具名 ----------

export type ChatToolName =
  | "write_code" //     写代码：产出文件集 → 对话流显示代码卡
  | "preview_code" //   预览代码效果：HTML 类产物沙箱渲染 → 预览卡
  | "generate_media" // 直接派画布节点生成（图片/视频/音频/文档/文本）
  | "ask_user" //       反问：挂起等老板回答
  | "web_search" //     联网检索（可选口，未实现则不注册）
  | "read_file" //      读文件（fs 口）
  | "list_dir" //       列目录（fs 口）
  | "grep_files" //     内容搜索（fs 口：正则逐行）
  | "find_files" //     文件名搜索（fs 口：正则）
  | "write_file" //     写文件（fs 口；老板环境内的真实落盘）
  | "run_command" //    受控命令（command 口，建议接 sandbox 分级闸门）
  | "start_service" //  启动长驻服务（service 口：dev server 等）
  | "stop_service" //   停止服务
  | "service_status" // 查询服务状态与日志尾部
  | "git" //            仓库操作（git 口：status/log/diff/commit）
  | "browse_page" //    网页浏览（browser 口，正文提取后入证据账本）
  | "debate_ideas" //   多视角碰撞（复用 callLLM，无额外适配器，常注册）
  | "add_memory" //      长期记忆：记入老板偏好/约定（memory 口存在时常注册）
  | "deploy_program" //  把最近代码产物落到本机工作区（deploy 口：桌面端本地通道）
  | "package_program" // 组包交付：文件树+manifest+交付说明落盘 deliveries/（fs 口存在时注册）
  | "query_ledger"; //   查账本：证据引用与动作日志（纯内部账本，常注册）

// ---------- 工具参数 ----------

export interface WriteCodeArgs {
  files: Array<{ path: string; language: string; content: string }>;
  entryFile?: string;
  notes?: string;
}

export interface PreviewCodeArgs {
  /** 指定预览某个文件（缺省 = 入口文件） */
  file?: string;
}

export interface GenerateMediaArgs {
  modality: Exclude<Modality, "code">;
  prompt: string;
  skillId?: string;
  /** 老板显式指定模型时透传，禁止静默回退（既有决策） */
  modelId?: string;
  /** 参考素材地址（图生图/参考素材场景） */
  referenceAssets?: string[];
}

export interface WebSearchArgs {
  query: string;
}

export interface ReadFileArgs {
  path: string;
  /** 窗口起始行（1 起；大文件分页用） */
  offset?: number;
  /** 读取行数（默认 500，上限 2000） */
  limit?: number;
}

export interface GrepFilesArgs {
  /** 正则（不区分大小写） */
  pattern: string;
  /** 搜索子目录（缺省全工作区） */
  path?: string;
  maxResults?: number;
}

export interface FindFilesArgs {
  /** 文件名匹配正则 */
  name: string;
  path?: string;
  maxResults?: number;
}

export interface ListDirArgs {
  path: string;
}

export interface WriteFileArgs {
  path: string;
  content: string;
}

export interface RunCommandArgs {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  /** 后台长任务：转服务通道跑（不受命令超时限制），service_status 查日志、stop_service 终止 */
  background?: boolean;
}

export interface GitArgs {
  op: GitOp;
  repoPath: string;
  /** commit 时必填 */
  message?: string;
  /** log 条数上限（默认 10） */
  limit?: number;
  /** checkout/merge 的目标（分支名） */
  ref?: string;
}

export interface BrowsePageArgs {
  url: string;
}

export interface DebateIdeasArgs {
  topic: string;
  /** 视角列表（缺省自动三视角） */
  viewpoints?: string[];
}

// ---------- 工具 schema（OpenAI function-calling 格式） ----------

export interface StartServiceArgs {
  command: string;
  /** 存活时长毫秒（默认 30 分钟，最长 4 小时） */
  ttlMs?: number;
  /** 工作目录（相对本地工作区；deploy_program 返回的目录） */
  cwd?: string;
}

export interface DeployProgramArgs {
  /** 本机程序目录名（可选；缺省用程序名生成） */
  name?: string;
}

export interface StopServiceArgs {
  id: string;
}

export interface ServiceStatusArgs {
  id?: string;
}

export interface AddMemoryArgs {
  /** 记忆内容：一句简洁的陈述 */
  text: string;
}

export interface PackageProgramArgs {
  /** 交付包目录名（可选） */
  name?: string;
  /** 任务目标一句话（写进 manifest） */
  goal?: string;
}

export interface QueryLedgerArgs {
  /** 查哪本账（默认 all） */
  scope?: "all" | "evidence" | "journal";
  /** 条数（默认 10，上限 30） */
  limit?: number;
}

export interface TodoWriteArgs {
  /** 全量任务清单（每次传完整列表，幂等覆盖） */
  todos: { id: string; content: string; status: "pending" | "in_progress" | "complete" }[];
}

export interface EditFileArgs {
  /** 文件相对路径（工作区内） */
  path: string;
  /** 要替换的原文（必须与文件内容逐字符一致且在全文中唯一，含缩进换行） */
  oldText: string;
  /** 替换后的新文本 */
  newText: string;
}

export interface LoadSkillArgs {
  /** 技能名（能力清单【技能库】里的名字） */
  name: string;
}

export interface InstallPluginArgs {
  /** 插件包 zip 的工作区相对路径（如 uploads/xxx.zip） */
  zipPath: string;
}

export interface RepoMapArgs {
  /** 起始目录（工作区相对路径，默认根目录） */
  path?: string;
  /** 递归深度（默认 3，上限 5） */
  depth?: number;
  /** 跳过缓存强制重扫 */
  refresh?: boolean;
}

export interface SaveSkillArgs {
  /** 技能名（kebab-case，如 static-site-deploy） */
  name: string;
  /** 一句话说明这技能干什么 */
  description: string;
  /** 什么场景该用它（可选） */
  whenToUse?: string;
  /** 可复用的具体步骤正文（Markdown） */
  content: string;
}

const WRITE_CODE_SCHEMA = {
  type: "function",
  function: {
    name: "write_code",
    description:
      "编写或修改代码，产出完整文件集（每个文件带路径、语言、全文）。写完即可在对话中展示；可预览的（HTML 等）随后用 preview_code 给老板看效果。",
    parameters: {
      type: "object",
      required: ["files"],
      properties: {
        files: {
          type: "array",
          items: {
            type: "object",
            required: ["path", "language", "content"],
            properties: {
              path: { type: "string", description: "相对路径，如 index.html / src/app.ts" },
              language: { type: "string", description: "语言标识：html/css/javascript/typescript/python…" },
              content: { type: "string", description: "文件完整内容（不要截断、不要 markdown 围栏）" },
            },
          },
        },
        entryFile: { type: "string", description: "主入口文件路径（可选）" },
        notes: { type: "string", description: "使用说明：怎么运行/注意什么（可选）" },
      },
    },
  },
};

const PREVIEW_CODE_SCHEMA = {
  type: "function",
  function: {
    name: "preview_code",
    description:
      "预览最近一次 write_code 的产物效果（HTML/CSS/JS 会在沙箱里渲染出来给老板看）。仅在产物可预览时调用。",
    parameters: {
      type: "object",
      properties: {
        file: { type: "string", description: "要预览的文件路径；缺省用入口文件" },
      },
    },
  },
};

const GENERATE_MEDIA_SCHEMA = {
  type: "function",
  function: {
    name: "generate_media",
    description:
      "派画布节点生成图片/视频/音频/文档/文本。直接执行，无需计划确认；结果回流后如实告诉老板产物在哪。",
    parameters: {
      type: "object",
      required: ["modality", "prompt"],
      properties: {
        modality: {
          type: "string",
          enum: ["text", "image", "video", "audio", "document"],
        },
        prompt: { type: "string", description: "生成提示词" },
        skillId: { type: "string", description: "挂接的 Skill（能力清单里的 id，可选）" },
        modelId: { type: "string", description: "老板显式指定的模型（有则必须照用）" },
        referenceAssets: {
          type: "array",
          items: { type: "string" },
          description: "参考素材地址列表（可选）",
        },
      },
    },
  },
};

const ASK_USER_SCHEMA = {
  type: "function",
  function: {
    name: "ask_user",
    description:
      "向老板提问或索要素材。仅在关键信息缺失时使用；一次最多两个问题；能从上下文推断的不要问。",
    parameters: {
      type: "object",
      required: ["question", "blocking"],
      properties: {
        question: { type: "string" },
        options: { type: "array", items: { type: "string" }, description: "候选答案（2-4 个，可选）" },
        requireAttachment: { type: "boolean", description: "需要老板上传素材" },
        blocking: { type: "boolean", description: "true=必须回答才能继续" },
      },
    },
  },
};

const WEB_SEARCH_SCHEMA = {
  type: "function",
  function: {
    name: "web_search",
    description: "联网检索资料（写报告/查事实/看最新动态时用）。返回检索摘要。",
    parameters: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", description: "检索关键词" },
      },
    },
  },
};

// ---------- Codex 化工具 schema（路线图②：按宿主能力动态注册） ----------

const READ_FILE_SCHEMA = {
  type: "function",
  function: {
    name: "read_file",
    description: "读取老板环境中的文件内容（改存量代码前先读，禁止凭猜改）。默认读前 500 行；文件较大时会带截断标记，用 offset/limit 继续翻页。",
    parameters: {
      type: "object",
      required: ["path"],
      properties: {
        path: { type: "string", description: "文件路径" },
        offset: { type: "number", description: "起始行（1 起，可选）" },
        limit: { type: "number", description: "读取行数（可选，默认 500，上限 2000）" },
      },
    },
  },
};

const LIST_DIR_SCHEMA = {
  type: "function",
  function: {
    name: "list_dir",
    description: "列出目录内容（了解项目结构的第一步；先浏览再深入读文件）。",
    parameters: {
      type: "object",
      required: ["path"],
      properties: {
        path: { type: "string", description: "目录路径" },
      },
    },
  },
};

const GREP_FILES_SCHEMA = {
  type: "function",
  function: {
    name: "grep_files",
    description:
      "在工作区文件内容里做正则搜索（不区分大小写），返回 文件:行号:内容。找代码定义、报错出处、配置项时用。",
    parameters: {
      type: "object",
      required: ["pattern"],
      properties: {
        pattern: { type: "string", description: "正则表达式" },
        path: { type: "string", description: "限定搜索的子目录（可选）" },
        maxResults: { type: "number", description: "结果上限（默认 100）" },
      },
    },
  },
};

const FIND_FILES_SCHEMA = {
  type: "function",
  function: {
    name: "find_files",
    description: "按文件名正则在工作区递归找文件，返回相对路径列表。不知道文件在哪时先用它定位，再 read_file。",
    parameters: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", description: "文件名匹配正则" },
        path: { type: "string", description: "限定搜索的子目录（可选）" },
        maxResults: { type: "number", description: "结果上限（默认 200）" },
      },
    },
  },
};

const WRITE_FILE_SCHEMA = {
  type: "function",
  function: {
    name: "write_file",
    description:
      "把完整文件内容写入老板环境（真实落盘）。仅用于老板明确要求改他环境里的文件；写前应先 read_file。",
    parameters: {
      type: "object",
      required: ["path", "content"],
      properties: {
        path: { type: "string", description: "文件路径" },
        content: { type: "string", description: "文件完整内容（禁止截断/围栏）" },
      },
    },
  },
};

const RUN_COMMAND_SCHEMA = {
  type: "function",
  function: {
    name: "run_command",
    description:
      "在受控环境执行命令（跑测试/构建/安装依赖）。预计超过 5 分钟的长命令（完整构建/全量测试/长脚本）用 background=true 转后台跑，不受超时限制，用 service_status 查日志、stop_service 终止。删除类、不可逆命令会被闸门拦截；被拦时如实告知老板，不要换姿势绕过。",
    parameters: {
      type: "object",
      required: ["command"],
      properties: {
        command: { type: "string", description: "完整命令串" },
        cwd: { type: "string", description: "工作目录（可选）" },
        timeoutMs: { type: "number", description: "超时毫秒（可选，默认 120000，上限 300000）" },
        background: { type: "boolean", description: "后台长任务模式（可选）：转后台执行不受超时限制，返回任务 id，用 service_status 查进度与日志、stop_service 终止" },
      },
    },
  },
};

const START_SERVICE_SCHEMA = {
  type: "function",
  function: {
    name: "start_service",
    description:
      "启动长驻服务（如 npm run dev / node server.js），后台运行不受命令超时限制。启动成功返回服务 id 与访问地址（http://127.0.0.1:<端口>），把地址告诉老板；失败会带日志尾部，据它修复后用 stop_service 清场再重试。危险命令同样会被闸门拦截。",
    parameters: {
      type: "object",
      required: ["command"],
      properties: {
        command: { type: "string", description: "启动命令（在项目目录内）" },
        ttlMs: { type: "number", description: "存活时长毫秒（可选，默认 30 分钟）" },
        cwd: { type: "string", description: "工作目录（可选；deploy_program 返回的目录名，服务在该目录内启动）" },
      },
    },
  },
};

const STOP_SERVICE_SCHEMA = {
  type: "function",
  function: {
    name: "stop_service",
    description: "停止一个由 start_service 启动的服务（传服务 id）。",
    parameters: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string", description: "start_service 返回的服务 id" } },
    },
  },
};

const SERVICE_STATUS_SCHEMA = {
  type: "function",
  function: {
    name: "service_status",
    description: "查询服务运行状态、端口探活结果与日志尾部（不传 id 则列出全部）。",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "服务 id（可选）" } },
    },
  },
};

const GIT_SCHEMA = {
  type: "function",
  function: {
    name: "git",
    description:
      "仓库操作：status/log/diff/branch 只读；commit 需先 status 确认变更面；checkout/merge 传 ref（分支名/目标），merge 前确认工作区干净；pull 仅快进合并；push 会弹框请老板批准后执行（未批准会回流取消信息）。禁止 reset/force 等危险操作（不在操作面内）。",
    parameters: {
      type: "object",
      required: ["op", "repoPath"],
      properties: {
        op: { type: "string", enum: ["status", "log", "diff", "commit", "push", "branch", "checkout", "merge", "pull"] },
        repoPath: { type: "string", description: "仓库根目录" },
        message: { type: "string", description: "commit 信息（op=commit 必填）" },
        limit: { type: "number", description: "log 条数上限（默认 10）" },
        ref: { type: "string", description: "checkout/merge 的目标分支名（op=checkout/merge 必填）" },
      },
    },
  },
};

const BROWSE_PAGE_SCHEMA = {
  type: "function",
  function: {
    name: "browse_page",
    description: "打开指定网页并提取正文（读文档/看详情页）。结果入证据账本，引用时用 #rN 编号。",
    parameters: {
      type: "object",
      required: ["url"],
      properties: {
        url: { type: "string", description: "http(s) 地址" },
      },
    },
  },
};

const DEBATE_IDEAS_SCHEMA = {
  type: "function",
  function: {
    name: "debate_ideas",
    description:
      "对重要决策/创意议题发起多视角碰撞（默认乐观/审慎/用户三视角，并发陈述后主持人综合）。重大取舍、方向选择时用；小问题别用（费额度）。",
    parameters: {
      type: "object",
      required: ["topic"],
      properties: {
        topic: { type: "string", description: "议题（含必要背景）" },
        viewpoints: {
          type: "array",
          items: { type: "string" },
          description: "自定义视角列表（2-4 个，可选）",
        },
      },
    },
  },
};

const DEPLOY_PROGRAM_SCHEMA = {
  type: "function",
  function: {
    name: "deploy_program",
    description:
      "把最近一次 write_code 的代码产物一键落到老板本机的本地工作区（自动带上全部文件，无需重传内容），返回工作目录名。之后用 run_command 在该目录安装依赖（cwd 传该目录），用 start_service 启动（cwd 同），再用 browse_page 探活 http://127.0.0.1:<端口> 验证。纯静态 HTML 无需安装依赖：write_file 写 server.js（node 内置 http 模块）再 start_service \"node server.js\" 即可。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "本机目录名（可选；缺省按程序名生成）" },
      },
    },
  },
};

const PACKAGE_PROGRAM_SCHEMA = {
  type: "function",
  function: {
    name: "package_program",
    description:
      "把最近一次 write_code 的产物组装成正式交付包并落盘到工作区 deliveries/ 目录：文件树 + manifest.json（清单/安装/运行指引）+ DELIVERY.md（交付说明）。老板要打包/交付/要一份完整可带走的产物时用。与 deploy_program 的区别：deploy 是直接部署运行，package 是整理成交付件。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "交付包目录名（可选）" },
        goal: { type: "string", description: "任务目标一句话（写进 manifest）" },
      },
    },
  },
};

const EDIT_FILE_SCHEMA = {
  type: "function",
  function: {
    name: "edit_file",
    description:
      "增量编辑已有文件：先 read_file 确认原文，oldText 必须与文件中某段逐字符一致且唯一（含缩进/换行）；不唯一就带上下文扩长。小文件或全新文件用 write_file 全量写。",
    parameters: {
      type: "object",
      required: ["path", "oldText", "newText"],
      properties: {
        path: { type: "string", description: "文件相对路径（工作区内）" },
        oldText: { type: "string", description: "要替换的原文（唯一匹配，逐字符一致）" },
        newText: { type: "string", description: "替换后的新文本" },
      },
    },
  },
};

const QUERY_LEDGER_SCHEMA = {
  type: "function",
  function: {
    name: "query_ledger",
    description:
      "查本会话的内部账本：证据账本（#rN 引用材料）与动作日志（已执行过的工具动作）。写新文件/新产物前若不确定是否做过类似的事，先查一眼，优先复用与修改，避免重复劳动。",
    parameters: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["all", "evidence", "journal"], description: "查哪本账（默认 all）" },
        limit: { type: "number", description: "条数（默认 10，上限 30）" },
      },
    },
  },
};

const TODO_WRITE_SCHEMA = {
  type: "function",
  function: {
    name: "todo_write",
    description:
      "维护本次任务的执行清单（多步骤任务先规划再干）：每次传全量清单（幂等覆盖），开始一步前把它标 in_progress、做完标 complete，进度会以清单卡片实时展示给老板。单步小事（写一段代码、查个资料）不要用。",
    parameters: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          description: "全量任务清单（上限 20 步）",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "步骤短 id（如 t1/t2）" },
              content: { type: "string", description: "一步做什么（一句话，≤60 字）" },
              status: { type: "string", enum: ["pending", "in_progress", "complete"], description: "步骤状态" },
            },
            required: ["id", "content", "status"],
          },
        },
      },
      required: ["todos"],
    },
  },
};

/** 宿主能力开关：决定本轮注册哪些可选工具（未实现的口 → 工具不注册） */
const ADD_MEMORY_SCHEMA = {
  type: "function",
  function: {
    name: "add_memory",
    description: "把一条事实写入长期记忆（跨对话记住）：老板偏好、项目约定、反复出现的需求。只记长期有用的事实，一次一条，简洁陈述。",
    parameters: {
      type: "object",
      properties: { text: { type: "string", description: "记忆内容：一句简洁的陈述" } },
      required: ["text"],
    },
  },
};

const INSTALL_PLUGIN_SCHEMA = {
  type: "function",
  function: {
    name: "install_plugin",
    description:
      "安装插件包：把工作区里的 zip（内含 plugin.json 清单，可带 skills/）解压装进 plugins/<名字>/，装完技能库即可 load_skill 使用。老板给插件 zip 时用（先确认 zip 已在工作区，如 uploads/ 下）。",
    parameters: {
      type: "object",
      properties: {
        zipPath: { type: "string", description: "插件包 zip 的工作区相对路径（如 uploads/my-plugin.zip）" },
      },
      required: ["zipPath"],
    },
  },
};

const REPO_MAP_SCHEMA = {
  type: "function",
  function: {
    name: "repo_map",
    description:
      "仓库地图（大仓库导航首选）：扫目录产文件树 + 符号大纲（每文件的 class/函数/导出名），带缓存索引重复调用秒回。进大仓库/陌生工程先跑一次拿骨架再精确 grep/read，别盲翻。node_modules、dist 等产物目录自动跳过。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "起始目录（工作区相对路径，缺省工作区根）" },
        depth: { type: "number", description: "递归深度，默认 3，上限 5" },
        refresh: { type: "boolean", description: "跳过缓存强制重扫（怀疑地图过期时）" },
      },
    },
  },
};

export interface ChatToolCapabilities {
  webSearchEnabled: boolean;
  fsEnabled: boolean;
  commandEnabled: boolean;
  gitEnabled: boolean;
  browserEnabled: boolean;
  /** 服务管理（二期：start_service / stop_service / service_status） */
  serviceEnabled?: boolean;
  /** 多视角讨论（复用 callLLM，无额外适配器；默认开） */
  debateEnabled?: boolean;
  /** 长期记忆（add_memory；memory 口传入即常开） */
  memoryEnabled?: boolean;
  /** 本机程序落盘（deploy_program；deploy 口传入即开） */
  deployEnabled?: boolean;
  /** MCP 外部工具（mcp__<server>__<tool>；schema 由服务器上报，原样注册） */
  mcpTools?: McpToolInfo[];
}

/**
 * 组装本轮可用工具 schema：
 * 基础五件（write_code/preview_code/generate_media/ask_user/debate_ideas）常注册，
 * 其余按宿主能力开关动态注册（角色隔离在注册层，不在提示词）。
 */
export function buildChatToolSchemas(caps: ChatToolCapabilities): unknown[] {
  const schemas: unknown[] = [WRITE_CODE_SCHEMA, PREVIEW_CODE_SCHEMA, GENERATE_MEDIA_SCHEMA, ASK_USER_SCHEMA];
  if (caps.debateEnabled !== false) schemas.push(DEBATE_IDEAS_SCHEMA);
  if (caps.memoryEnabled) schemas.push(ADD_MEMORY_SCHEMA);
  if (caps.deployEnabled) schemas.push(DEPLOY_PROGRAM_SCHEMA);
  if (caps.webSearchEnabled) schemas.push(WEB_SEARCH_SCHEMA);
  if (caps.fsEnabled) schemas.push(READ_FILE_SCHEMA, LIST_DIR_SCHEMA, WRITE_FILE_SCHEMA, GREP_FILES_SCHEMA, FIND_FILES_SCHEMA, PACKAGE_PROGRAM_SCHEMA, EDIT_FILE_SCHEMA, REPO_MAP_SCHEMA);
  schemas.push(QUERY_LEDGER_SCHEMA, TODO_WRITE_SCHEMA);

const LOAD_SKILL_SCHEMA = {
  type: "function",
  function: {
    name: "load_skill",
    description:
      "加载技能库里的技能正文（skills/<name>/SKILL.md）。能力清单【技能库】一节列有可用技能；接 matching 任务前先加载再照做，别凭记忆重造流程。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "技能名（技能库目录里的精确名字）" },
      },
      required: ["name"],
    },
  },
};

const SAVE_SKILL_SCHEMA = {
  type: "function",
  function: {
    name: "save_skill",
    description:
      "把做法沉淀成技能（落盘 skills/<name>/SKILL.md，下轮起出现在技能库）。老板说\"记住这套做法/做成技能\"时用；做完一套值得复用的完整流程也可主动沉淀（先问老板）。正文写具体步骤，别写空话。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "技能名（kebab-case，如 static-site-deploy）" },
        description: { type: "string", description: "一句话说明（≤80 字）" },
        whenToUse: { type: "string", description: "什么场景该用（可选）" },
        content: { type: "string", description: "可复用的具体步骤正文（Markdown）" },
        verify: { type: "string", description: "可选验收命令：写盘后系统自动强制跑（如 node --check {path}），{path} 替换为当次写入的文件路径" },
      },
      required: ["name", "description", "content"],
    },
  },
};
  if (caps.commandEnabled) schemas.push(RUN_COMMAND_SCHEMA);
  if (caps.serviceEnabled) schemas.push(START_SERVICE_SCHEMA, STOP_SERVICE_SCHEMA, SERVICE_STATUS_SCHEMA);
  if (caps.gitEnabled) schemas.push(GIT_SCHEMA);
  if (caps.browserEnabled) schemas.push(BROWSE_PAGE_SCHEMA);
  // 技能三件套：schema 常量定义在注册语句之后，故在函数尾单独追加
  if (caps.fsEnabled) schemas.push(LOAD_SKILL_SCHEMA, SAVE_SKILL_SCHEMA);
  // 插件安装流（模块4）：解压 + manifest 校验需要命令与文件两个通道都在
  if (caps.fsEnabled && caps.commandEnabled) schemas.push(INSTALL_PLUGIN_SCHEMA);
  // 仓库地图：只读扫描，fs 通道在就注册
  if (caps.fsEnabled) schemas.push(REPO_MAP_SCHEMA);
  // MCP 外部工具：服务器上报的 inputSchema 原样挂进工具面（描述加 [MCP] 前缀表明来源）
  for (const t of caps.mcpTools ?? []) {
    schemas.push({
      type: "function",
      function: {
        name: t.name,
        description: "[MCP] " + (t.description || "外部工具"),
        parameters: t.inputSchema && typeof t.inputSchema === "object" ? t.inputSchema : { type: "object", properties: {} },
      },
    });
  }
  // delegate_task（学 kimi-code collaboration 单层分治）：子循环独立上下文，只回流摘要，中间步骤不进主线
  const DELEGATE_TASK_SCHEMA = {
    type: "function",
    function: {
      name: "delegate_task",
      description:
        "派一个子任务给子代理独立执行（适合多源调研、大段资料梳理）：子循环有独立上下文，只回流最终摘要，中间步骤不占主线篇幅。子代理只能用检索/只读工具（web_search/读文件等），不能写文件、跑命令。单步小事自己做，别滥用。",
      parameters: {
        type: "object",
        properties: {
          goal: { type: "string", description: "子任务目标（写清要查什么/梳理什么、产出什么格式的结论）" },
          context: { type: "string", description: "子代理需要知道的背景（可选）" },
        },
        required: ["goal"],
      },
    },
  };
  schemas.push(DELEGATE_TASK_SCHEMA);
  const SET_GOAL_SCHEMA = {
    type: "function",
    function: {
      name: "set_goal",
      description:
        "设定长期目标（目标 + 验收标准）：设定后小逻每轮自动核对是否达成，达成即清除并汇报。老板给出跨轮次目标（'一直做到 XX 为止'/'盯住 YY 直到 ZZ'）时用；clear:true 清除目标。",
      parameters: {
        type: "object",
        properties: {
          goal: { type: "string", description: "目标描述（设定时必填）" },
          criteria: { type: "string", description: "验收标准（怎样算达成）" },
          clear: { type: "boolean", description: "传 true 清除当前目标" },
        },
      },
    },
  };
  schemas.push(SET_GOAL_SCHEMA);
  return schemas;
}
