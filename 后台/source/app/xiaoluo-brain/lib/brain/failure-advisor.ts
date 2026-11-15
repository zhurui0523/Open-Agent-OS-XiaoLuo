/**
 * 小逻 v3 —— 执行失败自愈诊断（failure advisor）
 *
 * run_command / start_service 失败时按已知错误模式给出"诊断 + 换路建议"，
 * 附在工具回流里让小逻下一步自行修复（换命令/换端口/写脚本文件等），
 * 无需老板介入；连续同错仍由 chat-agent 熔断兜底，不会无限试错。
 */

export interface FailureAdvice {
  /** 一句话诊断（UI 旁白可展示） */
  diagnosis: string;
  /** 给小逻的换路指引（回流工具结果） */
  hint: string;
}

interface FailureRule {
  /** 命中即判（对错误输出 + 命令原文联合匹配） */
  test: (blob: string, command: string) => boolean;
  advice: (command: string) => FailureAdvice;
}

const RULES: FailureRule[] = [
  {
    // python 假身：WindowsApps 商店占位（点开商店后 exit 1/9009，输出近乎空）
    test: (blob, command) =>
      /^\s*(?:py|python\d?)(?:\.exe)?(\s|$)/i.test(command) &&
      (/WindowsApps/i.test(blob) || blob.replace(/\s+/g, "").length < 60),
    advice: () => ({
      diagnosis: "python 是微软商店假身（WindowsApps 占位），不是真解释器",
      hint:
        "自己修，别甩给老板：① run_command 跑 winget install -e --id Python.Python.3.12 装真 Python（会弹框请老板批准，等批准再继续）；" +
        "② 装完当前进程 PATH 可能不刷新——where python 仍指 WindowsApps 时，到 %LOCALAPPDATA% 的 Programs/Python 目录找真实 python.exe，用绝对路径调用；" +
        "③ 只是给静态目录起服务的话不必装：write_file 写 server.js（node 内置 http 模块）进该目录，start_service 起 node server.js。",
    }),
  },
  {
    // 编码破坏：中文路径/输出大量替换字符（GBK/UTF-8 乱码），shell 输出的路径不可信
    test: (blob) => (blob.match(/\uFFFD/g)?.length ?? 0) >= 3,
    advice: () => ({
      diagnosis: "命令输出中文乱码（编码被破坏），shell 输出的路径不可信",
      hint:
        "不要用 shell 输出解析中文路径。改走文件系统通道核实：list_dir 看目录结构、read_file 确认文件内容、grep_files/find_files 检索；" +
        "start_service 的 cwd 直接传 deploy_program 返回的目录名，别从命令输出里拼路径。",
    }),
  },
  {
    // 命令/程序不存在：cmd 中文报错、exit 9009、英文 not recognized
    test: (blob) =>
      /不是内部或外部命令|not recognized as an internal or external command/.test(blob),
    advice: (command) => ({
      diagnosis: `命令不可用：${firstToken(command)} 未安装或不在 PATH`,
      hint:
        "该命令在本机不存在，不要重试。本机可用：node（捆绑运行时）、pnpm；" +
        "确需其他解释器/工具就按环境自修纪律来：winget install 安装（弹框请老板批准），装完用 where 核实真实路径；" +
        "只是要静态服务的话不必装：write_file 写 server.js（node 内置 http 模块）再 node server.js。",
    }),
  },
  {
    // node -e 内联脚本被命令行引号破坏
    test: (blob, command) =>
      /\[eval\]|<anonymous>/.test(blob) &&
      /SyntaxError|Unterminated|string constant|Unexpected token/.test(blob) &&
      /(^|\s)node(\.exe)?(\s|$)/.test(command) &&
      /\s-e\s/.test(command),
    advice: () => ({
      diagnosis: "node -e 内联脚本被命令行引号破坏",
      hint:
        "Windows 命令行会破坏 node -e 内联代码的引号。改为：先 write_file 把脚本写成 .js 文件，" +
        "再用短命令 node xxx.js 执行/启动。禁止再次拼 node -e 长脚本。",
    }),
  },
  {
    // 端口被占用
    test: (blob) => /EADDRINUSE|address already in use|已在使用|only one usage of each socket address/i.test(blob),
    advice: () => ({
      diagnosis: "端口已被占用",
      hint:
        "换一个未占用端口重试；若占用者是自己先前启动的服务，先 service_status 查到 id 并 stop_service 再启动。",
    }),
  },
  {
    // 路径/文件不存在
    test: (blob) => /ENOENT|no such file or directory|系统找不到指定的(路径|文件)/.test(blob),
    advice: () => ({
      diagnosis: "路径或文件不存在",
      hint:
        "不要原样重试。先 list_dir 确认目录结构、核对 cwd 是否传对（部署目录名以 deploy_program 返回值为准），再执行。",
    }),
  },
  {
    // 模块缺失
    test: (blob) => /Cannot find module|Cannot find package|ERR_MODULE_NOT_FOUND/.test(blob),
    advice: () => ({
      diagnosis: "依赖模块缺失",
      hint:
        "先核对 cwd 是否在正确的项目目录；确属依赖缺失时用 pnpm install 安装（本机无 npm/npx）；" +
        "纯静态服务不要引第三方包，用 node 内置模块实现。",
    }),
  },
  {
    // 权限不足
    test: (blob) => /EPERM|EACCES|Access is denied|拒绝访问/.test(blob),
    advice: () => ({
      diagnosis: "权限不足",
      hint:
        "不要原样重试。改在本地工作区目录内操作（deploy_program 落盘目录），避免写系统目录或他处文件。",
    }),
  },
  {
    // 超时
    test: (blob) => /wall time|timed?\s*out|超时/.test(blob),
    advice: () => ({
      diagnosis: "命令超时",
      hint:
        "该命令在限时内未结束：长驻进程不要用 run_command，改用 start_service；或缩短命令范围再试。",
    }),
  },
];

/** 取命令首个 token（诊断展示用） */
function firstToken(command: string): string {
  return command.trim().split(/\s+/)[0] ?? command.slice(0, 20);
}

/**
 * 对失败输出做规则诊断；无命中返回 null（回流保持原样，小逻凭错误原文自行判断）。
 * blob 为 stdout+stderr 摘要，command 为失败命令原文。
 */
export function diagnoseExecutionFailure(blob: string, command: string): FailureAdvice | null {
  if (!blob) return null;
  for (const rule of RULES) {
    try {
      if (rule.test(blob, command)) return rule.advice(command);
    } catch {
      /* 单条规则异常不影响其余诊断 */
    }
  }
  return null;
}
