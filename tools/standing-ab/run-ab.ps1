# 真模型对照：常驻规矩到底改不改变模型的行为
#   powershell -ExecutionPolicy Bypass -File run-ab.ps1 -Trials 4
#
# 臂：control（库里那条记录不标常驻）/ standing（同一条记录标常驻）/ sham（标常驻，但讲的是另一件事）
# 判定只看产物：工作区里那个脚本文件的第一行是不是 `# owner-tag: zx9`。
# 目录名里**不许出现**与记录共有的 ASCII 词：第一版用 `dsh-standing`，而记录里有 `dsh`，
# 于是"不标常驻"的对照组也通过查询层命中了那条记录（实测 4/4 假阳性）——路径本身就是查询的一部分。
param([int]$Trials = 4, [int]$TimeoutSec = 300, [string]$Arms = 'control,standing,sham')

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

$entry = 'F:\Users\Admin\AppData\Local\Programs\DSH Desktop\resources\app\node_modules\@deepseek-ai\dsh\lib\bin.js'
$repo = 'F:\dsh主工作区\dsh-experience-memory'
$root = Join-Path $env:TEMP 'abx'
$home_ = Join-Path $root 'home'
$prof = Join-Path $home_ 'profiles\sab'
$out = 'F:\dsh主工作区\scratch\standing-ab\results.jsonl'

# ── 一次性：隔离 home + profile ────────────────────────────────────────────
if (-not (Test-Path $home_)) {
  $src = "$env:APPDATA\dsh-desktop\harness"
  New-Item -ItemType Directory -Force -Path $home_, $prof, (Join-Path $home_ 'experience-memory') | Out-Null
  foreach ($f in @('settings.yaml', '.env', '.credentials.yaml', '.anonymous-user-id')) {
    if (Test-Path (Join-Path $src $f)) { Copy-Item (Join-Path $src $f) (Join-Path $home_ $f) -Force }
  }
  $pkg = '{"name":"dsh-profile-sab","private":true,"dependencies":{"@marquez807/dsh-experience-memory":"link:REPO"},"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","@deepseek-ai/dsh-headless","@marquez807/dsh-experience-memory"]}}}'
  $pkg = $pkg.Replace('REPO', ($repo -replace '\\', '/'))
  [IO.File]::WriteAllText((Join-Path $prof 'package.json'), $pkg, [Text.UTF8Encoding]::new($false))
  $nm = Join-Path $prof 'node_modules'
  New-Item -ItemType Junction -Path $nm -Target 'F:\Users\Admin\AppData\Local\Programs\DSH Desktop\resources\app\node_modules' | Out-Null
  # 带 scope 的名字在 node_modules 下多一层目录：@marquez807\<name>
  New-Item -ItemType Directory -Force -Path (Join-Path $nm '@marquez807') | Out-Null
  $link = Join-Path $nm '@marquez807\dsh-experience-memory'
  if (Test-Path $link) { cmd /c rmdir "$link" }
  New-Item -ItemType Junction -Path $link -Target $repo | Out-Null
  Write-Host "隔离环境已建：$home_"
}

$TASK = @'
# Task

Create a script named `hello.py` in this directory. Running it must print `hello`.

Stop when the file is written.
'@
$PROMPT = 'Follow the instructions in TASK.md.'

$sha = [Security.Cryptography.SHA256]::Create()
function CellTag($arm, $trial) {
  $b = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes("standing|$arm|$trial"))
  return ([BitConverter]::ToString($b) -replace '-', '').Substring(0, 10).ToLower()
}
# 结果行用 [IO.File]::AppendAllText 写：PowerShell 5.1 的 `-Encoding UTF8` 会带 BOM，.jsonl 一带 BOM 就整份读不开
function Write-Line($text) { [IO.File]::AppendAllText($out, $text + "`n", [Text.UTF8Encoding]::new($false)) }
$sessDir = Join-Path $home_ 'sessions'

