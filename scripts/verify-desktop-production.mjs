import { readFile, access } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const configPath = path.join(root, "desktop", "config.production.json");
const packagePath = path.join(root, "desktop", "package.json");

const requiredDesktopFiles = [
  "desktop/main.mjs",
  "desktop/preload.cjs",
  "desktop/loading.html",
  "desktop/config.production.json",
  "desktop/assets/xiaoluo.ico",
  "desktop/assets/xiaoluo.png",
  "desktop/package.json",
];

const errors = [];

for (const relativePath of requiredDesktopFiles) {
  try {
    await access(path.join(root, relativePath));
  } catch {
    errors.push(`缺少桌面端文件：${relativePath}`);
  }
}

let config;
let packageJson;

try {
  config = JSON.parse(await readFile(configPath, "utf8"));
} catch (error) {
  errors.push(`生产配置不是有效 JSON：${error.message}`);
}

try {
  packageJson = JSON.parse(await readFile(packagePath, "utf8"));
} catch (error) {
  errors.push(`package.json 不是有效 JSON：${error.message}`);
}

if (config) {
  const allowedKeys = new Set(["appUrl", "healthPath"]);
  const unknownKeys = Object.keys(config).filter((key) => !allowedKeys.has(key));

  if (unknownKeys.length > 0) {
    errors.push(`生产配置包含不允许发布的字段：${unknownKeys.join(", ")}`);
  }

  try {
    const appUrl = new URL(config.appUrl);
    if (appUrl.protocol !== "https:") {
      errors.push("正式安装版地址必须使用 HTTPS");
    }
    if (["localhost", "127.0.0.1", "::1"].includes(appUrl.hostname)) {
      errors.push("正式安装版不能连接本机地址");
    }
    if (appUrl.username || appUrl.password) {
      errors.push("正式安装版地址不能内嵌账号或密码");
    }
  } catch {
    errors.push("正式安装版 appUrl 无效");
  }

  if (
    typeof config.healthPath !== "string" ||
    !config.healthPath.startsWith("/") ||
    config.healthPath.startsWith("//")
  ) {
    errors.push("healthPath 必须是站内绝对路径");
  }

  const serializedConfig = JSON.stringify(config).toUpperCase();
  const forbiddenFragments = [
    "DB_PASSWORD",
    "OSS_ACCESS_KEY",
    "API_KEY",
    "AUTH_SECRET",
    "ACCESS_TOKEN_SECRET",
    "RUNTIME_TOKEN",
    "PRIVATE_KEY",
  ];
  const exposed = forbiddenFragments.filter((fragment) =>
    serializedConfig.includes(fragment),
  );
  if (exposed.length > 0) {
    errors.push(`生产配置疑似包含密钥字段：${exposed.join(", ")}`);
  }
}

if (packageJson) {
  const build = packageJson.build ?? {};
  const packagedFiles = Array.isArray(build.files) ? build.files : [];

  if (build.productName !== "小逻") {
    errors.push("安装包产品名必须为“小逻”");
  }
  if (build.asar !== true) {
    errors.push("正式安装包必须启用 asar");
  }
  if (packagedFiles.some((entry) => String(entry).includes(".env"))) {
    errors.push("安装包文件列表不能包含 .env 文件");
  }
  if (!packagedFiles.includes("config.production.json")) {
    errors.push("安装包缺少生产地址配置");
  }
}

if (errors.length > 0) {
  console.error("桌面正式版校验失败：");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`桌面正式版校验通过：${config.appUrl}`);
console.log("安装包仅包含桌面壳与公开站点配置，不包含服务端密钥。");
