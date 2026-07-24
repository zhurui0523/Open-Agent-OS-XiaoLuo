import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../db";
import { modelConnections } from "../../db/schema";
import type { IntentPlan, PlanTask } from "../types";
import { createIntentPlan } from "./intent-plan";
import { executeModel } from "./kernel-executors";

function jsonObject(text: string) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? text;
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Planner 未返回 JSON");
  return JSON.parse(fenced.slice(start, end + 1)) as unknown;
}

function validatePlan(value: unknown, fallbackGoal: string): IntentPlan {
  if (!value || typeof value !== "object") throw new Error("计划格式无效");
  const input = value as Partial<IntentPlan>;
  const tasks = Array.isArray(input.tasks)
    ? input.tasks
        .slice(0, 12)
        .map((task, index): PlanTask | null => {
          if (!task || typeof task !== "object") return null;
          const item = task as Partial<PlanTask>;
          const title = item.title?.trim().slice(0, 180);
          if (!title) return null;
          return {
            id: item.id?.trim().slice(0, 120) || `plan_task_${index + 1}`,
            title,
            capability:
              item.capability?.trim().slice(0, 180) || "标准文本生成",
            duration: item.duration?.trim().slice(0, 80) || "待模型评估",
          };
        })
        .filter((task): task is PlanTask => task !== null)
    : [];
  if (!tasks.length) throw new Error("计划中没有可执行任务");
  return {
    goal: input.goal?.trim().slice(0, 500) || fallbackGoal.slice(0, 500),
    tasks,
    estimate: input.estimate?.trim().slice(0, 120) || `${tasks.length} 个节点`,
    ...(input.warning?.trim()
      ? { warning: input.warning.trim().slice(0, 500) }
      : {}),
  };
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
          '结构：{"goal":"string","estimate":"string","warning":"string","tasks":[{"id":"string","title":"string","capability":"标准文本生成|标准图像生成|标准视频生成","duration":"string"}]}',
          "任务数量 1 到 12。任务必须能按顺序组成无环工作流。",
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
      plan: validatePlan(jsonObject(text), intent),
      planner: `model:${model.id}`,
    };
  } catch {
    return { plan: createIntentPlan(intent), planner: "kernel.fallback-planner" };
  }
}
