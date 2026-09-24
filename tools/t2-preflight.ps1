# T2 预检门 —— 跑任何扫之前先跑这一条：把"会不会白跑"回答掉。
#
# 为什么要有它（2026-09-23 教训）：那条"PowerShell 管道送不进原生程序 stdin"的教训早就在
# 经验库里了，但它只是**知识**，没变成流程里必跑的一步 —— 于是 T2 的 stdin 场景依赖
# `git credential fill`，而本机沙箱禁止 git 起凭据助手管道，四个臂会一起红（测的是环境不是记忆）。
# 同一晚还踩了：路径带空格没加引号（Start-Process 不会自动加引号）⇒ 每跑 0.1 秒空转；
# 播种标题里带英文双引号 ⇒ 被命令行吃掉、那个臂静默退化成"没有记忆"。
# 这三件事都能在**跑之前**查出来，所以做成门。全绿才开跑。
#
# 2026-09-24 又加了一条（⑦）：第一轮 60 格跑完才发现**四条场景里三条没有判别力**（两条天花板、
# 一条地板），一整晚白跑。所以"这条场景到底区不区分得出来"也必须开跑前回答，不能等跑完。
#
#   powershell -ExecutionPolicy Bypass -File tools\t2-preflight.ps1
#   powershell -ExecutionPolicy Bypass -File tools\t2-preflight.ps1 -SkipDiscrimination   # 只查①–⑥，快
param([string]$ScenarioFilter = '', [switch]$SkipDiscrimination)
$ErrorActionPreference = 'Continue'
$fail = 0
function Chk($ok, $what, $detail) {
  if ($ok) { Write-Host "  [绿] $what —— $detail" } else { Write-Host "  [红] $what —— $detail"; $script:fail = 1 }
}

$repo = Split-Path -Parent $PSScriptRoot
$harness = "$env:APPDATA\dsh-desktop\harness"
$liveDb = Join-Path $harness 'experience-memory\memory.db'
$root = Join-Path $env:TEMP 'dsh-t2'
$home_ = Join-Path $root 'home'
$entry = 'F:\Users\Admin\AppData\Local\Programs\DSH Desktop\resources\app\node_modules\@deepseek-ai\dsh\lib\bin.js'
$spec = Get-Content (Join-Path $PSScriptRoot 't2-scenarios.json') -Raw -Encoding UTF8 | ConvertFrom-Json

Write-Host '=== T2 预检门 ==='

# ① 每个臂要播种的标题都真实存在，而且**经文件名传**能播进去（这一条抓"引号被吃掉"）
$scratch = Join-Path $env:TEMP 't2-preflight-seed'
if (Test-Path $scratch) { Remove-Item $scratch -Recurse -Force }
New-Item -ItemType Directory -Force -Path $scratch | Out-Null
Copy-Item $liveDb (Join-Path $scratch 'seed.db') -Force
$titles = @()
foreach ($sc in $spec.scenarios) { if ($ScenarioFilter -eq '' -or $sc.id -eq $ScenarioFilter) { $titles += $sc.relevantRecordTitle } }
if ($ScenarioFilter -eq '') { $titles += $spec.controlPool }
$bad = @()
$i = 0
foreach ($t in $titles) {
  $i++
  $tf = Join-Path $scratch "t$i.txt"
  [IO.File]::WriteAllText($tf, [string]$t, [Text.UTF8Encoding]::new($false))
  $null = & node (Join-Path $PSScriptRoot 't2-seed.mjs') --from $liveDb --to (Join-Path $scratch 'seed.db') --workspace $scratch --title-file $tf 2>&1
  if ($LASTEXITCODE -ne 0) { $bad += "$($t.Substring(0, [Math]::Min(28, $t.Length)))…(exit $LASTEXITCODE)" }
}
Chk ($bad.Count -eq 0) '① 要播种的记录都播得进去' $(if ($bad.Count -eq 0) { "$($titles.Count) 条全部成功（含带引号的那条）" } else { "失败：$($bad -join '；')" })

