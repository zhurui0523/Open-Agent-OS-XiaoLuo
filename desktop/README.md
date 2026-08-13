# 小逻桌面工作台

桌面端分为两种运行方式：

- 正式安装版：只连接小逻云端服务，不会在用户电脑上启动 Node.js、MySQL、OSS 或插件运行时。
- 本地开发版：连接 `http://127.0.0.1:3001/`；服务未启动时可自动调用项目已有的本地启动脚本。

正式地址配置在 `desktop/config.production.json`。该文件只能包含公开的 HTTPS 站点地址和健康检查路径，不能保存数据库、OSS、模型 API 或运行时密钥。

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

安装程序输出到 `desktop/dist/`。安装后会创建“小逻”桌面和开始菜单快捷方式。

`pnpm desktop:install` 只用于开发环境创建本地快捷方式，不是交付给普通用户的安装程序。
