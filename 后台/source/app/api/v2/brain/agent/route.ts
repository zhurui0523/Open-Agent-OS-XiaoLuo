/**
 * 小逻 v3 —— app-server 的 HTTP 面（P3：进程边界的出入口）
 *
 * POST：一条 JSON-RPC 2.0 请求 → 一条 JSON-RPC 2.0 响应。协议层面的失败（未知方法、
 * 线程已回收、回合已在跑）都走信封里的 error，HTTP 一律 200 —— 宿主判错只看 result.error，
 * 不用同时伺候两套错误通道。只有鉴权/限流/请求体本身读不出来才用非 200。
 *
 * GET：这条线程的事件流（SSE，长连接）。回合从 turn/start 那一刻就不属于任何请求了，
 * 正文、卡片、审批、结束事件都从这里出去；宿主因此可以边跑边 turn/steer。
 * 存档仍然由宿主自己落：事件流只是展示，不是历史。
 */

import { jsonError, requireUser } from "../../../../lib/auth";
import { enforceRateLimit } from "../../../../lib/rate-limit";
import { attachThreadListener, handleAgentRpc } from "../../../../xiaoluo-brain/lib/brain/agent-server";
import { encodeSseComment, encodeSseFrame, RPC, type JsonRpcFailure } from "../../../../xiaoluo-brain/lib/brain/agent-wire";

/** 请求体上限：resume 会把整份历史交进来，留出余量但挡住失控的大 body */
const MAX_BODY_BYTES = 8_000_000;
/** 心跳间隔：小于常见反向代理 60s 空闲断连，保证长连接不被 nginx 掐掉 */
const HEARTBEAT_MS = 25_000;

const encoder = new TextEncoder();

export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    await enforceRateLimit({ subject: user.id, route: "brain:agent", max: 300, windowMs: 60_000 });
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) {
      const failure: JsonRpcFailure = {
        jsonrpc: "2.0",
        id: null,
        error: { code: RPC.INVALID_REQUEST, message: "请求体过大（上限 8MB），请分轮提交历史" },
      };
      return Response.json(failure);
    }
    let body: unknown;
    try {
      body = JSON.parse(raw) as unknown;
    } catch {
      const failure: JsonRpcFailure = { jsonrpc: "2.0", id: null, error: { code: RPC.PARSE_ERROR, message: "请求体不是合法 JSON" } };
      return Response.json(failure);
    }
    return Response.json(await handleAgentRpc(user.id, body));
  } catch (error) {
    return jsonError(error, "智能体内核调用失败");
  }
}

export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    const url = new URL(request.url);
    const conversationId = url.searchParams.get("conversationId")?.trim();
    if (!conversationId) {
      return Response.json({ error: "conversationId 必填" }, { status: 400 });
    }
    const since = Number(url.searchParams.get("since"));
    const afterSeq = Number.isFinite(since) && since > 0 ? since : 0;

    // 先挂监听再建流：中间这段窗口里到的事件先缓存，start() 里一次性补上，不丢帧
    const queued: string[] = [];
    let sink: ((frame: string) => void) | null = null;
    const subscription = attachThreadListener(user.id, conversationId, (event) => {
      const frame = encodeSseFrame(event);
      if (sink) sink(frame);
      else queued.push(frame);
    });
    if (!subscription) {
      return Response.json(
        { error: "线程不在服务里（还没 thread/start，或已闲置回收）。先起线程再连事件流。" },
        { status: 404 },
      );
    }

    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let closed = false;
    const detach = () => {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
      sink = null;
      subscription.detach();
    };

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const write = (frame: string) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(frame));
          } catch {
            /* 客户端已断开：本轮回合的事件没人收就算了，不能因此炸掉服务 */
            detach();
          }
        };
        sink = write;
        write(encodeSseComment("connected"));
        for (const event of subscription.replay) {
          if (event.seq > afterSeq) write(encodeSseFrame(event));
        }
        for (const frame of queued) write(frame);
        queued.length = 0;
        heartbeat = setInterval(() => write(encodeSseComment("ping")), HEARTBEAT_MS);
      },
      cancel() {
        detach();
      },
    });

    // 浏览器关掉标签页 / 老板按停止：fetch 的 signal 会 abort，这里负责收尾定时器
    request.signal.addEventListener("abort", detach, { once: true });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  } catch (error) {
    return jsonError(error, "事件流连接失败");
  }
}
