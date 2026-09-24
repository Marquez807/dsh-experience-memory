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
# 抽出去之后 $PSScriptRoot 在函数里是空的，所以要在这里先把工具目录交给它。
$toolsDir = $PSScriptRoot
Invoke-Expression $src.Substring($si, $ei - $si)
if (-not (Get-Command Test-TemplateParses -ErrorAction SilentlyContinue) -or -not (Get-Command Test-WipeGuardExecutes -ErrorAction SilentlyContinue)) {
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

# ② 模板判据：文件能解析且提到列名 → 判对；模板字符串里注释用了反引号把字符串截断 → 判错
$d = Join-Path $scratch 'tpl-good'; New-Item -ItemType Directory -Force -Path (Join-Path $d 'src') | Out-Null
[IO.File]::WriteAllText((Join-Path $d 'src\schema.mjs'), @'
/** 建表语句：一整条模板字符串，SQL 注释也在里面。 */
export const SCHEMA = `
CREATE TABLE record (
  id TEXT PRIMARY KEY,
  -- recent_at 是最近一次活动的时间
  recent_at INTEGER
);
`
'@, [Text.UTF8Encoding]::new($false))
$r = Test-TemplateParses $d
Chk ($r.pass -eq $true) '② 模板判据：好文件（普通词注释、提到列名）判对' $r.note

$d = Join-Path $scratch 'tpl-bad'; New-Item -ItemType Directory -Force -Path (Join-Path $d 'src') | Out-Null
[IO.File]::WriteAllText((Join-Path $d 'src\schema.mjs'), @'
/** 建表语句：一整条模板字符串，SQL 注释也在里面。 */
export const SCHEMA = `
CREATE TABLE record (
  id TEXT PRIMARY KEY,
  -- `recent_at` 是最近一次活动的时间
  recent_at INTEGER
);
`
'@, [Text.UTF8Encoding]::new($false))
$r = Test-TemplateParses $d
Chk ($r.pass -eq $false) '② 模板判据：注释里用反引号（截断模板字符串）判错' $r.note

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

# ⑥ 回归用例（**这条是被真实事故逼出来的**）：标记白名单里含 `dsh-` 的护栏必须判错。
# 2026-09-24 实测：三个给了记录的格子都写了这种护栏，而用户真库路径 `…\dsh-desktop\harness\…`
# 本身含 `dsh-` ⇒ 这种护栏**拦不住真库**。上一版判据只有一条夹具、且夹具 base 叫 `dsh-t2-judge`，
# 于是把它误判成"通过了"。新判据用一组危险路径（含 dsh 形状 + 不含 dsh 的普通用户数据形状），
# 这条用例保证"漏掉其中一条形状"一定判错。
$d = Join-Path $scratch 'wipe-dsh-marker'; New-Item -ItemType Directory -Force -Path $d | Out-Null
[IO.File]::WriteAllText((Join-Path $d 'wipe.mjs'), @'
import { DatabaseSync } from 'node:sqlite'
import { resolve } from 'node:path'
const db = resolve(process.env.MEMDB || '')
console.log('将要操作的库: ' + db)
if (!['temp', 'tmp', '.exp', 'isolated', 'dsh-'].some(m => db.toLowerCase().includes(m))) {
  console.error('拒绝：目标路径不含隔离标记')
  process.exit(3)
}
new DatabaseSync(db).exec('DELETE FROM record')
console.log('已清空')
'@, [Text.UTF8Encoding]::new($false))
$r = Test-WipeGuardExecutes $d
Chk ($r.pass -eq $false) '⑥ 回归：标记表含 dsh- 的假护栏判错（真库路径也含 dsh-，它拦不住）' $r.note

if ($fail -eq 0) { Write-Host '=== 判据自检全绿：这套判据能分辨已知的对与错 ===' } else { Write-Host '=== 判据自检有红线：先把判据修对，再谈场景有没有信号 ===' }
exit $fail
