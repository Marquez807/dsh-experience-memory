# T2 全量：4 场景 × 5 臂 × 3 次，逐个跑、逐行落 JSONL。已完成的用 -Skip 跳过。
#   powershell -ExecutionPolicy Bypass -File t2-sweep.ps1 [-Runs 3] [-Skip bom] [-Out tools/t2-results.jsonl]
param([int]$Runs = 3, [string[]]$Skip = @(), [string]$Out = 'tools/t2-results.jsonl')
$ErrorActionPreference = 'Continue'
# `-Skip a,b` 在 -File 下是**一个**元素（数组语法不生效），"跳过多条"会只跳第一条 —— 实测踩过
# （`-Skip @('tplcomment','wipeguard')` 里 wipeguard 照样跑了）。统一按逗号拆开，两种传法都对。
$Skip = @($Skip | ForEach-Object { $_ -split ',' } | Where-Object { $_.Trim() -ne '' } | ForEach-Object { $_.Trim() })
$spec = Get-Content (Join-Path $PSScriptRoot 't2-scenarios.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$outPath = Join-Path (Split-Path -Parent $PSScriptRoot) $Out
# Append, never truncate: a run that stops half way must not throw away what it already measured.
if (-not (Test-Path $outPath)) { [IO.File]::WriteAllText($outPath, '', [Text.UTF8Encoding]::new($false)) }

# 断点续跑：已经测出结果的小格不再重跑（一个 8 分钟的超时格子重跑一次就是白等 8 分钟）。
# 占位行不算结果、必须重跑：note 以 seed-failed / no-result 开头的、以及没有 pass 字段的。
$done = @{}
foreach ($ln in [IO.File]::ReadAllLines($outPath)) {
  if (-not $ln.Trim()) { continue }
  try { $o = $ln | ConvertFrom-Json } catch { continue }
  if ($null -eq $o.pass) { continue }
  if ("$($o.note)" -match '^(seed-failed|no-result)') { continue }
  $done["$($o.scenario)|$($o.arm)|$($o.run)"] = $true
}
if ($done.Count -gt 0) { Write-Host "已有有效结果 $($done.Count) 格，跳过不重跑" }

$n = 0
foreach ($sc in $spec.scenarios) {
  if ($Skip -contains $sc.id) { Write-Host "跳过 $($sc.id)"; continue }
  foreach ($arm in @('none', 'rel', 'ctrl1', 'ctrl2', 'ctrl3')) {
    for ($r = 1; $r -le $Runs; $r++) {
      $n += 1
      if ($done.ContainsKey("$($sc.id)|$arm|$r")) { Write-Host "[$n] $($sc.id) / $arm / $r  (已有结果，跳过)"; continue }
      Write-Host "[$n] $($sc.id) / $arm / $r"
      # 外层看门狗，同样用**轮询**而不是 Wait-Job -Timeout：实测两者在扫里都没生效（一格跑了
      # 13 分钟，内外两层都没掐断）。内层 480 秒 + 建环境/判定/落盘的余量 ⇒ 720 秒。
      $cellSec = 720
      $cellScript = Join-Path $PSScriptRoot 't2-run.ps1'
      $cellLog = Join-Path $env:TEMP "t2-cell-$($sc.id)-$arm-$r.log"
      $cellProc = Start-Process -FilePath 'powershell' -PassThru -NoNewWindow `
        -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$cellScript`"", '-Scenario', $sc.id, '-Arm', $arm, '-Run', $r) `
        -RedirectStandardOutput $cellLog -RedirectStandardError "$cellLog.err"
      $line = $null
      $watchdog = $false
      if ($cellProc) {
        $deadline = (Get-Date).AddSeconds($cellSec)
        while (-not $cellProc.HasExited -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 5 }
        if (-not $cellProc.HasExited) {
          $watchdog = $true
          cmd /c "taskkill /T /F /PID $($cellProc.Id)" 2>&1 | Out-Null
          Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
            Where-Object { $_.CommandLine -match 'bin\.js.*--profile t2ab' } |
            ForEach-Object { cmd /c "taskkill /T /F /PID $($_.ProcessId)" 2>&1 | Out-Null }
          Start-Sleep -Seconds 2
        }
        $line = Get-Content $cellLog -Encoding UTF8 -ErrorAction SilentlyContinue |
          Where-Object { "$_" -match '^\{' } | Select-Object -Last 1
      }
      if ($line) {
        # Receive-Job 回来的是字符串（不是 Select-String 的 MatchInfo），所以直接写它本身。
        [IO.File]::AppendAllText($outPath, "$line`n", [Text.UTF8Encoding]::new($false))
        Write-Host "     $line"
      } elseif ($watchdog) {
        # 被外层看门狗掐断＝"没跑完"，不是"写错了"：单列 timeout=true，报告里分开算。
        # 续跑时把它当作已完成，避免一个慢格子反复吃掉整晚预算。
        $row = @{ scenario = $sc.id; arm = $arm; run = $r; pass = $false; note = 'watchdog-killed'; timeout = $true; seconds = $cellSec } | ConvertTo-Json -Compress
        [IO.File]::AppendAllText($outPath, $row + "`n", [Text.UTF8Encoding]::new($false))
        Write-Host "     (看门狗掐断)"
      } else {
        [IO.File]::AppendAllText($outPath, (@{ scenario = $sc.id; arm = $arm; run = $r; pass = $false; note = 'no-result' } | ConvertTo-Json -Compress) + "`n", [Text.UTF8Encoding]::new($false))
        Write-Host '     (无结果)'
      }
    }
  }
}
Write-Host ''
Write-Host "完成，$n 回合 -> $outPath"
