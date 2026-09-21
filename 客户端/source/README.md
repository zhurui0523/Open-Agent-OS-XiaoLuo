# 客户端源码（Electron 壳）—— 唯一工作基地

自 2026-09-01 起，客户端的修改、构建、生成安装包全部在本目录进行。

- desktop/ = Electron 主进程、预加载、构建配置
- shared/ = 与后台共用模块（命令安全策略等）
- 安装依赖：pnpm install
- 生成安装包：pnpm desktop:dist（产出 desktop\dist\XiaoLuoAgentOS-Setup-0.1.0-x64.exe）
- desktop/config.production.json 是正式安装版的连接地址，必须 HTTPS 且非本机；
  本机调试用 XIAOLUO_DESKTOP_URL 环境变量，不要改这个文件
- 构建后请把安装包复制一份到上级「客户端」文件夹，保持交付物最新
