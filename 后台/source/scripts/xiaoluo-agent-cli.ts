/**
 * 小逻 v3 —— CLI 第二宿主（P3：证明进程边界是真的）
 *
 *   npx tsx scripts/xiaoluo-agent-cli.ts ask "把工作区里的 README 读一遍，总结要点"
 *   npx tsx scripts/xiaoluo-agent-cli.ts repl --canvas <canvasId> --model <modelId>
 *   npx tsx scripts/xiaoluo-agent-cli.ts caps
 *   npx tsx scripts/xiaoluo-agent-cli.ts fork
 *
 * 这个宿主不含任何内核逻辑：只 import 协议与客户端，隔着 HTTP 说话。
 * 引擎、闸门、沙箱全在服务进程里 —— 它能跑，就说明 ChatAgent 不再只能活在 React 组件里。
 *
 * 认证：服务只认 xiaoluo_access cookie（15 分钟有效），把浏览器里那份贴过来即可：
 *   set XIAOLUO_ACCESS_TOKEN=<cookie 值>
 * 存档所有权在宿主（对齐「换宿主不动持久化」）：读写同一份 /api/v2/chat/{cid}，
 * 且保留浏览器宿主写下的 uiMessages —— CLI 只换内核账本，不抹老板看得见的对话流。
 */

import readline from "node:readline/promises";
import { AgentClient, AgentRpcError, httpTransport, isThreadGone } from "../app/xiaoluo-brain/lib/brain/agent-client";
import { RPC, type AgentApprovalEvent, type AgentEvent, type AgentThreadSnapshot } from "../app/xiaoluo-brain/lib/brain/agent-wire";
import type { ChatPersistence } from "../app/xiaoluo-brain/lib/brain/types";

interface Flags {
  url: string;
  canvas: string;
  model: string;
  conv: string;
  token: string;
}

function parseFlags(argv: string[]): { flags: Flags; rest: string[] } {
  const flags: Flags = {
    url: process.env.XIAOLUO_URL ?? "http://127.0.0.1:3000",
    canvas: process.env.XIAOLUO_CANVAS ?? "",
    model: process.env.XIAOLUO_MODEL ?? "",
    conv: process.env.XIAOLUO_CONV ?? "",
    token: process.env.XIAOLUO_ACCESS_TOKEN ?? "",
  };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--url" && next) flags.url = next, (i += 1);
    else if (arg === "--canvas" && next) flags.canvas = next, (i += 1);
    else if (arg === "--model" && next) flags.model = next, (i += 1);
    else if (arg === "--conv" && next) flags.conv = next, (i += 1);
    else if (arg === "--token" && next) flags.token = next, (i += 1);
    else rest.push(arg);
  }
  return { flags, rest };
}

function headers(token: string): Record<string, string> {
  // 服务端会话是 HttpOnly cookie，命令行拿不到浏览器存储，只能由老板把值贴进环境变量
  return token ? { cookie: "xiaoluo_access=" + token } : {};
}

async function apiFetch(flags: Flags, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(flags.url.replace(/\/$/, "") + path, {
    ...init,
    headers: { "content-type": "application/json", ...headers(flags.token), ...(init.headers ?? {}) },
  });
}

/** 读宿主侧存档（服务端那份）；404 = 这条对话还没落过盘 */
async function loadArchive(flags: Flags, conversationId: string): Promise<ChatPersistence | null> {
  const resp = await apiFetch(flags, "/api/v2/chat/" + encodeURIComponent(conversationId));
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error("读取存档失败（HTTP " + resp.status + "）：" + (await resp.text()));
  return (await resp.json()) as ChatPersistence;
}

async function saveArchive(flags: Flags, previous: ChatPersistence | null, conversationId: string, snapshot: AgentThreadSnapshot): Promise<void> {
  const body: ChatPersistence = {
    version: 1,
    conversationId,
    savedAt: Date.now(),
    // 保留浏览器宿主的可见对话流：CLI 不该把老板的时间线抹掉
    uiMessages: previous?.uiMessages ?? [],
    messages: snapshot.messages,
    usedTokens: snapshot.usedTokens,
    ...(snapshot.lastCode ? { lastCode: snapshot.lastCode } : {}),
    ...(snapshot.goal ? { goal: snapshot.goal } : {}),
    ...(snapshot.dirtyCodeFiles.length ? { dirtyCodeFiles: snapshot.dirtyCodeFiles } : {}),
    ...(snapshot.readPaths.length ? { readPaths: snapshot.readPaths } : {}),
  };
  const resp = await apiFetch(flags, "/api/v2/chat/" + encodeURIComponent(conversationId), { method: "PUT", body: JSON.stringify(body) });
  if (!resp.ok) throw new Error("写存档失败（HTTP " + resp.status + "）：" + (await resp.text()));
}

