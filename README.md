# XiaoLuo AI Intent OS V2

联网运行的 Web AI OS：以无限画布组织意图、节点、模型、插件、文件与
AI 微内核任务。

## 数据架构

- MySQL：账号、密码哈希、会话、权限、工作区、项目、画布、节点、连线、
  扩展注册表、模型连接、运行记录、资产元数据与文件版本。
- 阿里云 OSS：用户上传、AI 生成结果和所有版本的文件二进制。
- 本机不作为业务数据存储。`localhost` 只是开发入口，仍然连接远程服务。
- 所有业务 API 都要求有效会话；资产查询按 `workspace_id` 隔离。

## 准备环境

- Node.js `>=22.13.0`
- pnpm `11.9.0`
- 可联网访问的 MySQL 8.x
- 阿里云 OSS Bucket

复制 `.env.example` 为被 Git 忽略的 `.env.local`，只在服务器中填写真实
值。不要把密码、AccessKey 或 `.env.local` 提交到仓库。

```dotenv
DB_HOST=
DB_PORT=3306
DB_USER=
DB_PASSWORD=
DB_NAME=
DB_SSL_MODE=preferred

OSS_REGION=
OSS_ACCESS_KEY_ID=
OSS_ACCESS_KEY_SECRET=
OSS_BUCKET=
OSS_ENDPOINT=
```

应用第一次访问数据库时会以 `CREATE TABLE IF NOT EXISTS` 初始化表结构。
初始化所用数据库账号需要建表权限；稳定运行后可以换成仅具备业务 CRUD
权限的账号。

## 本地开发

```bash
pnpm install
pnpm cloud:verify
pnpm dev:local
```

也可以在 Windows 中双击 `start-local.cmd`。浏览器打开
`http://localhost:3001/` 后，先创建真实账号；系统会自动创建第一个工作
空间、项目和云画布。

## 验证

```bash
pnpm test
pnpm lint
```

`pnpm test` 会完成生产构建并运行架构与渲染测试。

## 安全约定

- 密码使用 PBKDF2-SHA256、随机盐和 310,000 次迭代保存。
- 登录状态使用 15 分钟签名 Access Token 与可轮换 Refresh Token；两者均通过
  `HttpOnly`、`SameSite=Lax` Cookie 传输，Refresh 会话可按设备立即撤销。
- 用户名是独立、全局唯一的登录标识；显示名称只负责界面展示。
- 画布写入采用 revision 乐观锁，检测多端并发覆盖。
- OSS AccessKey 只在服务端使用，绝不下发到浏览器。
- 已经出现在聊天、日志、截图或 Git 历史里的密码与 AccessKey 必须立即
  作废并重新生成。
