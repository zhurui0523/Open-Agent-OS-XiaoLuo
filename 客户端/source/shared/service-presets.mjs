/**
 * 本地服务类型注册表（setup_service 的单份真相，服务端/桌面端共享）。
 * 每种服务定义：探测二进制、健康检查口径、默认端口、安装引导命令。
 * 探测/搭建逻辑在 shared/service-provision.mjs。
 */

export const SERVICE_PRESETS = {
  web: {
    label: "Web 开发服务器",
    category: "http",
    health: "http",
    defaultPort: 0, // 由项目自身决定（读日志嗅探）
    binaries: [], // 依赖项目自身（npm/pnpm/node）
    installCommands: ["winget install OpenJS.NodeJS.LTS"],
    describe: "启动项目自带的开发服务器（package.json scripts.dev/start），没有则退回静态服务",
  },
  static: {
    label: "静态文件服务",
    category: "http",
    health: "http",
    defaultPort: 8123,
    binaries: ["node"],
    installCommands: ["winget install OpenJS.NodeJS.LTS"],
    describe: "用内置 Node 脚本把指定目录作为静态站点挂到本地端口（免安装）",
  },
  mysql: {
    label: "MySQL 数据库",
    category: "database",
    health: "mysql",
    defaultPort: 3310,
    binaries: ["mysqld", "mysqld.exe"],
    installCommands: [], // 优先用工程自带绿色版 .local-runtime/mysql-*-winx64
    describe: "绿色版 mysqld 免安装拉起：独立数据目录/端口，自动建库建账号并给出连接串",
  },
  postgres: {
    label: "PostgreSQL 数据库",
    category: "database",
    health: "postgres",
    defaultPort: 5433,
    binaries: ["pg_ctl", "pg_ctl.exe", "postgres", "postgres.exe"],
    installCommands: ["winget install PostgreSQL.PostgreSQL.16", "scoop install postgresql"],
    describe: "探测本机 PostgreSQL：initdb 初始化独立数据目录后启动，建库并给出连接串",
  },
  redis: {
    label: "Redis 缓存",
    category: "cache",
    health: "tcp",
    defaultPort: 6380,
    binaries: ["redis-server", "redis-server.exe"],
    installCommands: ["winget install Redis.Redis", "scoop install redis"],
    describe: "探测本机 redis-server：独立端口 + 数据目录启动（Windows 无官方包时需自备二进制）",
  },
  mongodb: {
    label: "MongoDB 数据库",
    category: "database",
    health: "tcp",
    defaultPort: 27018,
    binaries: ["mongod", "mongod.exe"],
    installCommands: ["winget install MongoDB.Server", "scoop install mongodb"],
    describe: "探测本机 mongod：独立 dbpath + 端口启动",
  },
  generic: {
    label: "自定义命令服务",
    category: "custom",
    health: "tcp",
    defaultPort: 0,
    binaries: [],
    installCommands: [],
    describe: "按给定命令长驻启动并纳入服务管理（端口嗅探/探活/TTL 同 start_service）",
  },
};

export const SERVICE_KINDS = Object.keys(SERVICE_PRESETS);

export function getPreset(kind) {
  return SERVICE_PRESETS[String(kind || "")] || null;
}

/** 服务名清洗：只允许字母数字下划线连字符，防路径注入 */
export function sanitizeServiceName(raw, fallback) {
  const name = String(raw || "").trim().replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return name || fallback;
}