/**
 * 本轮是否已经逐字打过字：定稿那条 assistant 事件不该再把同样的话贴一遍
 * （浏览器宿主靠 postUI 的 fromStream 找回占位气泡原地定稿，终端里"气泡"就是屏幕本身）。
 */
let streamedThisTurn = false;

function printEvent(event: AgentEvent): void {
  switch (event.method) {
    case "event/turn":
      if (event.phase === "started") {
        streamedThisTurn = false;
        console.log("\x1b[90m· 回合 " + event.turnId + " 开始\x1b[0m");
      } else console.log("\x1b[90m· 回合结束：" + (event.outcome ? `${event.outcome.steps} 步 / ${event.outcome.usedTokens} tokens` : "无回执") + "\x1b[0m");
      return;
    case "event/stream":
      if (event.phase === "delta") {
        streamedThisTurn = true;
        process.stdout.write(event.text ?? "");
      } else if (event.phase === "end") process.stdout.write("\n");
      return;
    case "event/approval":
      // 应答由客户端自动完成（onApproval 里问老板），这里只负责让老板看见卡在哪
      console.log("\x1b[33m⚠ 需要批准：" + event.action + " → " + event.subject + "\x1b[0m");
      for (const reason of event.reasons) console.log("   · " + reason);
      return;
    case "event/tool-request":
      // 终端宿主一个口都不声明（没有画布、没有浏览器、没有桌面通道），正常情况下收不到这条；
      // 真收到了就说明能力面谈歪了，客户端会自动回「不支持」，这里只让老板看见
      console.log("\x1b[33m⚠ 内核请宿主代跑 " + event.port + "." + event.call + "（终端宿主没有这项能力，已回绝）\x1b[0m");
      return;
    case "event/error":
      console.log("\x1b[31m✗ " + event.message + "\x1b[0m");
      return;
    case "event/ui":
      if (event.kind === "assistant") {
        if (streamedThisTurn && event.meta?.fromStream) return;
        console.log("\n小逻：" + event.content);
      } else if (event.kind === "status") console.log("\x1b[90m· " + event.content + "\x1b[0m");
      else console.log("\x1b[36m▶ " + event.kind + "\x1b[0m " + event.content.slice(0, 400) + (event.content.length > 400 ? " …" : ""));
      return;
    default:
      return;
  }
}

async function approveQuestionally(event: AgentApprovalEvent): Promise<boolean> {
  if (!process.stdin.isTTY) return false; // 没终端就没人能批准：保守拒绝，不放行危险操作
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question("批准【" + event.action + "】" + event.subject + "？[y/N] ");
    return answer.trim().toLowerCase() === "y";
  } finally {
    rl.close();
  }
}

function makeClient(flags: Flags): AgentClient {
  return new AgentClient({
    transport: httpTransport({ baseUrl: flags.url, headers: headers(flags.token), onStreamError: (e) => console.log("\x1b[31m事件流断开：" + e.message + "\x1b[0m") }),
    onEvent: printEvent,
    onApproval: approveQuestionally,
  });
}

function requireIds(flags: Flags): string {
  if (!flags.canvas || !flags.model) {
    console.error("缺少 --canvas / --model（也可用环境变量 XIAOLUO_CANVAS、XIAOLUO_MODEL）");
    console.error("canvasId 是画布 id，model 是模型连接 id；对话 id 默认 brain-<canvasId>");
    process.exit(2);
  }
  return flags.conv || "brain-" + flags.canvas;
}

/** 起线程：有存档就 resume（宿主交快照），没存档就 start */
async function ensureThread(client: AgentClient, flags: Flags, conversationId: string): Promise<ChatPersistence | null> {
  const previous = await loadArchive(flags, conversationId);
  const base = { conversationId, canvasId: flags.canvas, model: flags.model };
  if (previous?.messages?.length) {
    await client.threadResume({
      ...base,
      snapshot: {
        messages: previous.messages,
        usedTokens: previous.usedTokens ?? 0,
        lastCode: previous.lastCode ?? null,
        goal: previous.goal ?? null,
        dirtyCodeFiles: previous.dirtyCodeFiles ?? [],
        readPaths: previous.readPaths ?? [],
      },
    });
    console.log("\x1b[90m· 已从服务端存档恢复（" + previous.messages.length + " 条消息）\x1b[0m");
  } else {
    await client.threadStart(base);
  }
  // 事件流要在第一轮之前就挂上：回合的正文、卡片、审批都只从这条流出来
  client.watch(conversationId);
  return previous;
}

