# 后台源码（服务 + 界面 + API）—— 唯一工作基地

自 2026-09-01 起，后台的修改、构建、生成部署包全部在本目录进行。

- app/ = 页面与 API；scripts/ db/ drizzle/ = 构建迁移运维；build/ .openai/ = 构建配置
- .env.local = 本机真实配置（含密钥，勿外传）
- 安装依赖：pnpm install
- 构建：pnpm build（产出 dist/standalone）
- ⚠️ 每次 pnpm install 或 pnpm build 后执行 node scripts/patch-vinext-win32.mjs（修复 Windows 静态资源 404，否则页面无样式）
- 本机运行：node --env-file=.env.local dist/standalone/server.js
- 构建后同步到上级「后台\xiaoluo-server」部署目录，保持运行版最新
