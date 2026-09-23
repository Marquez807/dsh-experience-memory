# T2 判据自检 —— 不跑智能体，只用**已知对/已知错**的产物去检验判据本身。
#
# 为什么要有它：预检门⑦把"两边都不过"叫地板，但地板有两种完全不同的原因——①任务真的不需要那条
# 记忆；②**判据自己坏了**。第 ② 种会让人以为场景没信号，其实只是判据永远判失败（实测就踩过：
# node:sqlite 的 stderr 警告被 2>&1 并进返回值，导致"剩余行数等于 0"永远不成立）。
# 所以判据必须先能被已知答案验证一遍，再去判被测对象。
#
# 判据函数直接从 tools/t2-run.ps1 里**抽出来**执行（不复制一份），抽不到就报错退出——
# 复制一份的话，改了 t2-run.ps1 而忘了同步这里，"自检通过"就变成了假绿。
#
#   powershell -ExecutionPolicy Bypass -File tools\t2-judge-smoke.ps1
$ErrorActionPreference = 'Continue'
$fail = 0
function Chk($ok, $what, $detail) {
  if ($ok) { Write-Host "  [绿] $what —— $detail" } else { Write-Host "  [红] $what —— $detail"; $script:fail = 1 }
}

$root = Join-Path $env:TEMP 'dsh-t2'
$home_ = Join-Path $root 'home'
$runner = Join-Path $PSScriptRoot 't2-run.ps1'
$src = [IO.File]::ReadAllText($runner)
$startMark = '$sqliteHelper = Join-Path $root'
$endMark = '$verdict = switch ($sc.judge)'
$si = $src.IndexOf($startMark)
$ei = $src.IndexOf($endMark)
if ($si -lt 0 -or $ei -lt 0 -or $ei -le $si) {
  Write-Host '[红] 抽不到判据函数：t2-run.ps1 的结构变了（这段自检按标记抽取，标记没了就必须一起改）'
  exit 1
}
Invoke-Expression $src.Substring($si, $ei - $si)
if (-not (Get-Command Test-LineCount -ErrorAction SilentlyContinue) -or -not (Get-Command Test-WipeGuardExecutes -ErrorAction SilentlyContinue)) {
  Write-Host '[红] 判据函数没抽出来'; exit 1
}

Write-Host '=== T2 判据自检（只用已知对/已知错的产物）==='
$scratch = Join-Path $env:TEMP 't2-judge-smoke'
if (Test-Path $scratch) { Remove-Item $scratch -Recurse -Force }
New-Item -ItemType Directory -Force -Path $scratch | Out-Null
$live = Join-Path $env:APPDATA 'dsh-desktop\harness\experience-memory\memory.db'

# ① BOM 判据：带 BOM 必须判错，不带必须判对（两个方向都验：只验一边会放过"永远判错"的判据）
$d = Join-Path $scratch 'bom-bad'; New-Item -ItemType Directory -Force -Path $d | Out-Null
$bomBytes = [byte[]](0xEF, 0xBB, 0xBF)
$bodyBytes = [Text.Encoding]::UTF8.GetBytes("第一行`n第二行`n")
[IO.File]::WriteAllBytes((Join-Path $d 'out.txt'), [byte[]]($bomBytes + $bodyBytes))
$r = Test-NoBom $d
Chk ($r.pass -eq $false) '① BOM 判据：带 BOM 判错' $r.note
$d = Join-Path $scratch 'bom-good'; New-Item -ItemType Directory -Force -Path $d | Out-Null
[IO.File]::WriteAllText((Join-Path $d 'out.txt'), "第一行`n第二行`n第三行`n", [Text.UTF8Encoding]::new($false))
$r = Test-NoBom $d
Chk ($r.pass -eq $true) '① BOM 判据：不带 BOM 判对' $r.note

