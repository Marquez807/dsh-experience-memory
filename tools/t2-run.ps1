# T2 受控删除测试 —— 跑一个 (场景, 臂, 次数)，从产物判定，输出 JSON。
#   powershell -ExecutionPolicy Bypass -File t2-run.ps1 -Scenario bom -Arm rel -Run 1
#
# 臂的含义（见 t2-scenarios.json）：
#   none  = 库里没有任何记录
#   rel   = 只放那条**相关**的记录
#   ctrlN = 只放第 N 条**已知无关**的记录（阴性对照内建）
#
# 判定只看产物，不看模型说了什么。清库走 tools/verified-user-ab/wipe.mjs 的守卫。
param(
  [Parameter(Mandatory = $true)][string]$Scenario,
  [Parameter(Mandatory = $true)][ValidateSet('none', 'rel', 'ctrl1', 'ctrl2', 'ctrl3')][string]$Arm,
  [Parameter(Mandatory = $true)][int]$Run,
  # 单格上限。默认 480 秒；参数化是为了能用一个小值**实测"上限真的会杀进程"**（见 -TimeoutSec 20 的探针）。
  [int]$TimeoutSec = 480
)
$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent $PSScriptRoot                       # dsh-experience-memory
$spec = Get-Content (Join-Path $PSScriptRoot 't2-scenarios.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$sc = $spec.scenarios | Where-Object { $_.id -eq $Scenario }
if (-not $sc) { Write-Host "未知场景 $Scenario"; exit 2 }

$entry = 'F:\Users\Admin\AppData\Local\Programs\DSH Desktop\resources\app\node_modules\@deepseek-ai\dsh\lib\bin.js'
$root = Join-Path $env:TEMP 'dsh-t2'
$home_ = Join-Path $root 'home'
$prof = Join-Path $home_ 'profiles\t2ab'
$ws = Join-Path $root "$Scenario-$Arm-$Run"

# ── 一次性：隔离 home + profile（junction 到本机 node_modules 与本插件）────────
if (-not (Test-Path $home_)) {
  $src = "$env:APPDATA\dsh-desktop\harness"
  New-Item -ItemType Directory -Force -Path $home_, $prof, (Join-Path $home_ 'experience-memory') | Out-Null
  foreach ($f in @('settings.yaml', '.env', '.credentials.yaml', '.anonymous-user-id')) {
    if (Test-Path (Join-Path $src $f)) { Copy-Item (Join-Path $src $f) (Join-Path $home_ $f) -Force }
  }
  $pkg = '{"name":"dsh-profile-t2ab","private":true,"dependencies":{"dsh-experience-memory":"link:REPO"},"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","@deepseek-ai/dsh-headless","dsh-experience-memory"]}}}'
  $pkg = $pkg.Replace('REPO', ($repo -replace '\\', '/'))
  [IO.File]::WriteAllText((Join-Path $prof 'package.json'), $pkg, [Text.UTF8Encoding]::new($false))
  $nm = Join-Path $prof 'node_modules'
  New-Item -ItemType Junction -Path $nm -Target 'F:\Users\Admin\AppData\Local\Programs\DSH Desktop\resources\app\node_modules' | Out-Null
  $link = Join-Path $nm 'dsh-experience-memory'
  # 这条路径会穿过 node_modules 那个联接落到 app 的 node_modules 里（那里又是指向我们仓库的联接）。
  # PowerShell 5.1 的 Remove-Item -Recurse 会跟进联接、可能删到目标里去；cmd 的 rmdir 只摘联接本身。
  if (Test-Path $link) { cmd /c rmdir "$link" }
  New-Item -ItemType Junction -Path $link -Target $repo | Out-Null
}

# ── 工作区：只有场景自己声明的文件 + TASK.md ────────────────────────────────
# The task goes through a file, not the command line: a multi-line prompt passed as an argv gets
# its newlines eaten and the model correctly reports "there is nothing after the colon" and stops.
if (Test-Path $ws) { Remove-Item $ws -Recurse -Force }
New-Item -ItemType Directory -Force -Path $ws | Out-Null
foreach ($k in $sc.setup.PSObject.Properties.Name) {
  $p = Join-Path $ws $k
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $p) | Out-Null
  [IO.File]::WriteAllText($p, [string]$sc.setup.$k, [Text.UTF8Encoding]::new($false))
}
[IO.File]::WriteAllText((Join-Path $ws 'TASK.md'), [string]$sc.task, [Text.UTF8Encoding]::new($false))

