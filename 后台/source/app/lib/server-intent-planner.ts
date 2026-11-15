import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../db";
import { modelConnections } from "../../db/schema";
import { createIntentPlan } from "./intent-plan";
import { normalizeIntentPlan } from "./intent-analysis";
import { executeModel } from "./kernel-executors";

function jsonObject(text: string) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? text;
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Planner 未返回 JSON");
  return JSON.parse(fenced.slice(start, end + 1)) as unknown;
}

export async function planIntent(workspaceId: string, intent: string) {
  const db = await getDb();
  const [model] = await db
    .select()
    .from(modelConnections)
    .where(
      and(
        eq(modelConnections.workspaceId, workspaceId),
        eq(modelConnections.enabled, true),
        eq(modelConnections.state, "healthy"),
      ),
    )
    .orderBy(desc(modelConnections.updatedAt))
    .limit(1);
  if (!model) {
    return { plan: createIntentPlan(intent), planner: "kernel.fallback-planner" };
  }

  try {
    const result = await executeModel(
      model,
      {
        id: "intent_planner",
        title: "把用户目标规划为可编辑 DAG",
        prompt: [
          "只返回 JSON，不要 Markdown。",
          '结构：{"goal":"string","estimate":"string","warning":"string","tasks":[{"id":"string","title":"string","capability":"string","kind":"text|image|video|audio|document","duration":"string","dependsOn":["上游任务ID"],"parameters":{}}]}',
          "任务数量 1 到 12。用 dependsOn 构造真实无环依赖图；可以并行的任务不要强行串行。",
          `用户目标：${intent}`,
        ].join("\n"),
        kind: "text",
        capabilityId: "system.intent-planner",
        modelId: model.id,
      },
      [],
    );
    const text = result.output.text ?? result.result;
    return {
      plan: normalizeIntentPlan(jsonObject(text), intent),
      planner: `model:${model.id}`,
    };
  } catch {
    return { plan: createIntentPlan(intent), planner: "kernel.fallback-planner" };
  }
}