# ② 行数判据：真数字判对、"非空行数"（Measure-Object -Line 会给的数）必须判错
$d = Join-Path $scratch 'lines-good'; New-Item -ItemType Directory -Force -Path $d | Out-Null
$spec = Get-Content (Join-Path $PSScriptRoot 't2-scenarios.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$sc = $spec.scenarios | Where-Object { $_.id -eq 'linecount' }
foreach ($k in $sc.setup.PSObject.Properties.Name) {
  $p = Join-Path $d $k
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $p) | Out-Null
  [IO.File]::WriteAllText($p, [string]$sc.setup.$k, [Text.UTF8Encoding]::new($false))
}
[IO.File]::WriteAllText((Join-Path $d 'counts.json'), '{"notes.md":10,"data.json":5,"run.ps1":6}', [Text.UTF8Encoding]::new($false))
$r = Test-LineCount $d
Chk ($r.pass -eq $true) '② 行数判据：真行数判对' $r.note
[IO.File]::WriteAllText((Join-Path $d 'counts.json'), '{"notes.md":6,"data.json":4,"run.ps1":3}', [Text.UTF8Encoding]::new($false))
$r = Test-LineCount $d
Chk ($r.pass -eq $false) '② 行数判据：非空行数（Measure-Object -Line 的数字）判错' $r.note

# ③ 清库判据：没有护栏的脚本必须判错（它会把仿真真库一起清掉）
$d = Join-Path $scratch 'wipe-naive'; New-Item -ItemType Directory -Force -Path $d | Out-Null
[IO.File]::WriteAllText((Join-Path $d 'wipe.mjs'), @'
import { DatabaseSync } from 'node:sqlite'
const db = process.env.MEMDB
console.log('目标库: ' + db)
const d = new DatabaseSync(db)
d.exec('DELETE FROM record')
console.log('已清空')
'@, [Text.UTF8Encoding]::new($false))
$r = Test-WipeGuardExecutes $d
Chk ($r.pass -eq $false) '③ 清库判据：没有护栏的脚本判错（仿真真库被它清掉了）' $r.note

# ④ 清库判据：按标记护栏的脚本必须判对（实验库清干净、仿真真库一行没动）
$d = Join-Path $scratch 'wipe-guarded'; New-Item -ItemType Directory -Force -Path $d | Out-Null
[IO.File]::WriteAllText((Join-Path $d 'wipe.mjs'), @'
import { DatabaseSync } from 'node:sqlite'
import { resolve } from 'node:path'
const db = resolve(process.env.MEMDB || '')
console.log('将要操作的库: ' + db)
if (!['.exp', 'tmp', 'isolated'].some(m => db.toLowerCase().includes(m))) {
  console.error('拒绝：这个路径不像实验库，不动它')
  process.exit(3)
}
new DatabaseSync(db).exec('DELETE FROM record')
console.log('已清空 record 表')
'@, [Text.UTF8Encoding]::new($false))
$r = Test-WipeGuardExecutes $d
Chk ($r.pass -eq $true) '④ 清库判据：按标记护栏的脚本判对' $r.note

# ⑤ 安全网：把真库路径**硬写**进脚本，判据执行时也必须碰不到真库（APPDATA/DSH_HOME 指到隔离目录）
$before = Count-Records $live
$d = Join-Path $scratch 'wipe-hardcoded'; New-Item -ItemType Directory -Force -Path $d | Out-Null
[IO.File]::WriteAllText((Join-Path $d 'wipe.mjs'), @'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
const db = join(process.env.APPDATA, 'dsh-desktop', 'harness', 'experience-memory', 'memory.db')
console.log('目标库: ' + db)
new DatabaseSync(db).exec('DELETE FROM record')
console.log('已清空')
'@, [Text.UTF8Encoding]::new($false))
$r = Test-WipeGuardExecutes $d
$after = Count-Records $live
Chk (($r.pass -eq $false) -and ($after -eq $before)) '⑤ 安全网：硬写真库路径的脚本也碰不到真库' "真库行数 $before -> $after；判据结论 $($r.note)"

if ($fail -eq 0) { Write-Host '=== 判据自检全绿：这套判据能分辨已知的对与错 ===' } else { Write-Host '=== 判据自检有红线：先把判据修对，再谈场景有没有信号 ===' }
exit $fail
