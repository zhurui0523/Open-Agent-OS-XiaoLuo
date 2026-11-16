/**
 * 多 Agent 组织（第 7.10 A 档，学 Codex 的 agent-roles / message-board）
 *
 * 只做"够用"的一层：子 Agent 派发时带**角色**（研究员/实现者/审查者），
 * 并把派发与回填记到一块**协作板**（谁领了什么、结果是什么），让父线程一眼看到分工。
 *
 * 明确不做：角色间投票/辩论、跨进程 Agent 身份、持久化图数据库（Codex 的 agent-graph-store）。
 * 协作板只活在当前对话实例内，随本轮工具结果回流到模型；对话重启不保留。
 */

export type AgentRoleId = "coordinator" | "researcher" | "coder" | "reviewer";

export interface AgentRole {
  id: AgentRoleId;
  label: string;
  /** 写进子 Agent 系统提示词的角色约束 */
  prompt: string;
  /** 该角色默认是否允许写盘（实际还要宿主开写权限） */
  writeByDefault: boolean;
}

export const AGENT_ROLES: Record<AgentRoleId, AgentRole> = {
  coordinator: {
    id: "coordinator",
    label: "协调者",
    prompt: "你是协调者：只拆任务、判优先级、汇总结论，不亲自查细节。",
    writeByDefault: false,
  },
  researcher: {
    id: "researcher",
    label: "研究员",
    prompt: "你是研究员：把事实查清并给出处，不改文件、不跑命令，结论优先。",
    writeByDefault: false,
  },
  coder: {
    id: "coder",
    label: "实现者",
    prompt: "你是实现者：只改任务点名的位置，改动前先读上下文，改完说明改了什么、怎么验证。",
    writeByDefault: true,
  },
  reviewer: {
    id: "reviewer",
    label: "审查者",
    prompt: "你是审查者：找问题而不是改代码——指出风险、遗漏与反例，每条附文件与行号。",
    writeByDefault: false,
  },
};

/** 显式 role 优先；否则按任务措辞猜一个（猜错也只影响提示词，不影响权限） */
export function resolveAgentRole(raw: unknown, task: string): AgentRole {
  const explicit = String(raw ?? "").trim() as AgentRoleId;
  if (explicit && AGENT_ROLES[explicit]) return AGENT_ROLES[explicit];
  if (/审查|review|复核|找问题|风险/.test(task)) return AGENT_ROLES.reviewer;
  if (/实现|修改|改成|修复|写(?!清)|重构|implement|fix/i.test(task) && !/只读|不要改/.test(task)) return AGENT_ROLES.coder;
  if (/汇总|协调|拆任务|排期/.test(task)) return AGENT_ROLES.coordinator;
  return AGENT_ROLES.researcher;
}

export interface BoardMessage {
  id: string;
  at: number;
  from: AgentRoleId;
  kind: "assign" | "result";
  text: string;
}

export interface BoardNode {
  id: string;
  role: AgentRoleId;
  task: string;
  status: "running" | "done" | "failed";
  startedAt: number;
  endedAt?: number;
}

const MAX_MESSAGES = 60;
const MAX_NODES = 30;
const TEXT_CAP = 120;

let seq = 0;

/** 一轮对话内的协作板：只记分工与结果摘要，不记消息全文 */
export class AgentBoard {
  private messages: BoardMessage[] = [];
  private nodes: BoardNode[] = [];

  assign(role: AgentRoleId, task: string): string {
    seq += 1;
    const id = "a" + seq;
    const text = task.replace(/\s+/g, " ").trim().slice(0, TEXT_CAP);
    this.nodes.push({ id, role, task: text, status: "running", startedAt: Date.now() });
    if (this.nodes.length > MAX_NODES) this.nodes.shift();
    this.push({ from: role, kind: "assign", text });
    return id;
  }

  complete(nodeId: string, summary: string, failed = false): void {
    const node = this.nodes.find((n) => n.id === nodeId);
    if (node) {
      node.status = failed ? "failed" : "done";
      node.endedAt = Date.now();
    }
    this.push({ from: node?.role ?? "researcher", kind: "result", text: summary.replace(/\s+/g, " ").trim().slice(0, TEXT_CAP) });
  }

  /** 回流给模型的紧凑视图（最多 8 行，避免挤占上下文） */
  view(limit = 8): string {
    const recent = this.messages.slice(-limit);
    if (recent.length === 0) return "";
    return recent.map((m) => `- ${AGENT_ROLES[m.from].label} ${m.kind === "assign" ? "领任务" : "回结果"}：${m.text}`).join("\n");
  }

  snapshot(): { nodes: BoardNode[]; messages: BoardMessage[] } {
    return { nodes: [...this.nodes], messages: [...this.messages] };
  }

  private push(msg: Omit<BoardMessage, "id" | "at">): void {
    seq += 1;
    this.messages.push({ ...msg, id: "m" + seq, at: Date.now() });
    if (this.messages.length > MAX_MESSAGES) this.messages.shift();
  }
}
