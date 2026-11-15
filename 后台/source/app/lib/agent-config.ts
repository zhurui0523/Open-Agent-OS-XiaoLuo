/**
 * 配置装配（P2-6）：把磁盘上的三层 + env 组装成 shared/agent-config.mjs 认的 layers。
 *
 * 只有这一处做 IO，判定全在 shared 里做——三端（服务端 / 桌面 / CLI）用同一份 schema，
 * 差别只在"文件在哪"，不在"谁说了算"。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { envLayer, resolveConfig, resolveFlags } from "../../shared/agent-config.mjs";

export interface ResolvedConfigView {
  values: Record<string, unknown>;
  sources: Record<string, string>;
  warnings: string[];
  flags: Record<string, boolean>;
  flagSources: Record<string, string>;
}

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null; // 不存在或坏 JSON 都当"这一层没说话"，不让坏配置把启动弄挂
  }
}

/** 三层文件位置；workspaceRoot 由调用方给出（已按用户解析过） */
export async function loadConfigLayers(workspaceRoot: string) {
  const userFile = path.join(os.homedir(), ".xiaoluo", "config.json");
  const workspaceFile = path.join(workspaceRoot, "agent-config.json");
  const projectFile = path.join(process.cwd(), "agent.config.json");
  const [user, workspace, project] = await Promise.all([
    readJson(userFile),
    readJson(workspaceFile),
    readJson(projectFile),
  ]);
  return {
    files: { user: userFile, workspace: workspaceFile, project: projectFile },
    user,
    workspace,
    project,
  };
}

export async function resolveRuntimeConfig(workspaceRoot: string): Promise<ResolvedConfigView> {
  const layers = await loadConfigLayers(workspaceRoot);
  const env = envLayer(process.env as Record<string, string | undefined>);
  const resolved = resolveConfig({
    user: layers.user ?? undefined,
    workspace: layers.workspace ?? undefined,
    project: layers.project ?? undefined,
    env,
  });
  const flags = resolveFlags({
    user: layers.user ?? undefined,
    workspace: layers.workspace ?? undefined,
    project: layers.project ?? undefined,
    envRaw: process.env.XIAOLUO_FLAGS,
  });
  return {
    values: resolved.values as Record<string, unknown>,
    sources: resolved.sources as Record<string, string>,
    warnings: resolved.warnings as string[],
    flags: flags.flags as Record<string, boolean>,
    flagSources: flags.sources as Record<string, string>,
  };
}

/** 只写 workspace 层：用户级/项目级文件不归接口管，避免越权改到别人机器上的配置 */
export async function saveWorkspaceConfig(
  workspaceRoot: string,
  patch: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const file = path.join(workspaceRoot, "agent-config.json");
  const current = (await readJson(file)) ?? {};
  const next = { ...current, ...patch };
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(next, null, 2), "utf8");
  return next;
}
