/**
 * 统一配置层（P2-6）。
 *
 * 目标：同一份配置在三端解析结果一致；每项都能回答「这个值从哪来的」。
 * 分层优先级（后者覆盖前者）：Default < User < Workspace < Project < Env。
 * 非法值不抛错、不崩：退回默认并在 warnings 里留一条，方便界面上直接显示"你填的这个没生效，为何"。
 *
 * 只放纯函数，不做 IO：读文件、读 env 由调用方组装 layers 后传进来。
 */

/** 配置项定义：类型、默认值、取值范围、人类可读说明 */
export const CONFIG_SCHEMA = [
  {
    key: "agent.maxStepsPerTurn",
    type: "number",
    default: 40,
    min: 1,
    max: 200,
    describe: "单轮工具步数上限（到顶走软收尾，可一句话续跑）",
  },
  { key: "agent.tokenBudgetSoft", type: "number", default: 120000, min: 10000, max: 2000000, describe: "单轮 token 软顶（超了注入收尾提醒）" },
  { key: "agent.tokenBudgetHard", type: "number", default: 200000, min: 20000, max: 4000000, describe: "单轮 token 硬顶（安全阀压缩用尽才收尾）" },
  { key: "agent.contextBudget", type: "number", default: 140000, min: 10000, max: 4000000, describe: "上下文窗口预算（压缩与百分比口径的分母）" },
  { key: "agent.maxCompactsPerTurn", type: "number", default: 3, min: 1, max: 20, describe: "单轮最多压缩次数" },
  {
    key: "agent.compactAtContextPct",
    type: "number",
    default: 80,
    min: 40,
    max: 100,
    describe: "上下文用到多少百分比就触发压缩（100 = 撑满才压）",
  },
  { key: "agent.maxToolResultChars", type: "number", default: 4000, min: 500, max: 64000, describe: "工具结果回流历史的最大字符数" },
  { key: "agent.turnWallClockSoftMs", type: "number", default: 10 * 60 * 1000, min: 60_000, max: 3_600_000, describe: "整轮墙钟软闸（毫秒）" },
  { key: "agent.turnWallClockHardMs", type: "number", default: 25 * 60 * 1000, min: 60_000, max: 7_200_000, describe: "整轮墙钟硬闸（毫秒）" },
  {
    key: "security.approvalMode",
    type: "enum",
    enum: ["never", "on-request", "unless-trusted", "granular"],
    default: "on-request",
    describe: "审批档位",
  },
  {
    key: "security.networkDefault",
    type: "enum",
    enum: ["open", "loopback", "block"],
    default: "open",
    describe: "工作区网络默认档（新工作区播种 loopback）",
  },
  {
    key: "security.winMic",
    type: "enum",
    enum: ["auto", "on", "off"],
    default: "auto",
    describe: "Windows MIC 低完整性沙箱三态",
  },
  { key: "workspace.root", type: "string", default: "", min: 0, max: 512, describe: "工作区根（空 = 用宿主默认）" },
];

/** 环境变量 → 配置键的显式映射（避免"猜变量名"） */
export const ENV_MAP = {
  XIAOLUO_APPROVAL_MODE: "security.approvalMode",
  XIAOLUO_SANDBOX_NETWORK_DEFAULT: "security.networkDefault",
  XIAOLUO_SANDBOX_WIN_MIC: "security.winMic",
  XIAOLUO_WORKSPACE_ROOT: "workspace.root",
  XIAOLUO_MAX_STEPS_PER_TURN: "agent.maxStepsPerTurn",
  XIAOLUO_TOKEN_BUDGET_SOFT: "agent.tokenBudgetSoft",
  XIAOLUO_TOKEN_BUDGET_HARD: "agent.tokenBudgetHard",
  XIAOLUO_CONTEXT_BUDGET: "agent.contextBudget",
};

export const LAYER_ORDER = ["default", "user", "workspace", "project", "env"];

/** 默认值表（由 schema 生成，不手写第二份） */
export function defaultConfig() {
  const out = {};
  for (const spec of CONFIG_SCHEMA) out[spec.key] = spec.default;
  return out;
}

function findSpec(key) {
  return CONFIG_SCHEMA.find((spec) => spec.key === key) ?? null;
}

