# T2 重判：对**已经跑完的格子**重新跑一遍判据，不重新跑智能体。
#
# 为什么需要它：判据的设计就是"只看产物"（`t2-run.ps1` 的判据函数只读工作区里的文件、只执行被测
# 脚本）。所以产物还在的时候，重判与当场判**等价**——而它比"重跑一次智能体"便宜三个数量级。
# 触发它的是实际发生过的事：一次 6 格的复测跑完了，但调用方拿到的任务句柄丢了、输出没接住，
# 结论差点变成"跑完但不知道结果"。
#
#   powershell -ExecutionPolicy Bypass -File tools\t2-rejudge.ps1 -Scenario wipeguard -Arm rel -Run 2
#   powershell -ExecutionPolicy Bypass -File tools\t2-rejudge.ps1 -Scenario wipeguard -All
#
# 判据函数从 t2-run.ps1 里**抽出来**执行（不复制副本，避免两份漂移）；抽不到就报错退出。
param(
  [Parameter(Mandatory = $true)][string]$Scenario,
  [string]$Arm,
  [int]$Run,
  [switch]$All
)
$ErrorActionPreference = 'Continue'
$root = Join-Path $env:TEMP 'dsh-t2'
$home_ = Join-Path $root 'home'
$runner = Join-Path $PSScriptRoot 't2-run.ps1'
$spec = Get-Content (Join-Path $PSScriptRoot 't2-scenarios.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$sc = $spec.scenarios | Where-Object { $_.id -eq $Scenario }
if (-not $sc) { Write-Host "未知场景 $Scenario"; exit 2 }

# 工作区目录名与 t2-run.ps1 用的是同一个哈希，才能找到那一格。
$sha = [Security.Cryptography.SHA256]::Create()
function CellDir([string]$arm, [int]$run) {
  $bytes = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes("$Scenario|$arm|$run"))
  $tag = ([BitConverter]::ToString($bytes) -replace '-', '').Substring(0, 12).ToLower()
  return Join-Path $root "cell-$tag"
}

$src = [IO.File]::ReadAllText($runner)
$si = $src.IndexOf('$sqliteHelper = Join-Path $root')
$ei = $src.IndexOf('$verdict = switch ($sc.judge)')
if ($si -lt 0 -or $ei -le $si) { Write-Host '[红] 抽不到判据函数：t2-run.ps1 的结构变了'; exit 1 }
# 抽出去之后 $PSScriptRoot 在函数里是空的，所以要在这里先把工具目录交给它。
$toolsDir = $PSScriptRoot
Invoke-Expression $src.Substring($si, $ei - $si)

$judgeName = @{
  'no-bom'              = 'Test-NoBom'
  'template-parses'     = 'Test-TemplateParses'
  'wipe-guard-executes' = 'Test-WipeGuardExecutes'
}[$sc.judge]
if (-not $judgeName) { Write-Host "判据 $($sc.judge) 没有对应的函数"; exit 1 }

$targets = if ($All) { foreach ($a in @('none', 'rel', 'ctrl1', 'ctrl2', 'ctrl3')) { foreach ($r in 1, 2, 3) { , @($a, $r) } } }
else {
  if (-not $Arm -or $Run -lt 1) { Write-Host '要么给 -Arm 与 -Run，要么给 -All'; exit 2 }
  , @($Arm, $Run)
}
foreach ($t in $targets) {
  $arm = $t[0]; $run = [int]$t[1]
  $dir = CellDir $arm $run
  if (-not (Test-Path $dir)) {
    [pscustomobject]@{ scenario = $Scenario; arm = $arm; run = $run; pass = $false; note = 'no-cell（这一格没有工作区，可能是从没跑过）' } | ConvertTo-Json -Compress
    continue
  }
  $verdict = & $judgeName $dir
  $row = @{ scenario = $Scenario; arm = $arm; run = $run; pass = [bool]$verdict.pass; note = [string]$verdict.note; rejudged = $true }
  if ($verdict.ContainsKey('task_done')) { $row['task_done'] = [bool]$verdict.task_done }
  [pscustomobject]$row | ConvertTo-Json -Compress
}