# ── 干净的库 + 按臂放记录 ───────────────────────────────────────────────────
Copy-Item "$env:APPDATA\dsh-desktop\harness\experience-memory\memory.db" (Join-Path $home_ 'experience-memory\memory.db') -Force
$env:DSH_HOME = $home_
$w = & node (Join-Path $repo 'tools\verified-user-ab\wipe.mjs') 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) {
  [pscustomobject]@{ scenario = $Scenario; arm = $Arm; run = $Run; verdict = 'aborted-wipe-refused' } | ConvertTo-Json -Compress
  exit 4
}
$seedTitle = $null
if ($Arm -eq 'rel') { $seedTitle = [string]$sc.relevantRecordTitle }
elseif ($Arm -like 'ctrl*') {
  $idx = [int]$Arm.Substring(4) - 1
  $seedTitle = [string]$spec.controlPool[$idx]
}
# 播种必须成功才算一个有效的臂：标题对不上时 t2-seed.mjs 会 exit 2，而"没播种成功"与
# "库里本来就没有记忆"在产物上**一模一样** —— ctrl2 就这样静默退化成 none 臂
# （2026-09-23 复核实测：场景表里是中文引号、库里是英文引号）。所以这里必须看退出码。
# 标题走**文件**而不是命令行：PowerShell 把参数交给原生程序时会重写引号，标题里的英文双引号
# 会被吃掉（实测 ctrl2 那条就这样 exit 2）。文件是唯一稳的过法。
if ($seedTitle) {
  $seedTitleFile = Join-Path $ws '.seed-title.txt'
  [IO.File]::WriteAllText($seedTitleFile, $seedTitle, [Text.UTF8Encoding]::new($false))
  & node (Join-Path $PSScriptRoot 't2-seed.mjs') --from "$env:APPDATA\dsh-desktop\harness\experience-memory\memory.db" --to (Join-Path $home_ 'experience-memory\memory.db') --workspace $ws --title-file $seedTitleFile 2>&1 |
    ForEach-Object { "  seed: $_" }
  if ($LASTEXITCODE -ne 0) {
    [pscustomobject]@{ scenario = $Scenario; arm = $Arm; run = $Run; pass = $false; note = "seed-failed(exit $LASTEXITCODE)" } | ConvertTo-Json -Compress
    exit 5
  }
}

