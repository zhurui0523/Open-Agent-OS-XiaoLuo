import type { IntentGap, IntentPlan, PlanTask } from "../types";

const modalityPattern = /(文本|文案|脚本|文章|图片|图像|海报|视频|音频|文档|表格|PPT|演示)/i;
const audiencePattern = /(面向|受众|用户|客户|观众|人群|消费者|学生|企业|品牌|年龄)/i;
const videoPattern = /(视频|短片|广告片|预演|动画)/i;
const durationPattern = /(\d+\s*(秒|分钟|分)|时长|duration)/i;
const ratioPattern = /(16[:：]9|9[:：]16|1[:：]1|横版|竖版|方形|画幅|尺寸)/i;

export function detectIntentGaps(intent: string): IntentGap[] {
  const text = intent.trim();
  const gaps: IntentGap[] = [];
  if (!modalityPattern.test(text)) {
    gaps.push({
      id: "deliverable",
      field: "deliverable",
      question: "你希望最终交付什么形式的结果（文本、图片、视频、音频或文档）？",
      required: true,
    });
  }
  if (!audiencePattern.test(text) && text.length < 120) {
    gaps.push({
      id: "audience",
      field: "audience",
      question: "这个结果主要面向谁，或准备用在什么场景？",
      required: true,
    });
  }
  if (videoPattern.test(text) && !durationPattern.test(text)) {
    gaps.push({
      id: "duration",
      field: "duration",
      question: "视频目标时长是多少？",
      required: true,
    });
  }
  if (/(图片|图像|海报|视频|短片|动画)/i.test(text) && !ratioPattern.test(text)) {
    gaps.push({
      id: "format",
      field: "format",
      question: "画幅需要横版 16:9、竖版 9:16，还是其他尺寸？",
      required: false,
    });
  }
  return gaps.slice(0, 4);
}

export function formatGapQuestion(gaps: IntentGap[]) {
  const required = gaps.filter((gap) => gap.required);
  const optional = gaps.filter((gap) => !gap.required);
  const lines = [
    "在生成可执行计划前，我还需要确认：",
    ...required.map((gap, index) => `${index + 1}. ${gap.question}`),
  ];
  if (optional.length) {
    lines.push(
      ...optional.map(
        (gap, index) =>
          `${required.length + index + 1}. ${gap.question}（不指定将使用默认值）`,
      ),
    );
  }
  return lines.join("\n");
}

export function validateDependencyGraph(tasks: PlanTask[]) {
  const ids = new Set(tasks.map((task) => task.id));
  if (ids.size !== tasks.length) throw new Error("计划任务 ID 不能重复");
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(tasks.map((task) => [task.id, task]));
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) throw new Error(`任务 ${task.id} 引用了不存在的依赖 ${dependency}`);
      if (dependency === task.id) throw new Error(`任务 ${task.id} 不能依赖自身`);
    }
  }
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error("计划依赖图存在循环");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  tasks.forEach((task) => visit(task.id));
}

export function normalizeIntentPlan(
  value: unknown,
  fallbackGoal: string,
): IntentPlan {
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
          const kind =
            item.kind && ["text", "image", "video", "audio", "document"].includes(item.kind)
              ? item.kind
              : "text";
          return {
            id: item.id?.trim().slice(0, 120) || `plan_task_${index + 1}`,
            title,
            capability: item.capability?.trim().slice(0, 180) || "标准文本生成",
            duration: item.duration?.trim().slice(0, 80) || "待模型评估",
            kind,
            dependsOn: Array.isArray(item.dependsOn)
              ? [...new Set(item.dependsOn.map(String).map((id) => id.trim()).filter(Boolean))]
              : [],
            ...(item.parameters && typeof item.parameters === "object"
              ? { parameters: item.parameters }
              : {}),
          };
        })
        .filter((task): task is PlanTask => task !== null)
    : [];
  if (!tasks.length) throw new Error("计划中没有可执行任务");
  validateDependencyGraph(tasks);
  return {
    goal: input.goal?.trim().slice(0, 500) || fallbackGoal.slice(0, 500),
    tasks,
    estimate: input.estimate?.trim().slice(0, 120) || `${tasks.length} 个节点`,
    ...(input.warning?.trim() ? { warning: input.warning.trim().slice(0, 500) } : {}),
  };
}
