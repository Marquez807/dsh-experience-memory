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
  # 臂的合法值现在由**场景自己**声明（`probeArms` 里一条记录一个臂），所以不能再用 ValidateSet 写死；
  # 改为在下面按场景校验（未知臂直接 exit 2），消息里列出这个场景认哪些臂。
  [Parameter(Mandatory = $true)][string]$Arm,
  [Parameter(Mandatory = $true)][int]$Run,
  # 单格上限。默认 480 秒；参数化是为了能用一个小值**实测"上限真的会杀进程"**（见 -TimeoutSec 20 的探针）。
  [int]$TimeoutSec = 480
)
$ErrorActionPreference = 'Continue'
# 这一格的结果行会被扫描进程**重定向到日志文件**再读回来，所以输出编码由自己定死，不听父进程的
# （实测：第 22 格的中文 note 变乱码——写的时候是 UTF-8、读的时候按 ANSI）。这里写 UTF-8 无 BOM；
# 对应的读法在 t2-sweep.ps1 里是 -Encoding UTF8。两处必须成对改。
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$repo = Split-Path -Parent $PSScriptRoot                       # dsh-experience-memory
$spec = Get-Content (Join-Path $PSScriptRoot 't2-scenarios.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$sc = $spec.scenarios | Where-Object { $_.id -eq $Scenario }
if (-not $sc) { Write-Host "未知场景 $Scenario"; exit 2 }
# 这个场景认哪些臂：固定四种 + 场景自己声明的 probeArms。未知臂立刻退，不猜。
$knownArms = @('none', 'rel', 'fam', 'ctrl1', 'ctrl2', 'ctrl3')
if ($sc.PSObject.Properties.Name -contains 'probeArms') {
  $knownArms += @($sc.probeArms | ForEach-Object { [string]$_.arm })
}
if ($knownArms -notcontains $Arm) {
  Write-Host "场景 $Scenario 不认识臂「$Arm」；它认：$($knownArms -join '、')"
  exit 2
}

# ── 底板指纹（t2-plan.md §4.17）──────────────────────────────────────────────
# 这一格是**从整轮冻结的那份底板**拷的（不是当时的活库），指纹写进每一行结果，好让"所有格子
# 同一底板"从声称变成可核对。指纹文件由 t2-sweep.ps1 冻结时写下；单独手跑这一格而没有底板时，
# 记 unknown 并照跑（旧行为），但绝不悄悄回到读活库。
$frozenDir = Join-Path $repo '_frozen'
$frozenDb = Join-Path $frozenDir 'base.db'
$baseSha = 'unknown'
$shaFile = Join-Path $frozenDir 'base.db.sha256'
if (Test-Path $shaFile) { $baseSha = ([IO.File]::ReadAllText($shaFile)).Trim() }
elseif (Test-Path $frozenDb) { $baseSha = (Get-FileHash $frozenDb -Algorithm SHA256).Hash.Substring(0, 12).ToLower() }

$entry = 'F:\Users\Admin\AppData\Local\Programs\DSH Desktop\resources\app\node_modules\@deepseek-ai\dsh\lib\bin.js'
$root = Join-Path $env:TEMP 'dsh-t2'
$home_ = Join-Path $root 'home'
$prof = Join-Path $home_ 'profiles\t2ab'

# 工作区目录名**不能**带场景/臂/次数。第一版是 `<场景>-<臂>-<次>`（如 `bom-none-99`），而模型会读到
# 自己的工作目录路径 —— 实测那一格的推理里原话就是「The workspace is "bom-none-99" — hint: no BOM」，
# 于是"不给记忆"的臂照样写出了无 BOM 文件，一条本来有判别力的场景被记成天花板。目录名只是一个位置，
# 让它可以被反推等于把答案写进题干。现在用 sha256(场景|臂|次数) 的前 12 位，确定性（出事时能重算回去）
# 但不可读。同理，"要播种的记录标题"也不许落在工作区里（见下面的 .seed-title）。
$sha = [Security.Cryptography.SHA256]::Create()
$tagBytes = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes("$Scenario|$Arm|$Run"))
$cellTag = ([BitConverter]::ToString($tagBytes) -replace '-', '').Substring(0, 12).ToLower()
$ws = Join-Path $root "cell-$cellTag"

