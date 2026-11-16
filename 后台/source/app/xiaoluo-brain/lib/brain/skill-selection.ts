/**
 * 技能隐式调用识别（第 7.6 项，学 Codex `skills/src/{invocation,mentions,selection}.rs`）
 *
 * 小逻原来只有"技能库目录 + 模型自己想起来 load_skill"。这里补一层确定性匹配：
 * 每轮开始把老板原话和技能名/描述做一次廉价打分，命中就在系统消息里点名，
 * 让模型"看到该用哪个技能"，而不是靠运气。
 *
 * 边界：这是提示级引导，不是硬激活——是否 load_skill 仍由模型判断；
 *       打分只看名字/描述/显式提及，不读 SKILL.md 正文。
 */

export interface SkillEntry {
  name: string;
  description: string;
}

export interface SkillMatch {
  name: string;
  description: string;
  score: number;
  /** 命中原因，便于排查"为什么推荐了这个" */
  reason: string;
}

/** 能力清单里的技能行形如：`- kebab-name | skill | 描述`；其它行忽略 */
export function parseSkillCatalog(catalogText: string): SkillEntry[] {
  const out: SkillEntry[] = [];
  for (const line of String(catalogText ?? "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("- ")) continue;
    const parts = trimmed.slice(2).split("|").map((p) => p.trim());
    if (parts.length < 3 || parts[1] !== "skill") continue;
    const name = parts[0];
    if (!name) continue;
    out.push({ name, description: parts.slice(2).join(" | ") });
  }
  return out;
}

const CJK = /[\u4e00-\u9fff]/;

/** 把描述拆成可匹配的词元：英文/数字按词，中文按二元组（中文没有空格，二元组足够识别主题） */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const chunk of String(text ?? "").toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/)) {
    if (!chunk) continue;
    if (!CJK.test(chunk)) {
      if (chunk.length >= 3) tokens.push(chunk);
      continue;
    }
    // 中英混排：先把拉丁段抽出来，再对中文段做二元组
    for (const latin of chunk.match(/[a-z0-9]+/g) ?? []) {
      if (latin.length >= 3) tokens.push(latin);
    }
    const cjk = chunk.replace(/[a-z0-9]+/g, " ");
    for (const seg of cjk.split(/\s+/)) {
      const chars = Array.from(seg);
      if (chars.length === 2) tokens.push(seg);
      for (let i = 0; i + 1 < chars.length; i += 1) tokens.push(chars[i] + chars[i + 1]);
    }
  }
  return [...new Set(tokens)];
}

const STOP_TOKENS = new Set([
  "the", "and", "for", "with", "this", "that", "from", "into", "you", "your", "use", "when",
  "一个", "可以", "使用", "进行", "通过", "以及", "包括", "用于", "支持", "相关", "需要", "如果",
]);

/**
 * 选技能：显式点名 > 技能名出现在原话里 > 描述词元命中数。
 * 只有分数过阈值才返回，避免"每轮都推一堆技能"把提示词噪声化。
 */
export function selectSkills(catalogText: string, userText: string, limit = 2): SkillMatch[] {
  const text = String(userText ?? "");
  if (!text.trim()) return [];
  const lowerText = text.toLowerCase();
  const userTokens = new Set(tokenize(text).filter((t) => !STOP_TOKENS.has(t)));
  const matches: SkillMatch[] = [];

  for (const skill of parseSkillCatalog(catalogText)) {
    const name = skill.name;
    let best: SkillMatch | null = null;

    // 1) 显式提及：/name、@name、name 原样出现
    const explicit = new RegExp("(^|[^a-z0-9_-])(?:/|@)?" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "($|[^a-z0-9_-])", "i");
    if (explicit.test(text)) {
      best = { name, description: skill.description, score: 100, reason: "原话点名了技能" };
    } else if (lowerText.includes(name.toLowerCase())) {
      best = { name, description: skill.description, score: 70, reason: "原话含技能名" };
    }

    // 2) 描述词元重叠：按命中比例给分，长描述不该天然占优
    const descTokens = tokenize(skill.description).filter((t) => !STOP_TOKENS.has(t));
    if (descTokens.length) {
      const hits = descTokens.filter((t) => userTokens.has(t));
      const ratio = hits.length / Math.min(descTokens.length, 12);
      const score = Math.round(Math.min(60, ratio * 60));
      if (score >= 8) {
        if (!best || best.score < score) {
          best = { name, description: skill.description, score, reason: "描述关键词命中：" + hits.slice(0, 4).join("、") };
        }
      }
    }

    if (best && best.score >= 8) matches.push(best);
  }

  matches.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return matches.slice(0, Math.max(1, limit));
}

/** 拼成注入用的系统消息正文；没有命中返回空串（调用方据此决定是否注入） */
export function buildSkillHint(matches: SkillMatch[]): string {
  if (!matches.length) return "";
  const lines = matches.map((m) => "- " + m.name + "（" + m.reason + "）：" + m.description.slice(0, 120));
  return (
    "[技能提示] 本轮任务可能与下列技能相关，先 load_skill 读正文再做；不相关就别硬套：\n" +
    lines.join("\n")
  );
}