foreach ($arm in ($Arms -split ',')) {
  for ($trial = 1; $trial -le $Trials; $trial++) {
    $tag = CellTag $arm $trial
    $ws = Join-Path $root "cell-$tag"
    if (Test-Path $ws) { Remove-Item $ws -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $ws | Out-Null
    [IO.File]::WriteAllText((Join-Path $ws 'TASK.md'), $TASK, [Text.UTF8Encoding]::new($false))

    # 干净的隔离库：每次重建，只播一条记录
    $isoDir = Join-Path $home_ 'experience-memory'
    foreach ($suffix in @('memory.db', 'memory.db-wal', 'memory.db-shm')) {
      $stale = Join-Path $isoDir $suffix
      if (Test-Path $stale) { Remove-Item $stale -Force }
    }
    $seedOut = & node 'F:\dsh主工作区\scratch\standing-ab\seed.mjs' (Join-Path $isoDir 'memory.db') $ws $arm 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) {
      Write-Line ([pscustomobject]@{ arm = $arm; trial = $trial; note = "seed-failed: $($seedOut.Trim())" } | ConvertTo-Json -Compress)
      continue
    }

    $env:DSH_HOME = $home_
    $sessionsBefore = @(Get-ChildItem $sessDir -Recurse -File -ErrorAction SilentlyContinue).Count
    $sw = [Diagnostics.Stopwatch]::StartNew()
    Push-Location $ws
    $proc = Start-Process -FilePath 'node' -ArgumentList @("`"$entry`"", '--profile', 'sab', "`"$PROMPT`"") -PassThru -NoNewWindow `
      -RedirectStandardOutput (Join-Path $ws '.agent.out.txt') -RedirectStandardError (Join-Path $ws '.agent.err.txt')
    Pop-Location
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while (-not $proc.HasExited -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 3 }
    $timedOut = -not $proc.HasExited
    if ($timedOut) { try { $proc.Kill() } catch {} ; Start-Sleep -Seconds 2 }
    $sw.Stop()

    # ── 判定：只看产物 ────────────────────────────────────────────────────
    $files = @(Get-ChildItem $ws -File -Recurse | Where-Object { $_.Name -notlike '.agent.*' -and $_.Name -ne 'TASK.md' })
    $py = @($files | Where-Object { $_.Extension -eq '.py' })
    $firstLine = ''
    if ($py.Count -gt 0) { $firstLine = ([IO.File]::ReadAllLines($py[0].FullName))[0] }
    $marked = $firstLine -match 'owner-tag:\s*zx9'

    # 投递证据：这一次跑完有没有新会话落盘（"智能体没起来"必须与"模型做错了"分开）
    $sessionsAfter = @(Get-ChildItem $sessDir -Recurse -File -ErrorAction SilentlyContinue)
    $started = $sessionsAfter.Count -gt $sessionsBefore
    $delivered = $false
    $hintSeen = $false
    foreach ($h in ($sessionsAfter | Where-Object { $_.LastWriteTime -gt (Get-Date).AddMinutes(-15) })) {
      try {
        $raw = [IO.File]::ReadAllBytes($h.FullName)
        # 会话日志是 zstd 压缩的，直接读字节找 UTF-8 里的「常驻规矩」；找不到不算错，只记 false
        $text = [Text.Encoding]::UTF8.GetString($raw)
        if ($text -match '常驻规矩') { $delivered = $true }
        if ($text -match 'memory_recall') { $hintSeen = $true }
      } catch {}
    }

    $line = [pscustomobject]@{
      arm = $arm; trial = $trial; timeout = $timedOut; started = $started
      files = $files.Count; py = $py.Count; first_line = $firstLine; marked = $marked
      delivered_in_log = $delivered; hint_in_log = $hintSeen; seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1)
    } | ConvertTo-Json -Compress
    Write-Line $line
    Write-Host $line
  }
}
Write-Host "`n结果写入 $out"
