/**
 * 小逻 v3 —— 宿主代跑桥（浏览器侧）
 *
 * 内核跑在服务进程里，但它只有服务端那一圈端口。宿主独有的能力（画布生成、截屏、CDP、
 * UIA、SSH、本机落盘、MCP）得反过来由宿主代跑 —— 服务端按 hostTools 注册工具，
 * 跑的时候发 event/tool-request，宿主照这份表分发，返回值原样回流。
 *
 * 本文件是宿主那一侧的分发表，刻意不碰 React：任何宿主（面板、CLI、桌面主进程）
 * 只要有同样这几个方法口，就能用同一份声明+同一份分发接上线。
 */

import type { DesktopPort, SshPort, UiaPort, VisionPort, WebDriverPort } from "./agent-ports";
import type { AgentHostToolEvent, HostToolPort } from "./agent-wire";
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
import type { CodeArtifact, DeployProgramResult, McpPort, McpToolInfo, NodeRunResult } from "./types";

/** 宿主能代跑的那几口：有哪个口就声明哪个，内核只按声明来的（缺口 = 工具不注册，而不是跑了再失败） */
export interface HostAdapters {
  /** 画布媒体生成：直派节点执行并等结果（接 startRunServer + 轮询） */
  generateMedia?: (req: GenerateMediaArgs) => Promise<NodeRunResult>;
  /** 视觉/操作口（桌面通道；声明了才有 inspect_screen / operate_ui） */
  vision?: VisionPort;
  /** 整桌控制口（桌面通道） */
  desktop?: DesktopPort;
  /** 外部浏览器口（CDP，桌面通道） */
  webdriver?: WebDriverPort;
  /** 桌面控件语义口（Windows UIA，桌面通道） */
  uia?: UiaPort;
  /** SSH 远程执行口（桌面通道） */
  ssh?: SshPort;
  /** 本机落盘口（deploy_program；缺省则工具不注册） */
  deployProgram?(artifact: CodeArtifact, name?: string): Promise<DeployProgramResult>;
  /** MCP 外部工具（可选：mcp__<server>__<tool> 动态注册，清单交上去才有工具） */
  mcp?: McpPort;
  /**
   * 「允许小逻控制本机」闸门的读数（桌面宿主实现：问一次本机主进程）。
   * 返回 false = 明确关着；null/缺省 = 宿主答不上来（老版本主进程没这一问），按开着处理。
   */
  hostGate?: () => Promise<boolean | null>;
}

/**
 * 闸门关着时宿主一定回绝的那几口。
 * uia 不在列：枚举窗口/读控件树是只读的，主进程不拦 —— 老板问「桌面上开着什么窗口」，
 * 不用开开关也答得出。desktop/webdriver/ssh 一关就全哑，报上去只会让小逻撞一次闸，
 * 再回头让老板满设置里找那个开关。
 */
const GATED_HOST_PORTS: readonly HostToolPort[] = ["desktop", "webdriver", "ssh"];

/** 本宿主声明的代跑端口清单：有哪个口就声明哪个，内核只按声明来的（缺口 = 工具不注册，而不是跑了再失败） */
export function declaredHostTools(adapters: HostAdapters, gateOpen = true): HostToolPort[] {
  const ports: HostToolPort[] = [];
  if (adapters.generateMedia) ports.push("generateMedia");
  if (adapters.vision) ports.push("vision");
  if (adapters.desktop) ports.push("desktop");
  if (adapters.webdriver) ports.push("webdriver");
  if (adapters.uia) ports.push("uia");
  if (adapters.ssh) ports.push("ssh");
  if (adapters.deployProgram) ports.push("deploy");
  if (adapters.mcp?.tools.length) ports.push("mcp");
  return gateOpen ? ports : ports.filter((p) => !GATED_HOST_PORTS.includes(p));
}

/** 闸门读数：只有宿主明确说「关着」才收口，问不到答案不能白丢能力 */
export async function probeHostGate(adapters: HostAdapters): Promise<boolean> {
  if (!adapters.hostGate) return true;
  try {
    return (await adapters.hostGate()) !== false;
  } catch {
    return true;
  }
}

/** 随每次 thread/start|resume|fork 交出的宿主声明：换宿主/换 MCP 服务器/开关一动就是换这一份 */
export function hostDecl(adapters: HostAdapters, gateOpen = true): {
  hostTools: HostToolPort[];
  hostModelVision: boolean;
  mcpTools: McpToolInfo[];
} {
  return {
    hostTools: declaredHostTools(adapters, gateOpen),
    hostModelVision: adapters.vision?.modelVision === true,
    mcpTools: adapters.mcp?.tools ?? [],
  };
}

function notSupported(event: AgentHostToolEvent): Error {
  return new Error("本宿主跑不了 " + event.port + "." + event.call);
}

/**
 * 反向工具代跑：内核交来的 (port, call, args) 与端口方法一一对应，按位置参数展开。
 * 跑不了就抛 —— 抛出去的理由会回流给模型，比让它干等强。
 */
export async function runHostTool(adapters: HostAdapters, event: AgentHostToolEvent): Promise<unknown> {
  const [a0, a1] = event.args as [unknown, unknown, unknown];
  switch (event.port) {
    case "generateMedia":
      if (!adapters.generateMedia) throw notSupported(event);
      return await adapters.generateMedia(a0 as GenerateMediaArgs);
    case "vision": {
      const v = adapters.vision;
      if (!v) throw notSupported(event);
      switch (event.call) {
        case "capture":
          return await v.capture(a0 as "browser" | "window");
        case "operate":
          return await v.operate(a0 as OperateUiArgs);
        case "dom":
          return await v.dom(a0 as string | undefined);
        case "navigate":
          return await v.navigate(a0 as string);
        default:
          throw notSupported(event);
      }
    }
    case "desktop": {
      const d = adapters.desktop;
      if (!d) throw notSupported(event);
      switch (event.call) {
        case "capture":
          return await d.capture();
        case "operate":
          return await d.operate(a0 as DesktopOperateArgs);
        default:
          throw notSupported(event);
      }
    }
    case "webdriver": {
      const w = adapters.webdriver;
      if (!w) throw notSupported(event);
      switch (event.call) {
        case "navigate":
          return await w.navigate(a0 as string);
        case "dom":
          return await w.dom(a0 as "dom" | "text" | undefined, a1 as number | undefined);
        case "capture":
          return await w.capture();
        case "operate":
          return await w.operate(a0 as WebOperateArgs);
        case "eval":
          return await w.eval(a0 as string, a1 as boolean | undefined);
        case "record":
          return await w.record(a0 as WebRecordArgs);
        case "replay":
          return await w.replay(a0 as WebReplayArgs);
        default:
          throw notSupported(event);
      }
    }
    case "uia":
      if (!adapters.uia) throw notSupported(event);
      return await adapters.uia.inspect(a0 as DesktopInspectArgs);
    case "ssh":
      if (!adapters.ssh) throw notSupported(event);
      return await adapters.ssh.exec(a0 as SshExecArgs);
    case "deploy":
      if (!adapters.deployProgram) throw notSupported(event);
      return await adapters.deployProgram(a0 as CodeArtifact, a1 as string | undefined);
    case "mcp":
      if (!adapters.mcp) throw notSupported(event);
      return await adapters.mcp.callTool(a0 as string, (a1 ?? {}) as Record<string, unknown>);
    default:
      throw notSupported(event);
  }
}
