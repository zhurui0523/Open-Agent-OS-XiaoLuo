/**
 * 配置治理接口（P2-6）。
 *   GET  /api/v2/config  -> 解析后的配置 + 每项的来源层 + 告警 + feature flags + schema
 *   PUT  /api/v2/config  <- 只写 workspace 层（用户/项目层文件不归接口管）
 *
 * 返回值里 values 与 sources 成对出现：界面能直接显示"这个生效值来自哪一层"，
 * 而不是像以前那样让人对着 .env.local 猜。
 */
import { jsonError, requireUser } from "../../../lib/auth";
import { brainWorkspaceRoot } from "../../../lib/brain-sandbox";
import { resolveRuntimeConfig, saveWorkspaceConfig } from "../../../lib/agent-config";
import { CONFIG_SCHEMA } from "../../../../shared/agent-config.mjs";

export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    const view = await resolveRuntimeConfig(brainWorkspaceRoot(user.id));
    return Response.json({
      values: view.values,
      sources: view.sources,
      warnings: view.warnings,
      flags: view.flags,
      flagSources: view.flagSources,
      schema: CONFIG_SCHEMA,
    });
  } catch (error) {
    return jsonError(error, "读取配置失败");
  }
}

export async function PUT(request: Request) {
  try {
    const user = await requireUser(request);
    const body = (await request.json().catch(() => null)) as
      | { values?: unknown; features?: unknown }
      | null;
    if (!body || typeof body !== "object") {
      return Response.json({ ok: false, error: "请求体需要 { values, features }" }, { status: 400 });
    }
    const patch: Record<string, unknown> = {};
    if (body.values && typeof body.values === "object") patch.values = body.values;
    if (body.features && typeof body.features === "object") patch.features = body.features;
    // 层文件是扁平键表：values 直接铺在顶层，features 单独一段
    const flattened: Record<string, unknown> = {
      ...(body.values && typeof body.values === "object" ? (body.values as Record<string, unknown>) : {}),
    };
    if (body.features && typeof body.features === "object") {
      flattened.features = body.features as Record<string, unknown>;
    }
    if (!Object.keys(flattened).length) {
      return Response.json({ ok: false, error: "没有要保存的配置项" }, { status: 400 });
    }
    const saved = await saveWorkspaceConfig(brainWorkspaceRoot(user.id), flattened);
    const view = await resolveRuntimeConfig(brainWorkspaceRoot(user.id));
    return Response.json({ ok: true, saved, values: view.values, sources: view.sources, warnings: view.warnings });
  } catch (error) {
    return jsonError(error, "保存配置失败");
  }
}
