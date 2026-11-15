/**
 * 插件能力授权（P1-4）：把能力桥从「一律 ok:false」改成分级授权。
 *
 * 五类能力，默认全关；插件在 manifest 里声明、用户在插件卡片里逐项开启，
 * 运行时由服务端按授权 + 能力自身边界（路径围栏、主机白名单）双重校验。
 *
 * 这一层的原则：**授权 ≠ 无限**。授权只说明「这一类可以做」，
 * 具体每次调用仍要过围栏（fs 只能在本人工作区内、net 只能打白名单主机）。
 */

export const CAPABILITIES = [
  "fs.read",
  "fs.write",
  "net.fetch",
  "clipboard.read",
  "ui.notify",
  "shell.exec",
];

/** 可由服务端真实执行的能力（其余由客户端宿主决定，服务端只能拒并给指引） */
export const SERVER_EXECUTABLE = ["fs.read", "fs.write", "net.fetch"];

export const CAPABILITY_LABELS = {
  "fs.read": "读取工作区文件",
  "fs.write": "写入工作区文件",
  "net.fetch": "访问白名单网络",
  "clipboard.read": "读取剪贴板",
  "ui.notify": "界面提示",
  "shell.exec": "执行系统命令",
};

/** 每类能力开启后仍受什么约束，用于在前端说清「开了也只是有限」 */
export const CAPABILITY_SCOPE = {
  "fs.read": "仅限本人工作区内的路径，工作区外一律拒绝。",
  "fs.write": "仅限本人工作区内，单文件上限 512 KiB。",
  "net.fetch": "仅 GET，且目标主机必须在工作区 hooks.toml 的 network_allow 白名单里。",
  "clipboard.read": "需客户端宿主执行；服务端不代读剪贴板。",
  "ui.notify": "由宿主界面渲染；服务端不做展示。",
  "shell.exec": "不开放。要跑命令请走对话里的 run_command（受审批与沙箱管）。",
};

export function normalizeGrants(input) {
  if (!Array.isArray(input)) return [];
  return [...new Set(input.filter((item) => typeof item === "string" && CAPABILITIES.includes(item)))];
}

/**
 * 授权判定。返回 {allowed, reason, hint}：
 *  - 未声明 → 拒绝并给出「去哪开」的指引；
 *  - 声明了但服务端不能执行 → 拒绝并说明由谁执行。
 */
export function authorizeCapability(grants, capability) {
  if (!CAPABILITIES.includes(capability)) {
    return { allowed: false, reason: "未知能力：" + String(capability), hint: "可用能力：" + CAPABILITIES.join(" / ") };
  }
  const list = normalizeGrants(grants);
  if (!list.includes(capability)) {
    const where = "在插件设置里勾选「" + CAPABILITY_LABELS[capability] + "」（" + capability + "）后重试。";
    return {
      allowed: false,
      reason: "插件未获得「" + capability + "」授权。",
      hint: where + " " + (CAPABILITY_SCOPE[capability] ?? ""),
    };
  }
  if (!SERVER_EXECUTABLE.includes(capability)) {
    return {
      allowed: false,
      reason: "「" + capability + "」需要客户端宿主执行，服务端不代做。",
      hint: CAPABILITY_SCOPE[capability],
    };
  }
  return { allowed: true, reason: "", hint: CAPABILITY_SCOPE[capability] ?? "" };
}
