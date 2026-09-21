import { access, readdir, readFile } from "node:fs/promises";
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

const requiredPackagedFiles = [
  "main.mjs",
  "preload.cjs",
  "loading.html",
  "config.production.json",
  "assets/**/*",
  "package.json",
];

const textExtensions = new Set([
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".svg",
  ".txt",
]);

const forbiddenFilePatterns = [
  /(^|[\\/])\.env(?:\.|$)/i,
  /\.(?:key|pem|p12|pfx)$/i,
  /(?:credentials|service-account|secrets?)\.json$/i,
];

const forbiddenContentPatterns = [
  {
    name: "服务端密钥字段",
    pattern:
      /(?:DB_PASSWORD|OSS_ACCESS_KEY_ID|OSS_ACCESS_KEY_SECRET|AUTH_SECRET|ACCESS_TOKEN_SECRET|PRIVATE_KEY)\s*[=:]/i,
  },
  {
    name: "阿里云 AccessKey",
    pattern: /(?:LTAI|STS\.)[A-Za-z0-9]{12,}/,
  },
  {
    name: "私钥正文",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  },
  {
    name: "带凭据的数据库连接串",
    pattern: /(?:mysql|mariadb):\/\/[^\s:/]+:[^\s@]+@/i,
  },
];

const errors = [];

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(absolutePath)));
    else if (entry.isFile()) files.push(absolutePath);
  }
  return files;
}

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

  if (build.productName !== "小逻Agent OS") {
    errors.push("安装包产品名必须为“小逻Agent OS”");
  }
  if (build.asar !== true) {
    errors.push("正式安装包必须启用 asar");
  }

  const normalizedPackagedFiles = packagedFiles.map((entry) =>
    String(entry).replaceAll("\\", "/"),
  );
  for (const requiredFile of requiredPackagedFiles) {
    if (!normalizedPackagedFiles.includes(requiredFile)) {
      errors.push(`安装包文件列表缺少：${requiredFile}`);
    }
  }

  for (const entry of normalizedPackagedFiles) {
    if (entry.startsWith("../") || path.isAbsolute(entry)) {
      errors.push(`安装包文件范围越界：${entry}`);
    }
    if (entry === "**/*" || entry === "../**/*" || entry.startsWith("app/")) {
      errors.push(`安装包文件范围过宽：${entry}`);
    }
    if (forbiddenFilePatterns.some((pattern) => pattern.test(entry))) {
      errors.push(`安装包文件列表包含敏感文件：${entry}`);
    }
  }
}

try {
  const desktopFiles = await walk(path.join(root, "desktop"));
  const excludedDirectories = new Set(["dist", "dist2", "standalone", "node_modules"]);
  const filesToScan = desktopFiles.filter((absolutePath) => {
    const relativePath = path.relative(path.join(root, "desktop"), absolutePath);
    const segments = relativePath.split(path.sep);
    return !segments.some((segment) => excludedDirectories.has(segment));
  });

  for (const absolutePath of filesToScan) {
    const relativePath = path
      .relative(root, absolutePath)
      .replaceAll(path.sep, "/");
    if (forbiddenFilePatterns.some((pattern) => pattern.test(relativePath))) {
      errors.push(`桌面端目录包含敏感文件：${relativePath}`);
      continue;
    }
    if (!textExtensions.has(path.extname(absolutePath).toLowerCase())) continue;

    const content = await readFile(absolutePath, "utf8");
    for (const rule of forbiddenContentPatterns) {
      if (rule.pattern.test(content)) {
        errors.push(`${relativePath} 疑似包含${rule.name}`);
      }
    }
  }
} catch (error) {
  errors.push(`无法扫描桌面端发布文件：${error.message}`);
}

if (errors.length > 0) {
  console.error("桌面正式版校验失败：");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`桌面正式版校验通过：${config.appUrl}`);
console.log("安装包仅包含桌面壳与公开站点配置，不包含服务端密钥。");