/** 单值校验：返回 {ok, value, note}；类型不对/超范围一律退回默认 */
export function validateValue(key, raw) {
  const spec = findSpec(key);
  if (!spec) return { ok: false, value: undefined, note: "未知配置项：" + key };
  if (spec.type === "number") {
    const num = typeof raw === "number" ? raw : Number(String(raw ?? "").trim());
    if (!Number.isFinite(num)) return { ok: false, value: spec.default, note: key + " 不是数字，已退回默认 " + spec.default };
    if (num < spec.min || num > spec.max) {
      return { ok: false, value: spec.default, note: key + " 超出范围 [" + spec.min + ", " + spec.max + "]，已退回默认 " + spec.default };
    }
    return { ok: true, value: Math.trunc(num), note: "" };
  }
  if (spec.type === "enum") {
    const text = String(raw ?? "").trim();
    if (!spec.enum.includes(text)) {
      return { ok: false, value: spec.default, note: key + " 只接受 " + spec.enum.join(" / ") + "，已退回默认 " + spec.default };
    }
    return { ok: true, value: text, note: "" };
  }
  // string
  const text = String(raw ?? "");
  if (spec.max && text.length > spec.max) {
    return { ok: false, value: spec.default, note: key + " 过长（上限 " + spec.max + " 字符）" };
  }
  return { ok: true, value: text, note: "" };
}

/**
 * 分层解析。
 * layers: { default?: object, user?: object, workspace?: object, project?: object, env?: object }
 * env 传的是「已按 ENV_MAP 映射后的键值」，不是原始 process.env。
 */
export function resolveConfig(layers = {}) {
  const values = defaultConfig();
  const sources = {};
  const warnings = [];
  for (const spec of CONFIG_SCHEMA) sources[spec.key] = "default";

  for (const layer of LAYER_ORDER) {
    if (layer === "default") continue; // 默认值已铺好
    const raw = layers[layer];
    if (!raw || typeof raw !== "object") continue;
    for (const [key, value] of Object.entries(raw)) {
      if (value === undefined || value === null || value === "") continue;
      if (!findSpec(key)) {
        warnings.push(layer + " 层有未知配置项 " + key + "，已忽略");
        continue;
      }
      const verdict = validateValue(key, value);
      if (!verdict.ok) {
        warnings.push(layer + " 层：" + verdict.note);
        // 非法值不覆盖：让上一层的有效值继续生效，避免"填错反而改了行为"
        continue;
      }
      values[key] = verdict.value;
      sources[key] = layer;
    }
  }
  return { values, sources, warnings };
}

/** 把 process.env 按 ENV_MAP 映射成 env 层（只取映射表里有的键） */
export function envLayer(env = {}) {
  const out = {};
  for (const [envKey, configKey] of Object.entries(ENV_MAP)) {
    const value = env[envKey];
    if (value === undefined || value === "") continue;
    out[configKey] = value;
  }
  return out;
}

/**
 * feature flag（P2-6 灰度）：默认全关，只有显式开启才算开。
 * 来源：env `XIAOLUO_FLAGS=a,b` 或配置文件 features 段 `{ "a": true }`。
 */
export function parseFlags(raw) {
  const out = {};
  const text = String(raw ?? "").trim();
  if (!text) return out;
  for (const item of text.split(/[,\s]+/)) {
    const token = item.trim();
    if (!token) continue;
    const eq = token.indexOf("=");
    if (eq > 0) {
      // name=false / name=0 / name=off 都是关；其余非空值为开
      const name = token.slice(0, eq).trim();
      const value = token.slice(eq + 1).trim().toLowerCase();
      if (!name) continue;
      out[name] = !(value === "false" || value === "0" || value === "off" || value === "no");
      continue;
    }
    const negative = token.startsWith("-") || token.startsWith("!");
    const name = negative ? token.slice(1) : token;
    if (!name) continue;
    out[name] = !negative;
  }
  return out;
}

export function resolveFlags(layers = {}) {
  const flags = {};
  const sources = {};
  // 先文件后 env：env 是运维临时开关，优先
  for (const layer of ["user", "workspace", "project"]) {
    const raw = layers[layer]?.features;
    if (!raw || typeof raw !== "object") continue;
    for (const [name, value] of Object.entries(raw)) {
      flags[name] = Boolean(value);
      sources[name] = layer;
    }
  }
  const envFlags = parseFlags(layers.envRaw);
  for (const [name, value] of Object.entries(envFlags)) {
    flags[name] = value;
    sources[name] = "env";
  }
  return { flags, sources };
}

export function isFeatureEnabled(resolvedFlags, name) {
  return Boolean(resolvedFlags?.flags?.[name]);
}

/**
 * flag 判定（含"已上线功能默认开、但仍能一键关掉"的场景）：
 * - defaultOn 里的功能：没显式配置就按开（env 传 false 即刻回滚）；
 * - 其余：没显式配置按关（新功能默认关，先灰度）。
 */
export const DEFAULT_ON_FLAGS = ["plugin.capability.bridge"];

export function flagEnabled(resolvedFlags, name, defaultOn = []) {
  const flags = resolvedFlags?.flags ?? {};
  if (Object.prototype.hasOwnProperty.call(flags, name)) return Boolean(flags[name]);
  return defaultOn.includes(name);
}
