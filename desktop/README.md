# 小逻桌面工作台

桌面端分为两种运行方式：

- 正式安装版：只连接小逻云端服务，不会在用户电脑上启动 Node.js、MySQL、OSS 或插件运行时。
- 本地开发版：连接 `http://127.0.0.1:3001/`；服务未启动时可自动调用项目已有的本地启动脚本。

正式地址配置在 `desktop/config.production.json`。该文件只能包含公开的 HTTPS 站点地址和健康检查路径，不能保存数据库、OSS、模型 API 或运行时密钥。

## 正式版安全边界

```text
Windows 桌面客户端
        │ HTTPS + 小逻登录态
        ▼
小逻远程 Web / API 服务
        ├── MySQL（仅服务端连接）
        ├── OSS（仅服务端持有密钥）
        └── 模型与插件运行时（仅服务端签发短期授权）
```

- 普通用户只安装桌面客户端，不需要安装 Node.js、MySQL，也不需要在本机启动 Web 服务。
- 桌面安装包只保存公开的 HTTPS 地址，不保存数据库密码、OSS AccessKey 或模型密钥。
- 登录、上传、下载、画布保存和插件调用继续走远程服务，由服务端鉴权和授权。
- 正式版启动时访问 `/api/v2/health/ready`，只有 MySQL 与 OSS 都可用才打开工作台。
- 生产站点的外层访问策略必须允许目标用户抵达小逻登录页；业务数据仍由小逻账号权限保护。
- 桌面壳默认拒绝网页权限、WebView 注入和跨站窗口导航，外部 HTTPS 链接交给系统浏览器。

## 开发

```powershell
pnpm desktop
pnpm desktop:smoke
```

## 正式模式验证

```powershell
pnpm desktop:verify
pnpm desktop:smoke:prod
```

若 `desktop:smoke:prod` 显示“限制外部用户访问”，说明生产站点仍处于限定访问模式，并非 MySQL 或 OSS 故障。

也可用环境变量临时覆盖正式地址：

```powershell
$env:XIAOLUO_DESKTOP_URL = "https://example.com/"
pnpm desktop:prod
```

## 构建 Windows 安装包

```powershell
pnpm desktop:verify
pnpm desktop:dist
```

`desktop:verify` 会递归扫描待发布的桌面文件，发现 `.env`、证书、私钥、数据库连接凭据或云密钥时立即终止构建。

安装程序输出到 `desktop/dist/`。安装后会创建“小逻”桌面和开始菜单快捷方式。

`pnpm desktop:install` 只用于开发环境创建本地快捷方式，不是交付给普通用户的安装程序。
