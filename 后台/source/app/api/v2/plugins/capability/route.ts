/**
 * 插件能力执行桥（P1-4）。
 *   GET  /api/v2/plugins/capability         -> 当前授权清单 + 能力目录
 *   PUT  /api/v2/plugins/capability         <- { capabilities: string[] } 用户逐项开启/关闭
 *   POST /api/v2/plugins/capability         <- { capability, args } 实际执行
 *
 * 两道门：先看「这一类有没有授权」，再看「这一次是不是越界」。
 * 授权打开也只是允许这一类，fs 仍锁在本人工作区、net 仍只打白名单主机。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { jsonError, requireUser } from "../../../../lib/auth";
import { isFeatureOn } from "../../../../lib/feature-flags";
import {
  brainWorkspaceRoot,
  readSandboxFile,
  readSandboxNetworkConfig,
  writeSandboxFile,
} from "../../../../lib/brain-sandbox";
import {
  CAPABILITIES,
  CAPABILITY_LABELS,
  CAPABILITY_SCOPE,
  authorizeCapability,
  normalizeGrants,
} from "../../../../../shared/plugin-capabilities.mjs";
import { isAllowlistedHost } from "../../../../../shared/command-policy.mjs";

const GRANTS_FILE = "plugin-grants.json";
const MAX_FETCH_BYTES = 512 * 1024;
const MAX_FETCH_TIMEOUT_MS = 15_000;

function grantsPath(userId: string): string {
  return path.join(brainWorkspaceRoot(userId), GRANTS_FILE);
}

async function readGrants(userId: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(grantsPath(userId), "utf8");
    return normalizeGrants((JSON.parse(raw) as { capabilities?: unknown }).capabilities);
  } catch {
    return [];
  }
}

async function writeGrants(userId: string, capabilities: string[]): Promise<string[]> {
  const file = grantsPath(userId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const grants = normalizeGrants(capabilities);
  await fs.writeFile(file, JSON.stringify({ capabilities: grants }, null, 2), "utf8");
  return grants;
}

export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    const grants = await readGrants(user.id);
    return Response.json({
      capabilities: CAPABILITIES.map((id) => ({
        id,
        label: (CAPABILITY_LABELS as Record<string, string>)[id],
        scope: (CAPABILITY_SCOPE as Record<string, string>)[id],
        granted: grants.includes(id),
      })),
    });
  } catch (error) {
    return jsonError(error, "读取插件能力授权失败");
  }
}

export async function PUT(request: Request) {
  try {
    const user = await requireUser(request);
    const body = (await request.json().catch(() => null)) as { capabilities?: unknown } | null;
    const requested = normalizeGrants(body?.capabilities);
    const grants = await writeGrants(user.id, requested);
    return Response.json({ ok: true, capabilities: grants });
  } catch (error) {
    return jsonError(error, "保存插件能力授权失败");
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    // 止损开关（P2-6 收尾）：能力桥出问题时用 XIAOLUO_FLAGS=-plugin.capability.bridge 一键关掉
    if (!(await isFeatureOn("plugin.capability.bridge", brainWorkspaceRoot(user.id)))) {
      return Response.json(
        {
          ok: false,
          error: "插件能力桥已被 feature flag 关闭。",
          hint: "去掉 XIAOLUO_FLAGS 里的 -plugin.capability.bridge（或改成 =true）后重试。",
        },
        { status: 403 },
      );
    }
    const body = (await request.json().catch(() => null)) as
      | { capability?: unknown; args?: unknown }
      | null;
    const capability = typeof body?.capability === "string" ? body.capability : "";
    const args = (body?.args ?? {}) as Record<string, unknown>;

    const decision = authorizeCapability(await readGrants(user.id), capability);
    if (!decision.allowed) {
      return Response.json({ ok: false, error: decision.reason, hint: decision.hint }, { status: 403 });
    }

    if (capability === "fs.read") {
      const target = String(args.path ?? "").trim();
      if (!target) return Response.json({ ok: false, error: "缺少 path" }, { status: 400 });
      try {
        const result = await readSandboxFile(user.id, target);
        return Response.json({ ok: true, content: result.content, truncated: result.truncated, totalLines: result.totalLines });
      } catch (error) {
        // 围栏拒绝（工作区外）按 403 回，别让插件以为是文件不存在
        const message = String((error as Error)?.message ?? error);
        return Response.json({ ok: false, error: message, hint: "插件只能读本人工作区内的文件。" }, { status: 403 });
      }
    }

    if (capability === "fs.write") {
      const target = String(args.path ?? "").trim();
      const content = typeof args.content === "string" ? args.content : null;
      if (!target || content === null) {
        return Response.json({ ok: false, error: "缺少 path 或 content" }, { status: 400 });
      }
      try {
        await writeSandboxFile(user.id, target, content, undefined, "default");
        return Response.json({ ok: true });
      } catch (error) {
        const message = String((error as Error)?.message ?? error);
        return Response.json({ ok: false, error: message, hint: "插件只能写本人工作区内的文件。" }, { status: 403 });
      }
    }

    if (capability === "net.fetch") {
      const rawUrl = String(args.url ?? "").trim();
      let parsed: URL;
      try {
        parsed = new URL(rawUrl);
      } catch {
        return Response.json({ ok: false, error: "url 非法" }, { status: 400 });
      }
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        return Response.json({ ok: false, error: "只允许 http/https" }, { status: 400 });
      }
      const { allowHosts } = await readSandboxNetworkConfig(user.id);
      if (!isAllowlistedHost(parsed.hostname, allowHosts)) {
        return Response.json(
          {
            ok: false,
            error: `主机 ${parsed.hostname} 不在白名单内`,
            hint: "把主机加进工作区 hooks.toml 的 network_allow，再重试。",
          },
          { status: 403 },
        );
      }
      const response = await fetch(parsed.href, {
        method: "GET",
        signal: AbortSignal.timeout(MAX_FETCH_TIMEOUT_MS),
        headers: { accept: "text/plain, application/json, text/html" },
      });
      const text = (await response.text()).slice(0, MAX_FETCH_BYTES);
      return Response.json({ ok: response.ok, status: response.status, content: text });
    }

    return Response.json({ ok: false, error: "服务端不执行的 capacity" }, { status: 403 });
  } catch (error) {
    return jsonError(error, "插件能力执行失败");
  }
}