# ② 护栏的**两个方向**都验：真库必须被拒、临时库必须放行
#    （只验一个方向的话，"永远拒绝"和"永远放行"都会看起来正常）
$saved = $env:DSH_HOME
$env:DSH_HOME = $harness
$null = & node (Join-Path $repo 'tools\verified-user-ab\wipe.mjs') 2>&1
Chk ($LASTEXITCODE -eq 3) '② 清库护栏：对着真库会拒绝' "退出码 $LASTEXITCODE（应为 3）"
$env:DSH_HOME = $home_
$null = & node (Join-Path $repo 'tools\verified-user-ab\wipe.mjs') 2>&1
Chk ($LASTEXITCODE -eq 0) '② 清库护栏：对着隔离库会放行' "退出码 $LASTEXITCODE（应为 0）"
$env:DSH_HOME = $saved

# ③ 启动无头智能体的那条命令**参数不会被空格拆开**（这条抓的是我自己犯过的错）
$probe = Join-Path $scratch 'argv.js'
[IO.File]::WriteAllText($probe, 'console.log(process.argv.slice(1).join("|"))', [Text.UTF8Encoding]::new($false))
$out = Join-Path $scratch 'argv.out.txt'
$prompt = '照工作区里 TASK.md 的要求做。'
$p = Start-Process -FilePath 'node' -ArgumentList @("`"$probe`"", "`"$entry`"", '--profile', 't2ab', "`"$prompt`"") -PassThru -NoNewWindow `
  -RedirectStandardOutput $out -RedirectStandardError (Join-Path $scratch 'argv.err.txt')
$p | Wait-Process -Timeout 60 -ErrorAction SilentlyContinue
$got = @((Get-Content $out -Raw -ErrorAction SilentlyContinue).Trim() -split '\|')
# process.argv.slice(1) 的第 0 个是脚本路径本身，真正的参数从第 1 个开始 —— 第一版判据把序号
# 数错，报了个假红（假红比漏报更坏：会让人开始不信整套预检）。所以这里连字段数一起断言。
Chk ($got.Count -eq 5 -and $got[1] -eq $entry -and $got[4] -eq $prompt) '③ 启动参数不被空格拆开' "收到 $($got.Count) 个字段（脚本+4 参数）；入口路径完整：$($got[1] -eq $entry)；任务正文完整：$($got[4] -eq $prompt)"

# ④ 判据依赖 python 的两条场景（linecount / wipeguard 的库行数）**环境**确实可用
#    stdin 场景已删除（本机沙箱地板），对应的 git 环境检查一并撤掉。
$jf = Join-Path $scratch 'jtry.json'
[IO.File]::WriteAllText($jf, '{"sources":[{"note":"ok"}]}', [Text.UTF8Encoding]::new($false))
$py = & python -c "import json,sys;print(len(json.load(open(sys.argv[1],encoding='utf-8'))['sources']))" $jf 2>&1
Chk (($LASTEXITCODE -eq 0) -and ("$py".Trim() -eq '1')) '④ 判据要用的 python + json 可用' "退出码 $LASTEXITCODE；读出 $("$py".Trim())"

# ⑤ 记录版本，并且**把隔离环境的模型对齐到真机**——这条有实测教训：隔离 home 里的 settings.yaml
#    是第一次建环境时拷的，真机后来换了模型它并不知道，于是"配额用尽"那批格子跑的是旧端点，而结果
#    行里没有任何字段能看出来。发现不一致就刷新那四个文件并**大声说明**：换模型意味着本轮读数按
#    新模型记账，**不与换模型之前的轮次直接可比**。
. (Join-Path $PSScriptRoot 't2-model.ps1')
$nodeV = (& node --version) 2>&1
$liveModel = Read-AgentModel (Join-Path $harness 'settings.yaml')
$isoModel = Read-AgentModel (Join-Path $home_ 'settings.yaml')
if ($liveModel -ne $isoModel) {
  foreach ($f in @('settings.yaml', '.env', '.credentials.yaml', '.anonymous-user-id')) {
    $src = Join-Path $harness $f
    if (Test-Path $src) { Copy-Item $src (Join-Path $home_ $f) -Force }
  }
  $isoModel = Read-AgentModel (Join-Path $home_ 'settings.yaml')
  Write-Host "  [黄] 隔离环境的模型与真机不一致，已按真机刷新：$liveModel（刷新后读到 $isoModel）"
  Write-Host '       含义：本轮读数按这个模型记账，**不与换模型之前的轮次直接可比**。'
}
Chk ($isoModel -ne 'unknown' -and $isoModel -eq $liveModel) '⑤ 环境版本与模型（存档用）' "node $nodeV；PowerShell $($PSVersionTable.PSVersion)；模型 $isoModel；隔离 home $home_"

# ⑤b 测试台自己的脚本必须**此刻就能被 Windows PowerShell 5.1 解析**。这条是 2026-09-25 凌晨那次
# 事故（9 个格子"无结果"）的护栏：带中文的 .ps1 若没有 UTF-8 BOM，5.1 会按系统代码页解码、把字符串
# 引号吃掉、整脚本解析失败——而且**时好时坏**（取决于调用进程的代码页），跑过一晚也不代表没问题。
# 更阴的一点：编辑工具每次改写 .ps1 都会把 BOM 抹掉，"加过一次"不等于"一直有"。所以每次开跑都验，
# 验不过就别跑（红了还跑＝白跑一整批）。
$scriptProblems = @()
foreach ($f in (Get-ChildItem (Join-Path $repo 'tools') -Filter '*.ps1')) {
  $bytes = [IO.File]::ReadAllBytes($f.FullName)
  $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
  $nonAscii = $false
  foreach ($x in $bytes) { if ($x -ge 0x80) { $nonAscii = $true; break } }
  if ($nonAscii -and -not $hasBom) { $scriptProblems += "$($f.Name)(无 BOM)"; continue }
  $perr = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$null, [ref]$perr)
  if ($perr -and $perr.Count) { $scriptProblems += "$($f.Name)(解析失败 $($perr.Count) 处)" }
}
$scriptCount = @(Get-ChildItem (Join-Path $repo 'tools') -Filter '*.ps1').Count
Chk ($scriptProblems.Count -eq 0) '⑤b 测试台脚本可被 5.1 解析（含中文的必须有 BOM）' $(if ($scriptProblems.Count -eq 0) { "$scriptCount 个脚本全部通过" } else { "有问题：$($scriptProblems -join '；')（用 [IO.File]::WriteAllText + UTF8Encoding($true) 补 BOM）" })

# ⑥ 上限自证：**声明了上限，就要证明它真的会掐断 —— 而且要验生产里用的那套机制**。
#    实测踩过两次：①声明 480 秒上限，扫里一格跑了 26 分钟没停；②换成 Wait-Job -Timeout 加一层，
#    两层的 -Timeout 参数都不生效（一格跑了 13 分钟）。所以生产改成**轮询**（Get-Date + Start-Sleep），
#    这里就用同一套轮询来验：上限 5 秒 + 探针跑 20 秒，必须被掐断。
$capProbe = Join-Path $scratch 'cap-probe.ps1'
[IO.File]::WriteAllText($capProbe, 'Start-Sleep -Seconds 20; "probe-done"', [Text.UTF8Encoding]::new($false))
$sw = [Diagnostics.Stopwatch]::StartNew()
$p2 = Start-Process -FilePath 'powershell' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$capProbe`"") -PassThru -NoNewWindow `
  -RedirectStandardOutput (Join-Path $scratch 'cap.out.txt') -RedirectStandardError (Join-Path $scratch 'cap.err.txt')
$capDeadline = (Get-Date).AddSeconds(5)
while (-not $p2.HasExited -and (Get-Date) -lt $capDeadline) { Start-Sleep -Seconds 1 }
$capFired = -not $p2.HasExited
if ($capFired) {
  try { $p2.Kill() } catch { }
  cmd /c "taskkill /T /F /PID $($p2.Id)" 2>&1 | Out-Null
  Start-Sleep -Seconds 1
}
$sw.Stop()
$capSecs = [math]::Round($sw.Elapsed.TotalSeconds, 1)
$probeOut = [IO.File]::ReadAllText((Join-Path $scratch 'cap.out.txt'))
Chk ($capFired -and $capSecs -lt 15 -and $probeOut -notmatch 'probe-done') '⑥ 超时上限真的会掐断（轮询机制）' "上限设 5 秒、探针要跑 20 秒：$capSecs 秒被掐断（应 <15 秒，且探针没跑完）"

# ⑦ 场景的**判别力**：开跑前每个臂跑 **2 格**（none×2 与 rel×2），2/2 才算数。
#    为什么是 2 而不是 1：单格判"天花板"太脆 —— 只有一次采样时，一次走运的通过就会把一条本来
#    有判别力的场景枪毙掉（实测：bom 第一轮 0/3 全失败，单格探针却抽到一次通过）。要判红就得
#    同一个结论出现两次。
#    判红只有三种情形：① 有一侧没跑满 2 格（没跑起来，不是结论）；② 不给记录的臂 2/2 全过（天花板）；
#    ③ 给记录的臂 2/2 全不过（记忆没起作用，或判据/任务有问题）。其余情形放行，但在报告里留下读数。
#    第一轮就是没做这一步：60 格跑完才发现 3/4 条场景是天花板或地板，一整晚白跑（t2-plan.md §一）。
#    ⚠️ 探针的单格上限**必须与正式扫一致**（用默认 480 秒，不许调小）：第一版探针写死 240 秒，
#    结果 wipeguard 两个臂都"没写出文件"，被读成"地板"——其实那是**探针自己的上限**造出来的假地板。
if (-not $SkipDiscrimination) {
  $disc = if ($ScenarioFilter -eq '') { $spec.scenarios } else { @($spec.scenarios | Where-Object { $_.id -eq $ScenarioFilter }) }
  foreach ($sc in $disc) {
    $tally = @{ none = @{ pass = 0; ran = 0 }; rel = @{ pass = 0; ran = 0 } }
    $notes = @()
    foreach ($arm in @('none', 'rel')) {
      foreach ($run in @(91, 92)) {
        $raw = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 't2-run.ps1') -Scenario $sc.id -Arm $arm -Run $run 2>&1 | Out-String
        $line = ($raw -split "`n" | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -Last 1)
        $parsed = if ($line) { try { $line.Trim() | ConvertFrom-Json } catch { $null } } else { $null }
        if ($null -eq $parsed) { $notes += "$arm/$run=没有结果" ; continue }
        $tally[$arm].ran += 1
        if ($parsed.pass) { $tally[$arm].pass += 1 }
        $td = if ($parsed.task_done -eq $true) { ' task_done=True' } else { '' }
        $notes += "$arm/$run=$(if ($parsed.pass) { '过' } else { '不过' })$td"
      }
    }
    $nP = $tally['none'].pass; $nR = $tally['none'].ran
    $rP = $tally['rel'].pass; $rR = $tally['rel'].ran
    $detail = "$($notes -join '  ')（不给记录 $nP/$nR，给记录 $rP/$rR）"
    if ($nR -lt 2 -or $rR -lt 2) {
      Chk $false "⑦ 场景 $($sc.id)：有臂没跑满 2 格 ⇒ 这不是结论，先查为什么没跑完" $detail
      Write-Host '       （没跑完的三种常见原因：上限掐断、判据报 code=-1、播种失败——note 里能看到是哪一种。）'
    } elseif ($nP -eq $nR) {
      Chk $false "⑦ 场景 $($sc.id) 是天花板：不给记录也 $nP/$nR 全过 ⇒ 先改场景/判据，别跑满 15 格" $detail
    } elseif ($rP -eq 0) {
      # rel 0/2 有两种完全不同的意思：① 任务本身没做出来（地板，不值得跑）；② 任务做出来了、
      # 只是没按判据要求做（**负结果**——记录在库里但没改变行为，这恰恰是"经验能不能拦住错误"
      # 最直接的证据，必须跑满 15 格把它测实）。用 task_done 区分。
      $anyDone = $notes -match 'task_done=True'
      if ($anyDone) {
        Write-Host "  [黄] ⑦ 场景 $($sc.id)：给记录 2 格全不过，但**任务做出来了**（task_done=true）—— 这是负结果（记录没改变行为），不是地板。放行，跑满 15 格把它测实"
        Write-Host "       $detail"
      } else {
        Chk $false "⑦ 场景 $($sc.id)：给记录也 2 格全不过 ⇒ 记忆没起作用，或判据/任务有问题，先查清再跑" $detail
      }
    } elseif ($nP -gt 0) {
      Write-Host "  [黄] ⑦ 场景 $($sc.id) 判别力弱（不给记录也过了 $nP/$nR）—— 放行，但要靠正式扫的 3 次聚合定论" 
      Write-Host "       $detail"
    } else {
      Chk $true "⑦ 场景 $($sc.id) 有判别力（不给记录 0/$nR，给记录 $rP/$rR）" $detail
    }
  }
} else {
  Write-Host '  [跳过] ⑦ 判别力探针（-SkipDiscrimination）'
}

if ($fail -eq 0) { Write-Host '=== 全绿：可以开跑 ===' } else { Write-Host '=== 有红线：先修，别开跑（红了还跑＝白跑）===' }
exit $fail
