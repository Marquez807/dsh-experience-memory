# T2 扫描进度条 —— 读 tools/t2-results.jsonl，渲染"跑了几格 / 还剩多久"。
#
#   powershell -ExecutionPolicy Bypass -File tools\t2-progress.ps1 [-Skip tplcomment]
#
# 只读工具：不写库、不改结果文件。ETA 用**已完成格子的平均耗时 × 剩余格子**估算，
# 是"按这个速度继续"的直线外推，不是承诺；某格卡住时它会跟着变大（这正是它有用的时刻）。
param([string[]]$Skip = @('tplcomment'), [string]$Out = 'tools/t2-results.jsonl')
$ErrorActionPreference = 'Continue'
# `powershell -File x.ps1 -Skip a,b` 会把 "a,b" 当成**一个**元素（数组参数在 -File 下不走 PowerShell
# 的数组语法），于是"跳过多条"只会跳过第一条 —— 实测踩过（`-Skip @('tplcomment','wipeguard')` 里
# wipeguard 照样跑了）。这里统一按逗号拆开，两种传法都对。
$Skip = @($Skip | ForEach-Object { $_ -split ',' } | Where-Object { $_.Trim() -ne '' } | ForEach-Object { $_.Trim() })
$here = $PSScriptRoot
$repo = Split-Path -Parent $here
$spec = Get-Content (Join-Path $here 't2-scenarios.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$outPath = if ([IO.Path]::IsPathRooted($Out)) { $Out } else { Join-Path $repo $Out }

$ARMS = @('none', 'rel', 'ctrl1', 'ctrl2', 'ctrl3')
$runsPerArm = [int]$spec.runsPerArm
$scenarios = @($spec.scenarios)
$active = @($scenarios | Where-Object { $Skip -notcontains $_.id })
$skipped = @($scenarios | Where-Object { $Skip -contains $_.id })
$total = $active.Count * $ARMS.Count * $runsPerArm

# 每格取最后一条有效行（与 t2-report.mjs 同一套去重规则：占位行不算结果）。
$cells = @{}
$placeholders = 0
if (Test-Path $outPath) {
  foreach ($ln in [IO.File]::ReadAllLines($outPath)) {
    if (-not $ln.Trim()) { continue }
    try { $o = $ln | ConvertFrom-Json } catch { continue }
    if ($null -eq $o.pass) { continue }
    if ("$($o.note)" -match '^(seed-failed|no-result|watchdog-killed)') { $placeholders += 1; continue }
    $cells["$($o.scenario)|$($o.arm)|$($o.run)"] = $o
  }
}
$doneRows = @($cells.Values | Where-Object { $active.id -contains $_.scenario })
$done = $doneRows.Count
$remaining = [Math]::Max(0, $total - $done)
$elapsedSec = [Math]::Round(($doneRows | Measure-Object -Property seconds -Sum).Sum, 0)
$avg = if ($done -gt 0) { $elapsedSec / $done } else { 0 }
$etaSec = [Math]::Round($avg * $remaining, 0)

function Hms([double]$s) {
  $s = [Math]::Max(0, [Math]::Round($s))
  if ($s -lt 60) { return "$([int]$s) 秒" }
  if ($s -lt 3600) { return "$([int]($s / 60)) 分 $([int]($s % 60)) 秒" }
  return "$([int]($s / 3600)) 小时 $([int](($s % 3600) / 60)) 分"
}

# ── 总进度条 ────────────────────────────────────────────────────────────────
$width = 28
$filled = if ($total -gt 0) { [int][Math]::Round($width * $done / $total) } else { 0 }
$bar = ('█' * $filled) + ('░' * ($width - $filled))
$pct = if ($total -gt 0) { [Math]::Round(100 * $done / $total) } else { 0 }
$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
Write-Host ("  更新于 $stamp")
Write-Host ("  [$bar] $done/$total 格 ($pct%)")
if ($remaining -gt 0) {
  Write-Host ("  已跑 $(Hms $elapsedSec) · 按当前速度预计还要 $(Hms $etaSec)（剩余 $remaining 格 × 平均 $([Math]::Round($avg,0)) 秒/格）")
} else {
  Write-Host ("  全部完成，共跑了 $(Hms $elapsedSec)")
}
Write-Host ""

# ── 逐场景明细 ──────────────────────────────────────────────────────────────
foreach ($sc in $active) {
  $lines = @()
  $scDone = 0
  $scTotal = $ARMS.Count * $runsPerArm
  foreach ($arm in $ARMS) {
    $p = 0; $r = 0; $to = 0
    for ($i = 1; $i -le $runsPerArm; $i++) {
      $row = $cells["$($sc.id)|$arm|$i"]
      if ($null -ne $row) { $r++; if ($row.pass) { $p++ }; if ($row.timeout) { $to++ } }
      if ($null -ne $row) { $scDone++ }
    }
    if ($arm -like 'ctrl*') { continue }
    $mark = if ($to -gt 0) { " ($to 超时)" } else { "" }
    $lines += "$arm ${p}/${r}${mark}"
  }
  # 三条对照合计一并列出（它们的意义就是"合计高不高"）
  $cp = 0; $cr = 0
  foreach ($arm in @('ctrl1', 'ctrl2', 'ctrl3')) {
    for ($i = 1; $i -le $runsPerArm; $i++) {
      $row = $cells["$($sc.id)|$arm|$i"]
      if ($null -ne $row) { $cr++; if ($row.pass) { $cp++ } }
    }
  }
  $lines += "对照合计 ${cp}/${cr}"
  $cellsBar = if ($scTotal -gt 0) { [int][Math]::Round(14 * $scDone / $scTotal) } else { 0 }
  $tag = if ($scDone -eq $scTotal) { '跑完' } else { "跑 $scDone/$scTotal" }
  Write-Host ("  {0,-11} {1} {2}" -f $sc.id, ("[" + ('█' * $cellsBar) + ('░' * (14 - $cellsBar)) + "]"), $tag)
  Write-Host ("      " + ($lines -join ' · '))
}
foreach ($sc in $skipped) {
  Write-Host ("  {0,-11} (探针判定无判别力，已跳过)" -f $sc.id)
}
if ($placeholders -gt 0) { Write-Host ("`n  占位行（没跑成、不计分）：$placeholders 条") }
