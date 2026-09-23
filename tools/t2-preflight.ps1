# T2 预检门 —— 跑任何扫之前先跑这一条：把"会不会白跑"回答掉。
#
# 为什么要有它（2026-09-23 教训）：那条"PowerShell 管道送不进原生程序 stdin"的教训早就在
# 经验库里了，但它只是**知识**，没变成流程里必跑的一步 —— 于是 T2 的 stdin 场景依赖
# `git credential fill`，而本机沙箱禁止 git 起凭据助手管道，四个臂会一起红（测的是环境不是记忆）。
# 同一晚还踩了：路径带空格没加引号（Start-Process 不会自动加引号）⇒ 每跑 0.1 秒空转；
# 播种标题里带英文双引号 ⇒ 被命令行吃掉、那个臂静默退化成"没有记忆"。
# 这三件事都能在**跑之前**查出来，所以做成门。全绿才开跑。
#
#   powershell -ExecutionPolicy Bypass -File tools\t2-preflight.ps1
param([string]$ScenarioFilter = '')
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

# ④ stdin 场景的**环境**确实可用（沙箱禁止 git 起凭据助手管道，实测人手跑也必失败）
$gitCfg = Join-Path $home_ 'gitconfig'
$gitCreds = Join-Path $home_ 'git-creds'
if (-not (Test-Path $gitCfg)) {
  [IO.File]::WriteAllText($gitCreds, "https://tester:secret@example.com`n", [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText($gitCfg, "[credential]`n`thelper = store --file=$($gitCreds -replace '\\','/')`n", [Text.UTF8Encoding]::new($false))
}
$g = Join-Path $scratch 'gittry'
New-Item -ItemType Directory -Force -Path $g | Out-Null
[IO.File]::WriteAllText((Join-Path $g 'in.txt'), "protocol=https`nhost=example.com`n`n", [Text.UTF8Encoding]::new($false))
Set-Location $g
$env:GIT_CONFIG_GLOBAL = $gitCfg
$env:GIT_CONFIG_NOSYSTEM = '1'
cmd /c "git credential fill < in.txt > out.txt 2> err.txt"
$gitOut = [IO.File]::ReadAllText((Join-Path $g 'out.txt'))
Chk (($LASTEXITCODE -eq 0) -and $gitOut -match 'host=example.com') '④ stdin 场景的环境可用（git 能回显被喂进去的内容）' "退出码 $LASTEXITCODE；输出 $(($gitOut -split "`n")[0..1] -join ' / ')"

# ⑤ 记录版本，免得事后说不清是哪套环境跑的
$nodeV = (& node --version) 2>&1
Chk $true '⑤ 环境版本（存档用）' "node $nodeV；PowerShell $($PSVersionTable.PSVersion)；隔离 home $home_"

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

if ($fail -eq 0) { Write-Host '=== 全绿：可以开跑 ===' } else { Write-Host '=== 有红线：先修，别开跑（红了还跑＝白跑）===' }
exit $fail
