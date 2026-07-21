import type { IntentPlan } from "../types";

export const messageTime = () =>
  new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date());

export const createIntentPlan = (intent: string): IntentPlan => ({
  goal: intent.length > 42 ? `${intent.slice(0, 42)}…` : intent,
  estimate: "预计 4 个节点 · 约 6–9 分钟",
  warning: "视频节点需要在执行前确认画幅与时长。",
  tasks: [
    {
      id: "plan_research",
      title: "提炼创作目标与受众洞察",
      capability: "标准文本生成",
      duration: "约 45 秒",
    },
    {
      id: "plan_script",
      title: "生成结构化脚本与镜头节拍",
      capability: "标准文本生成",
      duration: "约 1 分钟",
    },
    {
      id: "plan_visual",
      title: "设计关键帧视觉方向",
      capability: "标准图像生成",
      duration: "约 2 分钟",
    },
    {
      id: "plan_video",
      title: "生成动态预演并沉淀资产",
      capability: "标准视频生成",
      duration: "约 3–6 分钟",
    },
  ],
});

