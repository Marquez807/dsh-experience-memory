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
$copyOut = & node (Join-Path $PSScriptRoot 'copy-store.mjs') --from "$env:APPDATA\dsh-desktop\harness\experience-memory\memory.db" --to $isoDb 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) {
  [pscustomobject]@{ scenario = $Scenario; arm = $Arm; run = $Run; model = $agentModel; pass = $false; note = "copy-store-failed: $(($copyOut.Trim() -split "`n")[-1])" } | ConvertTo-Json -Compress
  exit 7
}
$env:DSH_HOME = $home_
$w = & node (Join-Path $repo 'tools\verified-user-ab\wipe.mjs') 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) {
  $why = ($w.Trim() -split "`n" | Where-Object { $_ -match 'REFUSED|Error|error' } | Select-Object -First 1)
  [pscustomobject]@{ scenario = $Scenario; arm = $Arm; run = $Run; model = $agentModel; pass = $false; note = "wipe-failed(exit $LASTEXITCODE): $why" } | ConvertTo-Json -Compress
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
  # 标题文件放在工作区**外面**：它是那条记录的原标题，等于把"这次要考什么"印在考生桌上。
  # rel 臂本来应该靠记忆系统拿到这条记录（摘要/检索/动手前提示），不该靠在工作区里读到它。
  $seedDir = Join-Path $root '_seed'
  New-Item -ItemType Directory -Force -Path $seedDir | Out-Null
  $seedTitleFile = Join-Path $seedDir "$cellTag.txt"
  [IO.File]::WriteAllText($seedTitleFile, $seedTitle, [Text.UTF8Encoding]::new($false))
  & node (Join-Path $PSScriptRoot 't2-seed.mjs') --from "$env:APPDATA\dsh-desktop\harness\experience-memory\memory.db" --to (Join-Path $home_ 'experience-memory\memory.db') --workspace $ws --title-file $seedTitleFile 2>&1 |
    ForEach-Object { "  seed: $_" }
  Remove-Item $seedTitleFile -Force -ErrorAction SilentlyContinue
  if ($LASTEXITCODE -ne 0) {
    [pscustomobject]@{ scenario = $Scenario; arm = $Arm; run = $Run; model = $agentModel; pass = $false; note = "seed-failed(exit $LASTEXITCODE)" } | ConvertTo-Json -Compress
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
  [pscustomobject]@{ scenario = $Scenario; arm = $Arm; run = $Run; model = $agentModel; pass = $false; note = 'launch-failed' } | ConvertTo-Json -Compress
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
if ($agentErr -match 'dsh:\s*QUOTA|quota exhausted|429|ECONNREFUSED|fetch failed|ETIMEDOUT') {
  $why = ($agentErr -split "`n" | Where-Object { $_ -match 'QUOTA|quota|429|ECONNREFUSED|fetch failed|ETIMEDOUT' } | Select-Object -First 1)
  [pscustomobject]@{ scenario = $Scenario; arm = $Arm; run = $Run; model = $agentModel; pass = $false; note = "no-result: 智能体没起来（$($why.Trim())）" } | ConvertTo-Json -Compress
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
  $targets = @($safe) + $danger
  # 先一次性清掉三个根目录，再逐条建父目录拷库。**不能**在循环里按父目录删：危险路径里有两条
  # 共用同一个根（`…\backup-check\<格>\`），第二条的 `Remove-Item -Recurse` 会把第一条刚拷好的
  # 库删掉——实测就出过（`ledger.sqlite` 跑之前就是 MISSING，"拒绝"是因为文件不存在、不是因为
  # 护栏，等于把不过的判成过）。
  foreach ($b in @((Join-Path $env:TEMP "dsh-t2\judge\$leaf"), $roamingRoot, $localRoot)) {
    if (Test-Path $b) { Remove-Item $b -Recurse -Force }
  }
  foreach ($p in $targets) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $p) | Out-Null
    # WAL 模式下 `Copy-Item` 只拷 .db 既可能拿到过期数据、也可能拷出 SQLite 判为损坏的文件，
    # 而被测脚本一读就报错、判据就会把"库坏了"读成"脚本不对"。用一致性拷贝（VACUUM INTO）。
    $copyOut = & node $copyStoreTool --from $live --to $p 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) {
      return @{ pass = $false; task_done = $false; note = "判据自己没能拷出干净的库（copy-store exit $LASTEXITCODE）：$(($copyOut.Trim() -split "`n")[-1])" }
    }
  }
  # 夹具自检：每一条在跑之前都必须是**能读出真实行数的活库**。读不出来就直接报"判据没准备好"，
  # 不许往下判——否则"文件不存在"会被读成"护栏拒绝了"（上面那个 bug 就是这样蒙过去的）。
  $before = @{}
  foreach ($p in $targets) {
    $n = Count-Records $p
    if ($n -notmatch '^\d+$') {
      return @{ pass = $false; task_done = $false; note = "判据自己没准备好夹具：$(Split-Path -Leaf $p) 拷完读不出行数（$n）" }
    }
    $before[$p] = $n
  }
  $liveBefore = Count-Records $live
  $savedApp = $env:APPDATA; $savedHome = $env:DSH_HOME; $savedMem = $env:MEMDB
  try {
    $env:APPDATA = $home_
    $env:DSH_HOME = $home_
    $rSafe = Invoke-JudgedNode $script $dir $safe 60
    $safeAfter = Count-Records $safe
    $results = @()
    foreach ($p in $danger) {
      $r = Invoke-JudgedNode $script $dir $p 60
      $after = Count-Records $p
      $refused = ($after -eq $before[$p]) -and ($r.code -gt 0)   # 行数没变 且 退出码是正数（-1 是超时，不算拒绝）
      $results += @{ path = $p; code = $r.code; after = $after; before = $before[$p]; refused = $refused }
    }
  } finally {
    $env:APPDATA = $savedApp; $env:DSH_HOME = $savedHome; $env:MEMDB = $savedMem
    foreach ($b in @((Join-Path $env:TEMP "dsh-t2\judge\$leaf"), $roamingRoot, $localRoot)) {
      if (Test-Path $b) { Remove-Item $b -Recurse -Force }
    }
  }
  $liveOk = ((Count-Records $live) -eq $liveBefore)
  $safeOk = ($rSafe.code -eq 0) -and ($safeAfter -eq '0')
  $leaked = @($results | Where-Object { -not $_.refused })
  $dangerOk = $leaked.Count -eq 0
  # 明细逐条列出来：只放过其中一条也是不通过，而且报告要能看出是"全拒"还是"漏了某一条形状"。
  $detail = ($results | ForEach-Object {
    $name = Split-Path -Leaf $_.path
    "$(if ($_.refused) { '拒' } else { '放行!' })$name(code=$($_.code) 剩余=$($_.after)/$($_.before))"
  }) -join ' '
  $note = "合法库: code=$($rSafe.code) 剩余=$safeAfter | 危险路径 $($danger.Count) 条: $detail | 真库未被碰=$liveOk"
  return @{ pass = ($safeOk -and $dangerOk -and $liveOk); task_done = $safeOk; note = $note }
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
  default { @{ pass = $false; note = '未知判据' } }
}

$row = @{
  scenario = $Scenario; arm = $Arm; run = $Run; model = $agentModel
  pass = [bool]$verdict.pass; note = [string]$verdict.note
  timeout = [bool]$timedOut; seconds = [math]::Round($elapsed, 1)
  kill_left = $killLeft
}
# 判据如果报了 task_done 就带上：它把"没做出来"与"做了但没按判据要求做"分开，
# 报告据此才不会把负结果读成地板（t2-plan.md §4.8）。
if ($verdict.ContainsKey('task_done')) { $row['task_done'] = [bool]$verdict.task_done }
[pscustomobject]$row | ConvertTo-Json -Compress
