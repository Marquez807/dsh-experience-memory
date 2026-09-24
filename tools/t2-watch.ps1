# 盯着一次 T2 扫描，把进度渲染到 tools\t2-progress.txt，扫结束就停。
#
#   powershell -ExecutionPolicy Bypass -File tools\t2-watch.ps1 --out tools/t2-results-r3.jsonl
#
# 为什么要写成文件而不是一行命令：**命令行程探测会匹配到探测命令自身**（这个坑本仓库记过两次）。
# 把循环放进 .ps1 文件后，看门狗自己的命令行只有脚本路径，里面不含 't2-sweep' 字样，就不会
# 把"自己"当成还在跑的扫描而永远不退出（上一次实测：那个看板进程一直活着）。
param(
  [string]$Out = 'tools/t2-results.jsonl',
  [string[]]$Skip = @('tplcomment'),
  [int]$Seconds = 15
)
$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent $PSScriptRoot
$report = Join-Path $PSScriptRoot 't2-progress.txt'
$skipArgs = @('-Skip') + ($Skip -join ',')
while ($true) {
  $text = (& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 't2-progress.ps1') @skipArgs -Out $Out | Out-String)
  [IO.File]::WriteAllText($report, $text, [Text.UTF8Encoding]::new($false))
  # 只认"在跑扫描脚本"的进程；本文件的路径不含 t2-sweep 字样，所以不会匹配到自己。
  $sweeps = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
    Where-Object { $_.CommandLine -match 't2-sweep\.ps1' })
  if ($sweeps.Count -eq 0) { break }
  Start-Sleep -Seconds $Seconds
}
Write-Host "扫描已结束，进度停更：$report"