# 这一格跑的是哪个模型：解析逻辑与预检门共用一份（tools/t2-model.ps1），写进每一行结果。
# 实测（2026-09-24 夜）：隔离 home 的 settings.yaml 是第一次建环境时拷的，真机换模型它不知道 ——
# 那批"配额用尽"的格子跑的是旧端点，而结果行里没有任何字段能看出来。
. (Join-Path $PSScriptRoot 't2-model.ps1')
$agentModel = Read-AgentModel (Join-Path $home_ 'settings.yaml')

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
# 真库是 WAL 模式：`Copy-Item` 只拷 .db 有两个后果，这次两个都撞上了——① 可能拿到过期数据；
# ② 上一格残留的 `-wal` 会让 SQLite 判定新拷来的 .db "database disk image is malformed"，
# 于是 6 个格子全挂在清空这一步。而且当时被记成"护栏拒绝"（任何非零退出都映射成那个标签），
# 真原因被吞掉了。现在：先删掉隔离库的三个文件，再用 copy-store.mjs 的一致性拷贝（VACUUM INTO，
# 与 tools/snapshot.mjs 同一招），失败时把**原话**写进 note。
$isoDir = Join-Path $home_ 'experience-memory'
New-Item -ItemType Directory -Force -Path $isoDir | Out-Null
$isoDb = Join-Path $isoDir 'memory.db'
foreach ($suffix in @('memory.db', 'memory.db-wal', 'memory.db-shm')) {
  $stale = Join-Path $isoDir $suffix
  if (Test-Path $stale) { Remove-Item $stale -Force }
}
# 底板不是活库，而是**整轮冻结**的那一份（t2-plan.md §4.17）：活库会在几小时的扫里被改，
# 每个格子各拷一次就会让前后格子的起点不同，而删除测试的全部意义是"两臂只差那一条记录"。
if (-not (Test-Path $frozenDb)) {
  [pscustomobject]@{ scenario = $Scenario; arm = $Arm; run = $Run; model = $agentModel; base_sha256 = $baseSha; pass = $false; note = 'frozen-missing: 先跑 t2-sweep.ps1 冻结底板（或手动 copy-store 到 _frozen/base.db）' } | ConvertTo-Json -Compress
  exit 8
}
$copyOut = & node (Join-Path $PSScriptRoot 'copy-store.mjs') --from $frozenDb --to $isoDb 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) {
  [pscustomobject]@{ scenario = $Scenario; arm = $Arm; run = $Run; model = $agentModel; base_sha256 = $baseSha; pass = $false; note = "copy-store-failed: $(($copyOut.Trim() -split "`n")[-1])" } | ConvertTo-Json -Compress
  exit 7
}
$env:DSH_HOME = $home_
$w = & node (Join-Path $repo 'tools\verified-user-ab\wipe.mjs') 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) {
  $why = ($w.Trim() -split "`n" | Where-Object { $_ -match 'REFUSED|Error|error' } | Select-Object -First 1)
  [pscustomobject]@{ scenario = $Scenario; arm = $Arm; run = $Run; model = $agentModel; base_sha256 = $baseSha; pass = $false; note = "wipe-failed(exit $LASTEXITCODE): $why" } | ConvertTo-Json -Compress
  exit 4
}
$seedTitles = @()
# 场景可以自己声明"探测臂"：一条记录一个臂，用来**一个场景同时测一族记录**（G5 需要很多条记录的
# 实测效果，而"一条记录配一个场景"太贵）。`probeArms` = [{ arm: 'p1', title: '...' }, ...]
$probe = $null
if ($sc.PSObject.Properties.Name -contains 'probeArms') {
  $probe = @($sc.probeArms | Where-Object { [string]$_.arm -eq $Arm } | Select-Object -First 1)
  if ($probe.Count -gt 0) { $seedTitles = @([string]$probe[0].title) }
}
if ($seedTitles.Count -eq 0 -and $Arm -eq 'rel') { $seedTitles = @([string]$sc.relevantRecordTitle) }
elseif ($seedTitles.Count -eq 0 -and $Arm -eq 'fam') {
  # `fam` = 同一教训的**多条分开喂**（T4 用）。场景表里用 familyRecordTitles 声明这一族。
  $seedTitles = @($sc.familyRecordTitles | ForEach-Object { [string]$_ })
  if ($seedTitles.Count -eq 0) { Write-Host "场景 $Scenario 没有声明 familyRecordTitles，fam 臂无从播种"; exit 2 }
}
elseif ($seedTitles.Count -eq 0 -and $Arm -like 'ctrl*') {
  $idx = [int]$Arm.Substring(4) - 1
  $seedTitles = @([string]$spec.controlPool[$idx])
}
# 播种必须成功才算一个有效的臂：标题对不上时 t2-seed.mjs 会非零退出，而"没播种成功"与
# "库里本来就没有记忆"在产物上**一模一样** —— ctrl2 就这样静默退化成 none 臂
# （2026-09-23 复核实测：场景表里是中文引号、库里是英文引号）。所以这里必须看退出码。
# 标题走**文件**而不是命令行：PowerShell 把参数交给原生程序时会重写引号，标题里的英文双引号
# 会被吃掉（实测 ctrl2 那条就这样 exit 2）。文件是唯一稳的过法。
# 一个文件可以装**多条**标题（一行一条）：fam 臂要一次播一族；任何一条失败都算这一格失败。
if ($seedTitles.Count -gt 0) {
  # 标题文件放在工作区**外面**：它是那条记录的原标题，等于把"这次要考什么"印在考生桌上。
  # rel 臂本来应该靠记忆系统拿到这条记录（摘要/检索/动手前提示），不该靠在工作区里读到它。
  $seedDir = Join-Path $root '_seed'
  New-Item -ItemType Directory -Force -Path $seedDir | Out-Null
  $seedTitleFile = Join-Path $seedDir "$cellTag.txt"
  [IO.File]::WriteAllText($seedTitleFile, ($seedTitles -join "`n"), [Text.UTF8Encoding]::new($false))
  & node (Join-Path $PSScriptRoot 't2-seed.mjs') --from "$env:APPDATA\dsh-desktop\harness\experience-memory\memory.db" --to (Join-Path $home_ 'experience-memory\memory.db') --workspace $ws --title-file $seedTitleFile 2>&1 |
    ForEach-Object { "  seed: $_" }
  Remove-Item $seedTitleFile -Force -ErrorAction SilentlyContinue
  if ($LASTEXITCODE -ne 0) {
    [pscustomobject]@{ scenario = $Scenario; arm = $Arm; run = $Run; model = $agentModel; base_sha256 = $baseSha; pass = $false; note = "seed-failed(exit $LASTEXITCODE, $($seedTitles.Count) 条)" } | ConvertTo-Json -Compress
    exit 5
  }
}

# ── 第一轮删掉的 stdin 场景（环境修复也一并撤掉）────────────────────────────
# 原场景要 `git credential fill` 从 stdin 收三行，而本机沙箱禁止 git 起凭据助手管道（实测人手跑
# 也必失败：cannot create standard input pipe for bash: Permission denied）⇒ 五个臂一起红，
# 测的是沙箱不是记忆（地板，见 tools/t2-plan.md §一）。该场景 2026-09-24 已删除，这段环境修复
# 一起撤掉：留着它只会让下一个读代码的人以为 stdin 场景还在。

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
  [pscustomobject]@{ scenario = $Scenario; arm = $Arm; run = $Run; model = $agentModel; base_sha256 = $baseSha; pass = $false; note = 'launch-failed' } | ConvertTo-Json -Compress
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

# ── 智能体压根没起来（配额/网络）：必须与"做错了"分开 ────────────────────────
# 实测（2026-09-24 夜）：模型配额用尽时无头 harness 只回一行 `dsh: QUOTA: 429 ... quota exhausted`
# 然后立刻退出，于是每一格的产物都缺失、每格只花 3 秒。产物缺失与"模型做错了"在产物上**一模一样**，
# 30 格会被读成"所有臂都失败"。所以这里先看 stderr，命中就记成占位行（no-result 前缀）：
# 报告不计入、续跑会重跑。
$agentErr = if (Test-Path (Join-Path $ws '.agent.err.txt')) { [IO.File]::ReadAllText((Join-Path $ws '.agent.err.txt')) } else { '' }
# ⚠️ 不要用裸 `429` 当判据：实测它匹配到了模型推理里一个十六进制 id（`8c5fd429…`），把一格**正常
# 跑完**的格子误标成"智能体没起来"。这里只认不会误伤的整串：配额原文与网络错误的固定字样。
if ($agentErr -match 'dsh:\s*QUOTA|quota exhausted|quota exceeded|rate limit|too many requests|ECONNREFUSED|fetch failed|ETIMEDOUT') {
  $why = ($agentErr -split "`n" | Where-Object { $_ -match 'QUOTA|quota|rate limit|too many requests|ECONNREFUSED|fetch failed|ETIMEDOUT' } | Select-Object -First 1)
  [pscustomobject]@{ scenario = $Scenario; arm = $Arm; run = $Run; model = $agentModel; base_sha256 = $baseSha; pass = $false; note = "no-result: 智能体没起来（$($why.Trim())）" } | ConvertTo-Json -Compress
  exit 8
}

# ── 判定用的两个小工具（都不碰真库）──────────────────────────────────────────
# 数一个库里 record 表有几行。走**文件**而不是 `node -e`：脚本正文里有双引号，PowerShell 5.1
# 把参数交给原生程序时会重写引号（同一个坑在播种标题上踩过，见 t2-seed.mjs 的 --title-file）。
$sqliteHelper = Join-Path $root '_judge-count.cjs'
[IO.File]::WriteAllText($sqliteHelper, @'
const { DatabaseSync } = require('node:sqlite')
try {
  const d = new DatabaseSync(process.argv[2], { readOnly: true })
  console.log(String(d.prepare('SELECT COUNT(*) AS n FROM record').get().n))
} catch (e) {
  console.log('ERR')
}
'@, [Text.UTF8Encoding]::new($false))
# 判据要用的外部工具路径。这一段会被 `t2-rejudge.ps1` / `t2-judge-smoke.ps1` 抽出去在别的脚本里
# 执行，而抽出去的函数里 `$PSScriptRoot` 是**空的**（实测：重判 15 格全报 "Join-Path 参数为空"）。
# 所以路径在抽取段的**顶层**算好，函数只管用；调用方可以自己先设 $toolsDir。
if (-not $toolsDir) { $toolsDir = $PSScriptRoot }
$copyStoreTool = Join-Path $toolsDir 'copy-store.mjs'
$judgeWipeGuard = Join-Path $toolsDir 'judge-wipe-guard.mjs'
$judgeMultiSkill = Join-Path $toolsDir 'judge-multiskill.mjs'
function Count-Records([string]$db) {
  if (-not (Test-Path $db)) { return 'MISSING' }
  # stderr 必须丢弃：node:sqlite 每次都会往 stderr 打一条 ExperimentalWarning，`2>&1` 会把它拼进
  # 返回值里，于是"剩余行数等于 0"这类比较**永远不成立**（实测：返回值是 "312\r\nnode.cmd : ..."）。
  return ((& node $sqliteHelper $db 2>$null | Out-String).Trim())
}

# 跑被测脚本，带硬上限。cap 用轮询实现（同主循环：-Timeout 那类参数在本机不生效）。
# 退出码**不读 $p.ExitCode**：Start-Process -PassThru 返回的对象上那个属性实测是空的
# （`code=` 空字符串，看起来像"没退出"），于是"拒绝执行"永远验不出来。改成让 cmd 把
# %ERRORLEVEL% 打回 stdout，从产物里读——这条路实测可靠（tools\t2-judge-smoke.ps1 第 ③/④ 条）。
# `call` 不能省：本机 `node` 是一个 **.cmd 外壳**（不是 exe），批处理里不用 call 调用另一个
# .cmd 会**把控制权交出去、后面的行一句都不执行** —— 实测 `echo __EXIT__%ERRORLEVEL%` 整行消失，
# 判据只好报 code=-3。用 call 之后退出码正常回传。
function Invoke-JudgedNode([string]$script, [string]$cwd, [string]$memdb, [int]$secs) {
  $so = Join-Path $cwd '.judged.out.txt'
  $se = Join-Path $cwd '.judged.err.txt'
  $bat = Join-Path $cwd '.judged.cmd'
  $batText = "@echo off`r`ncall node `"$script`"`r`nset __RC=%ERRORLEVEL%`r`necho __EXIT__%__RC%`r`n"
  [IO.File]::WriteAllText($bat, $batText, [Text.Encoding]::ASCII)
  $env:MEMDB = $memdb
  $p = Start-Process -FilePath 'cmd' -ArgumentList @('/c', "`"$bat`"") -WorkingDirectory $cwd -PassThru -NoNewWindow `
    -RedirectStandardOutput $so -RedirectStandardError $se
  if (-not $p) { return @{ code = -2; out = ''; timeout = $false } }
  $dl = (Get-Date).AddSeconds($secs)
  while (-not $p.HasExited -and (Get-Date) -lt $dl) { Start-Sleep -Milliseconds 500 }
  $to = -not $p.HasExited
  if ($to) {
    try { $p.Kill() } catch { }
    cmd /c "taskkill /T /F /PID $($p.Id)" 2>&1 | Out-Null
    Start-Sleep -Milliseconds 500
  }
  $o = ''
  if (Test-Path $so) { $o += [IO.File]::ReadAllText($so) }
  if (Test-Path $se) { $o += [IO.File]::ReadAllText($se) }
  $code = -1
  if (-not $to) {
    if ($o -match '__EXIT__(-?\d+)') { $code = [int]$Matches[1] } else { $code = -3 }  # 没打回退出码＝没跑起来
  }
  return @{ code = $code; out = $o; timeout = $to }
}

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

# 判据：**真的执行**被测脚本，而且判的是一条**性质**，不是一个固定夹具。
#
# 为什么要改（2026-09-24 实测）：上一版只有一条"仿真真库"，而它的路径里恰好含 `dsh-`（base 叫
# `dsh-t2-judge`）。三个给了记录的格子都写出了"路径含标记才放行"的护栏，标记表里含 `dsh-`
# ⇒ 仿真真库被判成实验库、放行。**这暴露的是判据的缺陷**：一条夹具既能被"刚好对上"蒙过，也会
# 把"用户真库路径里也有 dsh-（dsh-desktop）"这个真问题藏起来。所以改成：
#
#   合法库（必须在 OS 临时目录下的隔离目录里）→ 必须清干净（task_done）
#   危险路径**四条一组** → 每一条都必须一个字节没动、且以非零退出码拒绝
#
# 四条危险路径互不相同地覆盖两类误判，而且**都在系统临时目录之外**、都不含任何"看起来可丢弃"
# 的词（没有 temp/tmp/test/exp/sandbox/iso/dsh）：
#   a) 真库形状（含 `dsh-desktop\harness`）—— 抓"必须含某个标记才放行"这种白名单护栏
#   b) 普通用户数据形状（`…\backup-check\…\ledger.sqlite`、无后缀名）—— 抓"只否认 dsh 形状"的护栏
# 判据里出现的这些路径**一个字都不许写进经验正文**：经验只写规则（默认拒绝 + 只动可丢弃范围），
# 能对上一条夹具不算过关，能对上这一组才算。
#
# 安全设计不变：所有库都是真库的**副本**、都在隔离目录；执行期间连 APPDATA / DSH_HOME 一起指到
# 隔离 home（被测脚本若把真库路径硬写进去也碰不到真库）；拷库用一致性拷贝；跑完核对真库行数未变。
# 另外报一个 `task_done`（合法库清干净了没有），把"任务没做出来"与"做出来了但没按判据做"分开。
# ── T4 判据：跨会话交接有没有按规程落下来 ──────────────────────────────────
# 判的是一条**性质**，不是一条固定夹具：工作区**根目录**下要有一个文件，里面同时出现
# 「输出方」「接收方」两个栏名，以及两个会话的身份（记录员 / 研究员）。
#
# 为什么这样判：三条源记录讲的正是"放根目录（别放对方子目录）+ 文件名带输出方给接收方 +
# 页头两行写身份"。把交接写进对方子目录时，根目录下**没有**这样的文件 ⇒ 自然判为不过，
# 不需要额外去查子目录（那种查法会误伤"顺手也写了点别的"）。
# 只看产物，不看模型说了什么。
# ── G5 用的"一景多测"判据：PowerShell 文本编码一族 ──────────────────────────
# 为什么要有它：G5 要很多条记录带**实测效果**，而"一条记录配一个场景"太贵。所以一个场景里放一族的
# 记录（每条记录占一个臂），判据**分项记分**——每条记录只负责其中一个检查点，效果就按它那一项算。
#
# 这一族的问题天然是"同一件事的不同侧面"：
#   · 含中文的 .ps1 **必须带 BOM**（否则 PS 5.1 按 GBK 解码，中文变乱码、脚本解析失败）
#   · 写**数据**文件**不许带 BOM**（否则下游按文本读会多出三个字节）
#   · 读裸 LF 的行**不能用 Get-Content**（它不按裸 LF 切行，会少算/多算）
# 两条记录指向"要 BOM"、两条指向"读行",一条指向"不要 BOM"——**方向相反的两条同时在场**，
# 正是这一族值得测的原因。
# ── G5 用的"一景多测"：一个任务里两个**互不报错**的坑 ────────────────────────
# 判据实现放在 tools/judge-multiskill.mjs：要逐字比较含中文和英文双引号的字符串，而从 PowerShell
# 往 node 传中文参数会被重写（本工作区踩过多次），判据一旦被编码问题弄坏，会安静地把"对"判成"错"。
# 这两项都对应**不报错的错**：文件写出来了、命令也没报错，只有回读才发现不对——正是 failure_shape
# 表看不见的那一类（那张表只收得到工具报的错）。
function Test-MultiSkillAspects([string]$dir) {
  $raw = & node $judgeMultiSkill $dir 2>&1 | Out-String
  $line = ($raw -split "`n" | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -Last 1)
  if (-not $line) { return @{ pass = $false; task_done = $false; note = "判据没跑起来：$(($raw.Trim() -split "`n")[-1])" } }
  $j = $null
  try { $j = $line.Trim() | ConvertFrom-Json } catch { }
  if ($null -eq $j) { return @{ pass = $false; task_done = $false; note = '判据的输出不是 JSON' } }
  $aspects = [ordered]@{}
  $aspects['json_valid'] = [bool]$j.json_valid
  $aspects['config_exact'] = [bool]$j.config_exact
  $note = "json_valid=$($aspects['json_valid']) config_exact=$($aspects['config_exact']) | $($j.json_detail) | $($j.config_detail)"
  return @{
    pass = ($aspects['json_valid'] -and $aspects['config_exact'])
    # task_done：两个文件都动过（不要求动对）——把"没干活"与"干了但没按规则干"分开。
    task_done = (Test-Path (Join-Path $dir 'registry.json')) -and (Test-Path (Join-Path $dir 'config.txt'))
    note = $note
    aspects = $aspects
  }
}

function Test-PsEncodingAspects([string]$dir) {
  $aspects = [ordered]@{}
  $ps1 = Join-Path $dir 'extract.ps1'
  $out = Join-Path $dir 'line3.txt'
  $aspects['ps1_exists'] = (Test-Path $ps1)
  $script = ''
  $hasBom = $false
  if ($aspects['ps1_exists']) {
    $bytes = [IO.File]::ReadAllBytes($ps1)
    $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
    try { $script = [IO.File]::ReadAllText($ps1) } catch { $script = '' }
  }
  $aspects['ps1_chinese'] = ($script -match '[\u4e00-\u9fff]')
  $aspects['ps1_bom'] = $hasBom
  $line3 = ''
  $outBom = $false
  if (Test-Path $out) {
    $ob = [IO.File]::ReadAllBytes($out)
    $outBom = ($ob.Length -ge 3 -and $ob[0] -eq 0xEF -and $ob[1] -eq 0xBB -and $ob[2] -eq 0xBF)
    try { $line3 = ([IO.File]::ReadAllText($out)).Trim() } catch { $line3 = '' }
  }
  $aspects['line3_right'] = ($line3 -eq 'gamma')
  $aspects['out_no_bom'] = ((Test-Path $out) -and (-not $outBom))
  $note = ($aspects.Keys | ForEach-Object { "$_=$($aspects[$_])" }) -join ' '
  # pass 只由**有记录指向的三项**决定；ps1_exists / ps1_chinese 是"有没有干活"，进 task_done。
  $pass = $aspects['ps1_bom'] -and $aspects['line3_right'] -and $aspects['out_no_bom']
  $done = $aspects['ps1_exists'] -and $aspects['ps1_chinese']
  return @{ pass = [bool]$pass; task_done = [bool]$done; note = "$note | line3=[$line3]"; aspects = $aspects }
}

function Test-HandoffArtifact([string]$dir) {
  $baseline = @('README.md', 'TASK.md')
  $rootFiles = @(Get-ChildItem -Path $dir -File -ErrorAction SilentlyContinue |
    Where-Object { $baseline -notcontains $_.Name -and $_.Name -notlike '.*' })
  $scanned = @()
  $good = @()
  foreach ($f in $rootFiles) {
    if ($f.Length -gt 65536) { continue }
    $text = ''
    try { $text = [IO.File]::ReadAllText($f.FullName) } catch { continue }
    $hasWriter = $text -match '输出方'
    $hasReader = $text -match '接收方'
    $hasRecorder = $text -match '记录员'
    $hasResearcher = $text -match '研究员'
    $scanned += "$($f.Name)(输出方=$hasWriter 接收方=$hasReader 记录员=$hasRecorder 研究员=$hasResearcher)"
    if ($hasWriter -and $hasReader -and $hasRecorder -and $hasResearcher) { $good += $f.Name }
  }
  # 子目录（对方的工作区）里如果也放了看起来像交接的东西，单独报出来，供人看它是"只放那儿"还是"两处都放"。
  $peer = Join-Path $dir '研究员会话'
  $inPeer = @()
  if (Test-Path $peer) {
    $inPeer = @(Get-ChildItem -Path $peer -Recurse -File -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match '交接|工单|回执|handoff' } | ForEach-Object { $_.FullName.Substring($peer.Length + 1) })
  }
  $peerNote = if ($inPeer.Count -gt 0) { "；对方目录里还有：$($inPeer -join '、')" } else { '' }
  if ($good.Count -gt 0) {
    return @{ pass = $true; task_done = $true; note = "根目录里合格：$($good -join '、')$peerNote" }
  }
  if ($scanned.Count -eq 0) {
    return @{ pass = $false; task_done = $false; note = "根目录没有任何新文件（放哪儿了？）$peerNote" }
  }
  return @{ pass = $false; task_done = $true; note = "根目录有文件但都不合格：$($scanned -join '；')$peerNote" }
}

function Test-WipeGuardExecutes([string]$dir) {
  $script = Join-Path $dir 'wipe.mjs'
  if (-not (Test-Path $script)) { return @{ pass = $false; task_done = $false; note = 'wipe.mjs 不存在' } }
  $live = Join-Path $env:APPDATA 'dsh-desktop\harness\experience-memory\memory.db'
  $leaf = Split-Path -Leaf $dir
  $safe = Join-Path $env:TEMP "dsh-t2\judge\$leaf\.exp\tmp-isolated\store.sqlite"
  $roamingRoot = Join-Path $env:APPDATA "backup-check\$leaf"
  $localRoot = Join-Path $env:LOCALAPPDATA "backup-check\$leaf"
  $danger = @(
    (Join-Path $roamingRoot 'mirror\dsh-desktop\harness\experience-memory\memory.db'),
    (Join-Path $roamingRoot 'mirror\experience-memory\memory.db'),
    (Join-Path $localRoot 'ledger.sqlite'),
    (Join-Path $localRoot 'store-no-extension')
  )
  # **一次进程**做完整个判定（拷 5 个库、跑 5 次被测脚本、数行数），见 judge-wipe-guard.mjs 开头：
  # 老写法每格要起 ~28 个短命进程，几百次之后本机会刷错误弹窗（用户实测"狂跳错误弹窗"）。
  # 夹具自检、副本隔离、APPDATA/DSH_HOME 指到隔离 home、核对真库行数——这些安全设计都搬进了
  # 那个工具；这里只递参数、把一行 JSON 读回来。
  $raw = & node $judgeWipeGuard --script $script --live $live --safe $safe --danger ($danger -join ',') --isolated-home $home_ 2>&1 | Out-String
  $line = ($raw -split "`n" | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -Last 1)
  if (-not $line) {
    return @{ pass = $false; task_done = $false; note = "判据没能运行：$(($raw.Trim() -split "`n")[-1])" }
  }
  $j = $null
  try { $j = $line.Trim() | ConvertFrom-Json } catch { }
  if ($null -eq $j) { return @{ pass = $false; task_done = $false; note = "判据输出不是 JSON：$($line.Substring(0, [Math]::Min(120, $line.Length)))" } }
  if (-not $j.prepared) { return @{ pass = $false; task_done = $false; note = "判据自己没准备好：$($j.reason)" } }
  return @{ pass = [bool]$j.pass; task_done = [bool]$j.task_done; note = [string]$j.detail }
}

# 判据：文件本身还能被解析 + 说明真的提到了那一列。反引号把模板字符串截断时，报的错五花八门
# （`Expected a semicolon`、`Unexpected token`），所以判据只看两件客观的事，不去猜注释该怎么写。
function Test-TemplateParses([string]$dir) {
  $file = Join-Path $dir 'src\schema.mjs'
  if (-not (Test-Path $file)) { return @{ pass = $false; note = 'src/schema.mjs 不存在' } }
  $so = Join-Path $dir '.judge-check.out.txt'
  $se = Join-Path $dir '.judge-check.err.txt'
  $p = Start-Process -FilePath 'node' -ArgumentList @('--check', "`"$file`"") -WorkingDirectory $dir -PassThru -NoNewWindow `
    -RedirectStandardOutput $so -RedirectStandardError $se
  if (-not $p) { return @{ pass = $false; note = '判据没能启动 node --check' } }
  $dl = (Get-Date).AddSeconds(30)
  while (-not $p.HasExited -and (Get-Date) -lt $dl) { Start-Sleep -Milliseconds 300 }
  if (-not $p.HasExited) { try { $p.Kill() } catch { }; cmd /c "taskkill /T /F /PID $($p.Id)" 2>&1 | Out-Null; return @{ pass = $false; note = 'node --check 超时' } }
  $checkOut = ([IO.File]::ReadAllText($so) + [IO.File]::ReadAllText($se)).Trim()
  $parses = $checkOut -eq ''
  $body = ''
  if ($parses) {
    $body = (& node -e "import('file://' + process.argv[1].replace(/\\\\/g, '/')).then(m => console.log(typeof m.SCHEMA === 'string' ? m.SCHEMA : '')).catch(e => console.log('IMPORT_FAIL'))" $file 2>$null | Out-String).Trim()
  }
  $hasColumn = $body -match 'recent_at'
  $note = "解析=$(if ($parses) { 'OK' } else { "FAIL: $(($checkOut -split "`n")[0..1] -join ' / ')" }) | SCHEMA 提到 recent_at=$hasColumn"
  return @{ pass = ($parses -and $hasColumn); note = $note }
}
$verdict = switch ($sc.judge) {
  'no-bom' { Test-NoBom $ws }
  'template-parses' { Test-TemplateParses $ws }
  'wipe-guard-executes' { Test-WipeGuardExecutes $ws }
  'handoff-artifact' { Test-HandoffArtifact $ws }
  'ps-encoding-aspects' { Test-PsEncodingAspects $ws }
  'multiskill-aspects' { Test-MultiSkillAspects $ws }
  default { @{ pass = $false; note = '未知判据' } }
}

$row = @{
  scenario = $Scenario; arm = $Arm; run = $Run; model = $agentModel
  base_sha256 = $baseSha
  pass = [bool]$verdict.pass; note = [string]$verdict.note
  timeout = [bool]$timedOut; seconds = [math]::Round($elapsed, 1)
  kill_left = $killLeft
}
# 判据如果报了 task_done 就带上：它把"没做出来"与"做了但没按判据要求做"分开，
# 报告据此才不会把负结果读成地板（t2-plan.md §4.8）。
if ($verdict.ContainsKey('task_done')) { $row['task_done'] = [bool]$verdict.task_done }
# 分项结果（"一景多测"用）：每条记录负责哪个检查点，效果就按那一项算。没有就不写这个字段。
if ($verdict.ContainsKey('aspects')) {
  $a = [ordered]@{}
  foreach ($k in $verdict.aspects.Keys) { $a[$k] = [bool]$verdict.aspects[$k] }
  $row['aspects'] = $a
}
[pscustomobject]$row | ConvertTo-Json -Compress
