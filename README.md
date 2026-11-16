# 小逻 Agent OS（Open-Agent-OS-XiaoLuo）

[![gate](https://github.com/zhurui0523/Open-Agent-OS-XiaoLuo/actions/workflows/gate.yml/badge.svg)](https://github.com/zhurui0523/Open-Agent-OS-XiaoLuo/actions/workflows/gate.yml)

面向 Agent OS 形态的桌面 + 后台一体项目：后台服务与界面在 `后台/source`，Electron 客户端在 `客户端/source`。

## 目录

| 目录 | 内容 |
| --- | --- |
| `后台/source` | 服务 + 界面 + API，唯一工作基地；`app/` 页面与路由，`scripts/` 构建与门禁，`docs/baseline/` 由代码生成的清单 |
| `客户端/source` | Electron 客户端、桌面控制通道、安装包脚本 |
| `shared` | 双端共享模块（同一份源码 + 同一套测试） |
| `.github/workflows/gate.yml` | CI：推 `main` 即跑九步门禁 |

## 门禁（九步）

在 `后台/source` 下执行：

```bash
node scripts/gate.mjs          # 全量（含构建与覆盖率，约 150–200s）
node scripts/gate.mjs --fast   # 提交前用（跳过构建与覆盖率，约 64s）
```

九步依次是：策略自测（69 条命令策略）→ `tsc --noEmit` → 构建 → 全量测试（360 条）→ 基线清单未漂移 → 快照回归 → 静默 catch 护栏 → CI 预检 → 覆盖率门槛（含三个重点文件下限）。

几条铁律：

- **基线只许由代码生成**：改动涉及路由 / 页面 / 组件 / 数据表后，先 `node scripts/gen-baseline-inventory.mjs` 再跑门禁，不许手改 CSV；
- **快照差异必须显式确认**：只有 `XIAOLUO_SNAPSHOT_UPDATE=1` 才允许改写基线，测试自己绝不偷偷改；
- **静默 catch 只许缩不许涨**：新增一处空 catch 直接失败，既有 169 处冻结在 `scripts/silent-catch-allowlist.json`。

## 提交即验收

`scripts/install-git-hooks.mjs` 会装 `pre-commit` 钩子，提交前自动跑 `gate --fast`；CI 与本地是同一套脚本，避免"本地绿、CI 红"。