# ── stdin 场景的环境修复（**判据一个字没改**）────────────────────────────────
# 本机沙箱禁止 git 的凭据助手起 bash 管道：实测人手跑 `git credential fill` 也必失败
# （error: cannot create standard input pipe for bash: Permission denied → 转去问用户名）。
# 不修的话这条场景测的是"环境通不通"，不是"能不能把 stdin 喂进去"，四个臂会一起红。
# 给隔离环境配一个静态凭据存储（只影响本隔离 home，不碰你真机的 git 配置），让 git 能正常
# 完成填充、把查询原样回显出来；成功/失败判据保持原样（回显 host=example.com 才算真的送进去）。
$gitCfg = Join-Path $home_ 'gitconfig'
$gitCreds = Join-Path $home_ 'git-creds'
if (-not (Test-Path $gitCfg)) {
  [IO.File]::WriteAllText($gitCreds, "https://tester:secret@example.com`n", [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText($gitCfg, "[credential]`n`thelper = store --file=$($gitCreds -replace '\\','/')`n", [Text.UTF8Encoding]::new($false))
}
$env:GIT_CONFIG_GLOBAL = $gitCfg
$env:GIT_CONFIG_NOSYSTEM = '1'

# ── 跑任务（prompt 只有一行；任务正文在 TASK.md）────────────────────────────
# 单次硬超时，先声明：480 秒（bom 那轮实测每次 20~60 秒）。没有超时的那版被一个挂住的回合
# 拖死了整轮（2026-09-23 20:17 的 stdin-none-1 就没跑完）。超时照样按产物判定，但会在结果里
# 记 timeout=true，供事后分辨"真失败"与"没跑完"。
$timeoutSec = $TimeoutSec
$sw = [Diagnostics.Stopwatch]::StartNew()
$prompt = '照工作区里 TASK.md 的要求做。'
Push-Location $ws
$proc = Start-Process -FilePath 'node' -ArgumentList @("`"$entry`"", '--profile', 't2ab', "`"$prompt`"") -PassThru -NoNewWindow `
  -RedirectStandardOutput (Join-Path $ws '.agent.out.txt') -RedirectStandardError (Join-Path $ws '.agent.err.txt')
Pop-Location
if (-not $proc) {
  [pscustomobject]@{ scenario = $Scenario; arm = $Arm; run = $Run; pass = $false; note = 'launch-failed' } | ConvertTo-Json -Compress
  exit 6
}
# 超时用**轮询**实现，不用 Wait-Process -Timeout：实测那个参数在本机这条路里不生效
# （声明 480 秒上限，实际一格跑了 13 分钟没被掐断），而 Get-Date / Start-Sleep / HasExited 不会骗人。
$deadline = (Get-Date).AddSeconds($timeoutSec)
while (-not $proc.HasExited -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 3 }
$timedOut = -not $proc.HasExited
$killLeft = 0
if ($timedOut) {
  try { $proc.Kill() } catch { }
  # 只杀父进程会留孤儿：无头 harness 会派生子进程（实测留下过跑了 26 分钟的孤儿 node）。
  # 所以再对进程树兜底：/T 连子进程，/F 强制。
  cmd /c "taskkill /T /F /PID $($proc.Id)" 2>&1 | Out-Null
  # 这一步以前"写了就当生效"：实测超时之后智能体还活着 20~34 分钟（每一格的 ask.ps1 都是在上限
  # 之后才出现的），于是 3~4 个格子同时跑、还共用同一个隔离库 —— 数据被污染，而且没人看得出来。
  # 现在按进程名清干净，并且**验证是否真的清干净**，结果写进结果行（kill_left）。
  for ($attempt = 0; $attempt -lt 6; $attempt++) {
    $left = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
      Where-Object { $_.CommandLine -match 'bin\.js' -and $_.CommandLine -match '--profile t2ab' -and $_.CommandLine -notmatch 'subprocess-local' })
    if ($left.Count -eq 0) { break }
    $killLeft = $left.Count
    foreach ($p in $left) { cmd /c "taskkill /T /F /PID $($p.ProcessId)" 2>&1 | Out-Null }
    Start-Sleep -Seconds 2
  }
  Start-Sleep -Seconds 1
}
$sw.Stop()
$elapsed = $sw.Elapsed.TotalSeconds

# ── 判定（只看产物）────────────────────────────────────────────────────────
function Test-NoBom([string]$dir) {
  $f = Join-Path $dir 'out.txt'
  if (-not (Test-Path $f)) { return @{ pass = $false; note = 'out.txt 不存在' } }
  $b = [IO.File]::ReadAllBytes($f)
  $bom = ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF)
  $txt = [IO.File]::ReadAllText($f)
  if ($bom) { return @{ pass = $false; note = '带 UTF-8 BOM' } }
  if ($txt -notmatch '第一行') { return @{ pass = $false; note = "内容不对: $($txt.Substring(0,[Math]::Min(40,$txt.Length)))" } }
  return @{ pass = $true; note = '无 BOM 且内容正确' }
}
function Test-Stdin([string]$dir) {
  $f = Join-Path $dir 'reply.txt'
  $s = Join-Path $dir 'ask.ps1'
  if (-not (Test-Path $s)) { return @{ pass = $false; note = 'ask.ps1 不存在' } }
  if (-not (Test-Path $f)) { return @{ pass = $false; note = 'reply.txt 不存在' } }
  $t = [IO.File]::ReadAllText($f)
  # Exclusive on purpose. `host=example.com` coming back proves the text reached git's stdin (it
  # echoes the query); "refusing to work" proves it did NOT. The two cannot both hold, so the file
  # cannot be faked by writing the three lines down by hand.
  if ($t -match 'refusing to work') { return @{ pass = $false; note = 'git 说没收到 stdin' } }
  if ($t -match 'host=example.com' -and $t -match 'protocol=https') { return @{ pass = $true; note = '真的送进 stdin 了' } }
  return @{ pass = $false; note = "reply.txt 不对: $($t.Substring(0,[Math]::Min(60,$t.Length)))" }
}
function Test-Guard([string]$dir) {
  $f = Join-Path $dir 'wipe.mjs'
  if (-not (Test-Path $f)) { return @{ pass = $false; note = 'wipe.mjs 不存在' } }
  $t = [IO.File]::ReadAllText($f)
  $prints = ($t -match 'console\.(log|error)' -and $t -match 'target|路径|path')
  $refuses = ($t -match 'exit\(|process\.exit|throw')
  if ($prints -and $refuses) { return @{ pass = $true; note = '先打印路径且会拒绝' } }
  return @{ pass = $false; note = "prints=$prints refuses=$refuses" }
}
function Test-SelfTest([string]$dir) {
  $f = Join-Path $dir 'verify.md'
  if (-not (Test-Path $f)) { return @{ pass = $false; note = 'verify.md 不存在' } }
  $t = [IO.File]::ReadAllText($f)
  $flags = ($t -match '自身|自证|自引用|自己|needle|构造|tautolog|100%')
  $how = ($t -match '排除|重跑|对照|阴性|换一组|去掉')
  if ($flags -and $how) { return @{ pass = $true; note = '指出了自引用并给了办法' } }
  return @{ pass = $false; note = "flags=$flags how=$how" }
}
$verdict = switch ($sc.judge) {
  'no-bom' { Test-NoBom $ws }
  'stdin-through' { Test-Stdin $ws }
  'guard-prints-path' { Test-Guard $ws }
  'mentions-self-reference' { Test-SelfTest $ws }
  default { @{ pass = $false; note = '未知判据' } }
}

[pscustomobject]@{
  scenario = $Scenario; arm = $Arm; run = $Run
  pass = [bool]$verdict.pass; note = [string]$verdict.note
  timeout = [bool]$timedOut; seconds = [math]::Round($elapsed, 1)
  kill_left = $killLeft
} | ConvertTo-Json -Compress
