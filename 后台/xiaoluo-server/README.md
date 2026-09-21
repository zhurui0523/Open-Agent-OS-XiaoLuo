# XiaoLuo Agent OS Server Deployment Package

Version: 0.1.0 | Port: 3000

## Requirements
- Node.js >= 22.13.0 (the only runtime dependency)
- MySQL (local or Alibaba Cloud RDS)
- Alibaba Cloud OSS

## Layout
```
xiaoluo-server/
|-- server.js              Entry (self-contained, deps bundled in node_modules)
|-- node_modules/          Runtime deps (bundled)
|-- dist/ public/          Pages and static assets
|-- scripts/               migrate-v2.mjs / bootstrap-system-admin.mjs / mysql-tls.mjs
|-- .env.local.example     Config template (copy to .env.local)
|-- start.bat / migrate.bat / create-admin.bat
```

## Deploy Steps

### 1. Configure
Copy `.env.local.example` to `.env.local` and fill in:
- MySQL connection (DB_*)
- OSS credentials (OSS_*)
- Two random secrets (SECRET_ENCRYPTION_KEY / ACCESS_TOKEN_SECRET)
- Initial admin info (SYSTEM_ADMIN_*)

Generate random secret:
```
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

### 2. First-time setup (only once)
```
migrate.bat        # create tables
create-admin.bat   # create admin account
```

### 3. Start
```
start.bat
```

### 4. Verify
- Readiness: http://127.0.0.1:3000/api/v2/health/ready
- UI: http://127.0.0.1:3000

## Client Integration
Point `appUrl` in the client `config.production.json` to this server:
- Local: http://127.0.0.1:3000/
- Public: https://your-domain/
The client never touches DB or storage credentials.

## Optional: Isolated Worker (plugin sandbox)
Deploy the worker process separately (port 8788) and set
ISOLATED_WORKER_ENDPOINT / ISOLATED_WORKER_TOKEN in .env.local.