async function runOnce(client: AgentClient, flags: Flags, conversationId: string, text: string): Promise<void> {
  try {
    const outcome = await client.runTurn({ conversationId, text });
    const read = await client.threadRead(conversationId);
    await saveArchive(flags, await loadArchive(flags, conversationId), conversationId, read.snapshot);
    if (outcome?.stopped) console.log("\x1b[33m（本轮被中止）\x1b[0m");
  } catch (e) {
    if (isThreadGone(e)) {
      console.error("\x1b[31m线程已被回收，下一条消息会自动从存档重建\x1b[0m");
      return;
    }
    throw e;
  }
}

async function commandAsk(flags: Flags, text: string): Promise<void> {
  if (!text) {
    console.error('用法：ask "要小逻做的事"');
    process.exit(2);
  }
  const conversationId = requireIds(flags);
  const client = makeClient(flags);
  await ensureThread(client, flags, conversationId);
  await runOnce(client, flags, conversationId, text);
}

async function commandRepl(flags: Flags): Promise<void> {
  const conversationId = requireIds(flags);
  const client = makeClient(flags);
  await ensureThread(client, flags, conversationId);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log("\x1b[90m直接输入 = 新一轮；:steer 文本 = 插话；:interrupt 停当前轮；:fork 分叉；:journal 看账；Ctrl-C 退出\x1b[0m");
  for (;;) {
    const line = await rl.question("你 › ");
    const text = line.trim();
    if (!text) continue;
    if (text === ":interrupt") {
      const r = await client.turnInterrupt(conversationId);
      console.log(r.wasRunning ? "已请求中止当前回合" : "当前没有回合在跑");
      continue;
    }
    if (text === ":journal") {
      const { entries } = await client.threadJournal(conversationId, 12);
      for (const e of entries) console.log("  [" + e.kind + "] " + e.note);
      continue;
    }
    if (text === ":fork") {
      const forked = await client.threadFork({ canvasId: flags.canvas, model: flags.model, fromConversationId: conversationId });
      await saveArchive(flags, null, forked.conversationId, forked.snapshot);
      console.log("已分叉出分支：" + forked.conversationId + "（--conv 传它即可接着聊）");
      continue;
    }
    if (text.startsWith(":steer ")) {
      const r = await client.turnSteer(conversationId, text.slice(7));
      console.log(r.running ? "已排队插话，下一个工具步之前生效" : "当前没有回合在跑，改当新一轮发吧");
      if (!r.running) await runOnce(client, flags, conversationId, text.slice(7));
      continue;
    }
    if (text === ":quit" || text === ":exit") break;
    await runOnce(client, flags, conversationId, text);
  }
  rl.close();
}

async function commandCaps(flags: Flags): Promise<void> {
  const conversationId = requireIds(flags);
  const client = makeClient(flags);
  try {
    const caps = await client.threadCapabilities(conversationId);
    console.log("工具面（" + caps.toolNames.length + " 个）：" + caps.toolNames.join(", "));
    console.log("运行时能力：" + JSON.stringify(caps.caps));
  } catch (e) {
    if (e instanceof AgentRpcError && e.code === RPC.THREAD_NOT_FOUND) {
      console.error("这条线程不在服务里，先 ask 或 repl 起一轮");
      process.exit(1);
    }
    throw e;
  }
}

const { flags, rest } = parseFlags(process.argv.slice(2));
const command = rest[0] ?? "help";

if (!flags.token) {
  console.error("\x1b[33m提示：没设 XIAOLUO_ACCESS_TOKEN，服务会当成未登录（401）。\x1b[0m");
  console.error("浏览器 devtools → Application → Cookies → xiaoluo_access，复制值后：set XIAOLUO_ACCESS_TOKEN=...");
}

try {
  if (command === "ask") await commandAsk(flags, rest.slice(1).join(" "));
  else if (command === "repl") await commandRepl(flags);
  else if (command === "caps") await commandCaps(flags);
  else {
    console.log("用法：tsx scripts/xiaoluo-agent-cli.ts <ask|repl|caps> --canvas <id> --model <id> [--conv <cid>] [--url http://127.0.0.1:3000]");
    console.log("  ask \"…\"   新一轮，跑完即退出（事件实时打印）");
    console.log("  repl      交互循环（:steer / :interrupt / :fork / :journal）");
    console.log("  caps      查这条线程注册得上的工具面");
  }
} catch (error) {
  console.error("\x1b[31m" + (error instanceof Error ? error.message : String(error)) + "\x1b[0m");
  process.exit(1);
}
