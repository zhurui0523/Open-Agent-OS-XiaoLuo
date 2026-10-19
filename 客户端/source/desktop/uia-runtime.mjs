// ---------- UIA：Windows UI Automation 桌面控件语义识别 ----------
// 目标：补齐整桌口"纯像素坐标"的短板（对齐 Codex Computer Use 的控件语义识别）。
// 用 System.Windows.Automation 枚举窗口/控件树、按 名称/AutomationId/控件类型 定位元素，
// 返回可点击矩形或直接用 InvokePattern/ValuePattern 语义操作，抗分辨率与布局变化。
// 零第三方依赖：内嵌 PowerShell + .NET UIAutomation 程序集，输出紧凑 JSON。
import { execFile } from "node:child_process";
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

let userDataDir = "";
export function initUia(dir) {
  userDataDir = String(dir || "");
}

const UIA_PS = `
param(
  [string]$Action = 'windows',
  [string]$Name = '',
  [string]$AutomationId = '',
  [string]$ControlType = '',
  [int]$TargetPid = 0,
  [int]$Depth = 6,
  [int]$Max = 80,
  [string]$Text = ''
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

function Get-Rect($el) {
  try {
    $r = $el.Current.BoundingRectangle
    if ($r.IsEmpty -or ($r.Width -le 0 -and $r.Height -le 0)) { return $null }
    return [pscustomobject]@{ x = [int]$r.X; y = [int]$r.Y; width = [int]$r.Width; height = [int]$r.Height }
  } catch { return $null }
}
function Get-Info($el) {
  $c = $el.Current
  $ct = ''
  try { $ct = ($c.ControlType.ProgrammaticName -replace '^ControlType\\.', '') } catch {}
  return [pscustomobject]@{
    name = $c.Name
    automationId = $c.AutomationId
    className = $c.ClassName
    controlType = $ct
    enabled = $c.IsEnabled
    rect = Get-Rect $el
  }
}
function Find-Window($pid0, $name0) {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $kids = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
  foreach ($w in $kids) {
    $c = $w.Current
    if ($pid0 -gt 0 -and $c.ProcessId -eq $pid0) { return $w }
    if ($name0 -and $c.Name -and $c.Name.Contains($name0)) { return $w }
  }
  return $null
}
function Match($el) {
  $c = $el.Current
  if ($Name -and -not ($c.Name -and $c.Name.Contains($Name))) { return $false }
  if ($AutomationId -and $c.AutomationId -ne $AutomationId) { return $false }
  if ($ControlType) {
    $ct = ''
    try { $ct = ($c.ControlType.ProgrammaticName -replace '^ControlType\\.', '') } catch {}
    if ($ct -ne $ControlType) { return $false }
  }
  return $true
}

$root = [System.Windows.Automation.AutomationElement]::RootElement

if ($Action -eq 'windows') {
  $kids = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
  $list = New-Object System.Collections.ArrayList
  foreach ($w in $kids) {
    $c = $w.Current
    if (-not $c.Name) { continue }
    [void]$list.Add([pscustomobject]@{ name = $c.Name; pid = $c.ProcessId; className = $c.ClassName; rect = Get-Rect $w })
    if ($list.Count -ge $Max) { break }
  }
  $list | ConvertTo-Json -Compress -Depth 4
  return
}

$win = Find-Window $TargetPid $Name
if ($Action -eq 'tree') {
  if (-not $win) { @{ error = '未找到目标窗口（pid/name）' } | ConvertTo-Json -Compress; return }
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $out = New-Object System.Collections.ArrayList
  $script:Depth = $Depth; $script:Max = $Max
  function Walk($el, $d) {
    if ($d -gt $script:Depth) { return }
    $child = $walker.GetFirstChild($el)
    while ($child -ne $null) {
      if ($out.Count -ge $script:Max) { break }
      [void]$out.Add((Get-Info $child))
      Walk $child ($d + 1)
      $child = $walker.GetNextSibling($child)
    }
  }
  Walk $win 1
  [pscustomobject]@{ window = $win.Current.Name; pid = $win.Current.ProcessId; count = $out.Count; elements = $out } | ConvertTo-Json -Compress -Depth 5
  return
}

if ($Action -eq 'find') {
  if (-not $win) { @{ error = '未找到目标窗口（pid/name）' } | ConvertTo-Json -Compress; return }
  $desc = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  $list = New-Object System.Collections.ArrayList
  foreach ($el in $desc) {
    if (Match $el) { [void]$list.Add((Get-Info $el)); if ($list.Count -ge $Max) { break } }
  }
  [pscustomobject]@{ count = $list.Count; elements = $list } | ConvertTo-Json -Compress -Depth 5
  return
}

if ($Action -eq 'invoke' -or $Action -eq 'setvalue' -or $Action -eq 'focus') {
  if (-not $win) { @{ error = '未找到目标窗口（pid/name）' } | ConvertTo-Json -Compress; return }
  $desc = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  $target = $null
  foreach ($el in $desc) { if (Match $el) { $target = $el; break } }
  if (-not $target) { @{ error = '未匹配到控件（name/automationId/controlType）' } | ConvertTo-Json -Compress; return }
  if ($Action -eq 'invoke') {
    try {
      $p = $target.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
      $p.Invoke()
      @{ ok = $true; via = 'InvokePattern'; name = $target.Current.Name } | ConvertTo-Json -Compress; return
    } catch {
      $r = Get-Rect $target
      if ($r) { @{ ok = $true; via = 'coord'; name = $target.Current.Name; x = ($r.x + [int]($r.width / 2)); y = ($r.y + [int]($r.height / 2)) } | ConvertTo-Json -Compress; return }
      @{ error = '控件不可 Invoke 且无有效矩形' } | ConvertTo-Json -Compress; return
    }
  }
  if ($Action -eq 'setvalue') {
    try {
      $p = $target.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
      $p.SetValue($Text)
      @{ ok = $true; via = 'ValuePattern'; name = $target.Current.Name } | ConvertTo-Json -Compress; return
    } catch {
      @{ error = '控件不支持 ValuePattern（无法直接赋值）' } | ConvertTo-Json -Compress; return
    }
  }
  if ($Action -eq 'focus') {
    try { $target.SetFocus(); @{ ok = $true; name = $target.Current.Name } | ConvertTo-Json -Compress; return }
    catch { @{ error = 'SetFocus 失败' } | ConvertTo-Json -Compress; return }
  }
}

@{ error = ('未知 action：' + $Action) } | ConvertTo-Json -Compress
`;

