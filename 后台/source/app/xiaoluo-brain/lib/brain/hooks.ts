/**
 * 工作区 hooks.toml（第 2 项追平 Codex 的 hooks 事件面）
 *
 * Codex 的 hooks crate 覆盖 session_start / session_end / user_prompt_submit /
 * pre_tool_use / post_tool_use / permission_request / model_request / compact / interrupt / stop。
 * 小逻原来只有"工具前后"两个点，这里补上会话与提示词、权限请求四个事件，
 * 并允许规则声明 command（走既有命令闸门与四档审批）。
 *
 * 解析器刻意保持零依赖、坏行跳过的老规矩：hooks.toml 写坏了不能拖垮对话。
 */

export type HookEvent =
  | "pre"
  | "post"
  | "session_start"
  | "session_end"
  | "user_prompt_submit"
  | "permission_request";

export interface HookRule {
  /** 只对该工具生效（事件型钩子可不填） */
  tool?: string;
  /** 对上下文 JSON 做正则匹配，命中才跑 */
  match?: string;
  /** 拦截/拒绝时给模型看的原因 */
  message?: string;
  /** 事件点；缺省 = pre（工具前置拦截，老写法不变） */
  when?: string;
  command?: string;
}

export interface HookMatchContext {
  tool?: string;
  argsJson?: string;
  /** 事件型钩子的文本载荷（提示词 / 命令 / 结束原因） */
  text?: string;
}

const KNOWN_EVENTS: HookEvent[] = [
  "pre",
  "post",
  "session_start",
  "session_end",
  "user_prompt_submit",
  "permission_request",
];

/** 事件名归一：老写法（不写 when）默认 pre */
export function normalizeEvent(value: string | undefined): HookEvent | null {
  const raw = String(value ?? "").trim().toLowerCase().replace(/-/g, "_");
  if (!raw) return "pre";
  if (raw === "pretooluse" || raw === "pre_tool_use" || raw === "pre") return "pre";
  if (raw === "posttooluse" || raw === "post_tool_use" || raw === "post") return "post";
  if (raw === "session_start" || raw === "sessionstart") return "session_start";
  if (raw === "session_end" || raw === "sessionend") return "session_end";
  if (raw === "user_prompt_submit" || raw === "userpromptsubmit") return "user_prompt_submit";
  if (raw === "permission_request" || raw === "permissionrequest") return "permission_request";
  return null;
}

function unescape(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] === "\\" && i + 1 < value.length) {
      out += value[i + 1];
      i += 1;
    } else out += value[i];
  }
  return out;
}

/** [[hook]] 块 + key = "value" 的极简解析；坏行跳过，未知事件整条丢弃 */
export function parseHooks(raw: string): HookRule[] {
  const hooks: HookRule[] = [];
  let cur: HookRule | null = null;
  let broken = false;
  const flush = () => {
    if (cur && !broken) {
      const event = normalizeEvent(cur.when);
      // 没事件名、也没工具名/匹配条件的空块直接丢；未知事件名当场丢，别让它静默变成 pre
      if (event && (cur.tool || cur.match || cur.command)) {
        hooks.push({ ...cur, when: event });
      }
    }
    cur = null;
    broken = false;
  };

  for (const rawLine of raw.replace(/\r\n/g, "\n").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line === "[[hook]]") {
      flush();
      cur = {};
      continue;
    }
    if (line.startsWith("[")) {
      flush();
      continue;
    }
    if (!cur) continue;
    const m = /^(\w+)\s*=\s*"(.*)"\s*(?:#.*)?$/.exec(line);
    if (!m) continue;
    const key = m[1];
    if (!(key in { tool: 1, match: 1, message: 1, when: 1, command: 1 })) continue;
    const val = unescape(m[2]);
    // when 写了但认不出来：整条丢掉（宁可钩子静默不生效，也不要误当成 pre 拦住工具）
    if (key === "when" && !normalizeEvent(val)) broken = true;
    (cur as Record<string, string>)[key] = val;
  }
  flush();
  return hooks;
}

/** 规则是否命中本次事件 */
export function hookMatches(rule: HookRule, event: HookEvent, ctx: HookMatchContext = {}): boolean {
  if (!KNOWN_EVENTS.includes(event)) return false;
  if (normalizeEvent(rule.when) !== event) return false;
  if (rule.tool && rule.tool !== ctx.tool) return false;
  if (rule.match) {
    let re: RegExp;
    try {
      re = new RegExp(rule.match, "i");
    } catch {
      return false;
    }
    const haystack = [ctx.argsJson, ctx.text].filter(Boolean).join("\n");
    if (!re.test(haystack)) return false;
  }
  return true;
}

/** 命令模板替换：{command} {prompt} {tool} {path} {reason} */
export function fillCommand(template: string, vars: Record<string, string | undefined>): string {
  let out = template;
  for (const [key, value] of Object.entries(vars)) {
    out = out.split("{" + key + "}").join(value ?? "");
  }
  return out;
}
