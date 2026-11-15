import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import path from "node:path";

const projectRoot = process.cwd();
const runtimeRoot = path.join(projectRoot, ".local-runtime");
const dataRoot = path.join(projectRoot, ".local-data", "mysql");
const filesRoot = path.join(projectRoot, ".local-data", "mysql-files");
const logRoot = path.join(projectRoot, ".local-data", "logs");
const optionFile = path.join(runtimeRoot, "mysql-local.ini");
const port = Number(process.env.DB_PORT || 3307);
const host = process.env.DB_HOST || "127.0.0.1";

function mysqlHome() {
  if (!existsSync(runtimeRoot)) return null;
  const directory = readdirSync(runtimeRoot, { withFileTypes: true }).find(
    (entry) =>
      entry.isDirectory() &&
      /^mysql-\d+\.\d+\.\d+-winx64$/i.test(entry.name),
  );
  return directory ? path.join(runtimeRoot, directory.name) : null;
}

function executable(name) {
  const home = mysqlHome();
  return home ? path.join(home, "bin", `${name}.exe`) : null;
}

function slash(value) {
  return value.replaceAll("\\", "/");
}

function ensureOptionFile() {
  const home = mysqlHome();
  if (!home) {
    throw new Error(
      "本地 MySQL 尚未安装。请先运行 pnpm local:setup。",
    );
  }
  mkdirSync(runtimeRoot, { recursive: true });
  mkdirSync(dataRoot, { recursive: true });
  mkdirSync(filesRoot, { recursive: true });
  mkdirSync(logRoot, { recursive: true });
  writeFileSync(
    optionFile,
    [
      "[mysqld]",
      `basedir=${slash(home)}`,
      `datadir=${slash(dataRoot)}`,
      `port=${port}`,
      "bind-address=127.0.0.1",
      "mysqlx=0",
      "character-set-server=utf8mb4",
      "collation-server=utf8mb4_unicode_ci",
      "default-time-zone=+08:00",
      `log-error=${slash(path.join(logRoot, "mysql-error.log"))}`,
      `pid-file=${slash(path.join(dataRoot, "mysql.pid"))}`,
      `secure-file-priv=${slash(filesRoot)}`,
      "",
      "[client]",
      `port=${port}`,
      "default-character-set=utf8mb4",
      "",
    ].join("\n"),
    "utf8",
  );
}

function probe(timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (ready) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ready);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function waitForMysql(timeoutMs = 30_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await probe()) return true;
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  return false;
}

async function start() {
  if (await probe()) {
    console.log(`local_mysql=ready host=${host} port=${port}`);
    return;
  }
  ensureOptionFile();
  const server = executable("mysqld");
  if (!server || !existsSync(server)) {
    throw new Error("本地 MySQL 可执行文件不存在，请运行 pnpm local:setup。");
  }
  const stdoutPath = path.join(logRoot, "mysql.stdout.log");
  const stderrPath = path.join(logRoot, "mysql.stderr.log");
  const stdout = openSync(stdoutPath, "a");
  const stderr = openSync(stderrPath, "a");
  const child = spawn(
    server,
    [`--defaults-file=${optionFile}`, "--console", "--no-monitor"],
    {
      cwd: projectRoot,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", stdout, stderr],
    },
  );
  child.unref();
  closeSync(stdout);
  closeSync(stderr);
  if (!(await waitForMysql())) {
    const errorLog = path.join(logRoot, "mysql-error.log");
    const tail = existsSync(errorLog)
      ? readFileSync(errorLog, "utf8").split(/\r?\n/).slice(-12).join("\n")
      : "没有生成 MySQL 错误日志";
    throw new Error(`本地 MySQL 启动失败：\n${tail}`);
  }
  console.log(`local_mysql=started pid=${child.pid} port=${port}`);
}

async function stop() {
  if (!(await probe())) {
    console.log("local_mysql=stopped");
    return;
  }
  const admin = executable("mysqladmin");
  if (!admin) throw new Error("mysqladmin 不存在");
  const result = spawnSync(
    admin,
    [
      "--protocol=TCP",
      `--host=${host}`,
      `--port=${port}`,
      "--user=root",
      "shutdown",
    ],
    {
      cwd: projectRoot,
      windowsHide: true,
      stdio: "pipe",
      env: {
        ...process.env,
        MYSQL_PWD:
          process.env.LOCAL_MYSQL_ROOT_PASSWORD ||
          "xiaoluo-local-root-development-only",
      },
    },
  );
  if (result.status !== 0) {
    throw new Error(
      result.stderr?.toString().trim() || "本地 MySQL 停止失败",
    );
  }
  console.log("local_mysql=stopped");
}

const command = process.argv[2] || "status";
if (command === "start") {
  await start();
} else if (command === "stop") {
  await stop();
} else if (command === "status") {
  console.log((await probe()) ? "local_mysql=ready" : "local_mysql=stopped");
} else {
  throw new Error(`未知命令：${command}`);
}