function psPath() {
  return join(userDataDir, "uia-inspect.ps1");
}

function runUiaPs(args) {
  if (!userDataDir) return Promise.resolve({ error: "UIA 未初始化（缺 userData 路径）" });
  const file = psPath();
  // 关键：写 UTF-8 BOM。Windows PowerShell 5.1 读无 BOM 的 .ps1 会按系统 GBK 解析，
  // 脚本里的中文字符串/全角括号会被误读导致"字符串缺少终止符"连锁语法错误。
  const content = "\uFEFF" + UIA_PS;
  try {
    const prev = existsSync(file) ? readFileSync(file, "utf8") : null;
    if (prev !== content) writeFileSync(file, content, "utf8");
  } catch (e) {
    return Promise.resolve({ error: "写入 UIA 脚本失败：" + (e && e.message ? e.message : String(e)) });
  }
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file, ...args],
      { timeout: 25000, windowsHide: true, maxBuffer: 12 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          resolve({ error: ((stderr || err.message || String(err)).toString("utf8")).slice(0, 400) });
          return;
        }
        const text = (stdout || "").toString("utf8").trim();
        try {
          resolve(JSON.parse(text || "{}"));
        } catch {
          resolve({ error: "UIA 输出非 JSON：" + text.slice(0, 300) });
        }
      },
    );
  });
}

/** brain:uia IPC 入口。action: windows|tree|find|invoke|setvalue|focus */
export async function handleUiaPayload(payload) {
  const p = payload || {};
  const action = String(p.action || "windows");
  const args = ["-Action", action];
  if (p.name != null) args.push("-Name", String(p.name));
  if (p.automationId != null) args.push("-AutomationId", String(p.automationId));
  if (p.controlType != null) args.push("-ControlType", String(p.controlType));
  if (p.pid != null) args.push("-TargetPid", String(Number(p.pid) || 0));
  if (p.depth != null) args.push("-Depth", String(Number(p.depth) || 6));
  if (p.max != null) args.push("-Max", String(Number(p.max) || 80));
  if (p.text != null) args.push("-Text", String(p.text));
  return await runUiaPs(args);
}
