# 小逻桌面工作台与云端部署

## 交付目标

普通用户只安装“小逻”Windows 客户端并登录。用户电脑不需要安装 Node.js、MySQL、对象存储或插件运行环境，也不承担公网服务器职责。

```text
小逻.exe
  │ HTTPS / WebSocket
  ▼
小逻云端站点与 API
  ├─ MySQL：账号、画布、节点、任务和权限
  ├─ OSS：图片、音频、视频和插件资产
  ├─ 调度器：异步任务状态与定时清理
  └─ 隔离插件运行时：执行已安装插件
```

桌面端是受控浏览器外壳。业务数据、模型调用、密钥和任务都由服务端处理；关闭客户端后，已经提交的异步任务仍可继续运行。

## 运行边界

### 桌面客户端

- 只保存公开的 HTTPS 站点地址。
- 不保存 MySQL、OSS、模型 API、短信或插件运行时密钥。
- 不启动本地 Web 服务或数据库。
- 断网、维护、渲染进程异常时显示恢复页，可重新连接或在系统浏览器打开。
- 默认拒绝网页申请摄像头、麦克风、定位等系统权限；需要的能力以后按白名单单独开放。

### 云端站点

- 承载 Web UI、身份认证、权限检查和 API。
- 通过服务端环境变量访问 MySQL 和 OSS。
- 定时任务调用 `/api/v2/worker/tick`，恢复和推进异步任务。
- 绝不把服务端环境变量注入桌面安装包或浏览器代码。

### 隔离插件运行时

- 使用 `isolated-worker/Dockerfile` 单独部署，不与 Web Worker 混在一个进程。
- 使用短时授权访问指定插件和资产。
- 保持非 root、只读根文件系统、CPU/内存/时长限制及默认禁止外网访问。
- Web 端仅保存运行时地址与共享令牌；令牌只存在服务端。

## 正式环境变量

值只配置在云端密钥管理中，不提交到 Git，也不复制进桌面端。当前应用需要按实际启用能力配置以下类别：

- 数据库：`DB_HOST`、`DB_PORT`、`DB_USER`、`DB_PASSWORD`、`DB_NAME`、`DB_SSL_MODE`
- 加密与登录：`SECRET_ENCRYPTION_KEY`、`ACCESS_TOKEN_SECRET`
- 对象存储：`STORAGE_DRIVER`、`OSS_REGION`、`OSS_ACCESS_KEY_ID`、`OSS_ACCESS_KEY_SECRET`、`OSS_BUCKET`、`OSS_ENDPOINT`
- 后台任务：`RUNTIME_WORKER_TOKEN`、`RUNTIME_SCHEDULER_NAME`
- 插件运行时：`ISOLATED_WORKER_ENDPOINT`、`ISOLATED_WORKER_TOKEN` 及资源限制变量
- 可选服务：GitHub 导入、短信、系统管理员初始化变量

完整名称和说明以 `.env.example` 为准。

## 发布流程

1. 部署或更新云端站点，先保持所有者可见完成验收。
2. 配置 MySQL、OSS、登录密钥、后台任务和隔离插件运行时。
3. 验证 `/api/v2/health/live`、登录、画布持久化、素材访问、异步任务与插件执行。
4. 明确批准后，再把站点访问范围开放给正式用户并绑定正式域名。
5. 将正式 HTTPS 地址写入 `desktop/config.production.json`。
6. 执行 `pnpm desktop:verify` 和 `pnpm desktop:dist`。
7. 在一台没有 Node.js、MySQL 和项目源码的 Windows 电脑上安装验收。
8. 对安装程序做代码签名后再对外分发，以减少 Windows SmartScreen 警告。

## 更新策略

当前安装包支持重新安装覆盖升级。后续接入自动更新时，应使用签名后的更新清单与安装包，并在服务端分阶段发布；桌面端不得接受任意 URL 下发的可执行文件。

## 当前正式地址

`https://xiaoluo-intent-os-v2-0722.shanhaiyixiang.chatgpt.site/`

该地址当前仍是受限访问。面向普通用户发布前，需要明确批准开放访问范围或绑定可公开访问的正式域名。
