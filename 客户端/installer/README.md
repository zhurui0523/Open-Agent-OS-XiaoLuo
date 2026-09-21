# 桌面安装包

二进制安装包（`XiaoLuoAgentOS-Setup-<version>-x64.exe`，约 100 MB）不进入 git 历史，
统一发布于仓库 Releases：

<https://github.com/zhurui0523/Open-Agent-OS-XiaoLuo/releases>

自行打包：

```powershell
cd ../source
pnpm install
pnpm desktop:dist   # 产物在 desktop/dist/
```
