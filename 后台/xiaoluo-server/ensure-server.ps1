# ensure-server.ps1 - idempotent XiaoLuo backend server (port 3000) keeper
# 登录自启脚本：端口已通则跳过，否则拉起服务；若端口被僵尸进程占用则先清理
$ErrorActionPreference = 'SilentlyContinue'

$NODE      = 'C:\Users\Zh\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$SERVER_JS = 'D:\projects\xiaoluo ai agent OS\后台\xiaoluo-server\server.js'
$ENV_FILE  = 'D:\projects\xiaoluo ai agent OS\后台\xiaoluo-server\.env.local'
$WORK_DIR  = 'D:\projects\xiaoluo ai agent OS\后台\xiaoluo-server'
$OUT_LOG   = Join-Path $WORK_DIR 'server-out.log'
$ERR_LOG   = Join-Path $WORK_DIR 'server-err.log'

function Test-Port {
  try { $c = New-Object System.Net.Sockets.TcpClient; $c.Connect('127.0.0.1',3000); $c.Close(); return $true }
  catch { return $false }
}

# 端口已通 -> 服务已运行，直接退出
if (Test-Port) { exit 0 }

# 端口不通但被占用 -> 僵尸进程残留，整树清理
$conn = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
if ($conn) {
  $zombiePid = $conn.OwningProcess
  taskkill /T /F /PID $zombiePid 2>$null
  Start-Sleep -Seconds 3
}

# 拉起服务（后台静默运行，输出重定向到日志）
$arg = "--env-file=`"$ENV_FILE`" `"$SERVER_JS`""
Start-Process -FilePath $NODE -ArgumentList $arg -WorkingDirectory $WORK_DIR `
  -WindowStyle Hidden -RedirectStandardOutput $OUT_LOG -RedirectStandardError $ERR_LOG

# 等待服务就绪（最多 30 秒）
$ready = $false
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 1
  if (Test-Port) { $ready = $true; break }
}

if (-not $ready) { exit 1 }
exit 0
