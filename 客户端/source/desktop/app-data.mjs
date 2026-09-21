/**
 * 单机版数据目录管理（设置 → 存储位置）：
 * 配置落 userData/data-dir.json；启动内置服务前完成待迁移并注入 XIAOLUO_DATA_DIR。
 * 切换目录采用"写入待迁移 → 重启客户端 → 启动前迁移 → 失败回滚旧目录"的安全流程。
 */
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, dialog, ipcMain } from "electron";

let userDataDir = "";

function configPath() {
  return join(userDataDir, "data-dir.json");
}

function readConfig() {
  try {
    return JSON.parse(readFileSync(configPath(), "utf8"));
  } catch {
    return {};
  }
}

function writeConfig(config) {
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(configPath(), JSON.stringify(config, null, 2), "utf8");
}

function logEvent(line) {
  try {
    appendFileSync(
      join(userDataDir, "desktop-crash.log"),
      `[${new Date().toISOString()}] ${line}\n`,
    );
  } catch {
    /* 日志失败不影响主流程 */
  }
}

export function initAppData(dir) {
  userDataDir = dir;
}

/** 当前生效的数据目录：配置优先，未配置时用安装目录下的 .local-data */
export function resolveStandaloneDataDir(standaloneDir) {
  const configured = String(readConfig().dataDir || "").trim();
  return configured || join(standaloneDir, ".local-data");
}

/** 启动内置服务前执行：有待迁移则把旧目录数据复制到新目录；失败回滚到旧目录 */
export function prepareStandaloneDataDir(standaloneDir) {
  const config = readConfig();
  const pendingFrom = String(config.pendingFrom || "").trim();
  const target = String(config.dataDir || "").trim();
  if (!pendingFrom) return;
  try {
    if (target && existsSync(pendingFrom)) {
      mkdirSync(target, { recursive: true });
      cpSync(pendingFrom, target, { recursive: true });
    }
    writeConfig({ dataDir: target });
    logEvent(`app_data=migrated from=${pendingFrom} to=${target}`);
  } catch (error) {
    // 迁移失败：回滚到旧目录，保证数据不丢
    writeConfig({ dataDir: "" });
    logEvent(`app_data=migration_failed rollback=${pendingFrom} error=${error}`);
  }
}

export function registerAppDataIpc(standaloneDirProvider) {
  ipcMain.handle("app-data", async (_event, payload) => {
    const action = payload?.action;
    try {
      const standaloneDir = standaloneDirProvider();
      if (action === "status") {
        return {
          ok: true,
          data: {
            dir: resolveStandaloneDataDir(standaloneDir),
            pendingFrom: String(readConfig().pendingFrom || ""),
          },
        };
      }
      if (action === "pick") {
        const win =
          BrowserWindow.getFocusedWindow() ||
          BrowserWindow.getAllWindows()[0] ||
          null;
        const result = await dialog.showOpenDialog(win, {
          title: "选择数据存储目录",
          properties: ["openDirectory", "createDirectory"],
        });
        if (result.canceled || !result.filePaths.length) {
          return { ok: false, message: "已取消选择" };
        }
        return { ok: true, data: { dir: result.filePaths[0] } };
      }
      if (action === "set") {
        const next = String(payload.dir || "").trim();
        if (!next) throw new Error("存储目录不能为空");
        const current = resolveStandaloneDataDir(standaloneDir);
        if (next === current) return { ok: true, data: { unchanged: true } };
        writeConfig({ dataDir: next, pendingFrom: current });
        // 延迟重启：让响应先送回渲染进程，界面能先显示“正在重启”
        setTimeout(() => {
          app.relaunch();
          app.exit(0);
        }, 400);
        return { ok: true };
      }
      throw new Error("未知操作：" + action);
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  });
}
