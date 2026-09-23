# One trial of the second `verified-user` scenario.
#
#   powershell -File tools/verified-user-ab/run-one.ps1 -Mode with|without -Trial N
#
# The convention (a file PLACEMENT rule, unlike the first scenario's config-content rule) exists
# only in a sentence the user says:
#
#   "记住一条我们组的约定：服务的示例配置一律放在 conf/samples/ 目录下面，
#     不要放在仓库根目录，也不要放在 src/ 里；根目录只放真正生效的配置文件。"
#
# `with`    : session 1 hears that and records it; session 2 (new session, same repo) does the task
# `without` : only session 2 runs
#
# The task is "加一个 redis 的示例配置". Success is judged from the filesystem alone: the file
# must land under conf/samples/. Root, src/ or anywhere else is wrong.
#
# Safety: the store lives under $env:TEMP and `wipe.mjs` refuses anything outside the temp tree.
param(
  [Parameter(Mandatory = $true)][ValidateSet('with', 'without')][string]$Mode,
  [Parameter(Mandatory = $true)][int]$Trial
)
$ErrorActionPreference = 'Continue'

$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)   # dsh-experience-memory
$root = Join-Path $env:TEMP 'dsh-exp-ab2'
$home_ = Join-Path $root 'home'
$prof = Join-Path $home_ 'profiles\placeab'
$ws = Join-Path $root "$Mode-$Trial"
$entry = 'F:\Users\Admin\AppData\Local\Programs\DSH Desktop\resources\app\node_modules\@deepseek-ai\dsh\lib\bin.js'

if (-not (Test-Path $home_)) {
  $src = "$env:APPDATA\dsh-desktop\harness"
  New-Item -ItemType Directory -Force -Path $home_, $prof, (Join-Path $home_ 'experience-memory') | Out-Null
  foreach ($f in @('settings.yaml', '.env', '.credentials.yaml', '.anonymous-user-id')) {
    if (Test-Path (Join-Path $src $f)) { Copy-Item (Join-Path $src $f) (Join-Path $home_ $f) -Force }
  }
  $pkg = @'
{
  "name": "dsh-profile-placeab",
  "private": true,
  "dependencies": { "dsh-experience-memory": "link:PLACEHOLDER_REPO" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless", "dsh-experience-memory"] } }
}
'@
  $pkg = $pkg.Replace('PLACEHOLDER_REPO', ($repo -replace '\\', '/'))
  [IO.File]::WriteAllText((Join-Path $prof 'package.json'), $pkg, [Text.UTF8Encoding]::new($false))
  $nm = Join-Path $prof 'node_modules'
  New-Item -ItemType Junction -Path $nm -Target 'F:\Users\Admin\AppData\Local\Programs\DSH Desktop\resources\app\node_modules' | Out-Null
  $link = Join-Path $nm 'dsh-experience-memory'
  if (Test-Path $link) { Remove-Item $link -Recurse -Force }
  New-Item -ItemType Junction -Path $link -Target $repo | Out-Null
}

function New-Repo([string]$dir) {
  if (Test-Path $dir) { Remove-Item $dir -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $dir, (Join-Path $dir 'ops'), (Join-Path $dir 'src') | Out-Null
  # The repo says NOTHING about where sample configs go. No conf/ either: the convention is
  # what says the directory exists.
  [IO.File]::WriteAllText((Join-Path $dir 'README.md'), @'
# payment-service

一个内部支付服务。CI 在 `.github/workflows/deploy.yml` 里跑 `ops/deploy.sh`。

## 目录

- `src/` 服务代码
- `ops/` 部署脚本

## 开发

本地起服务：`node dist/server.js`。
'@, [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText((Join-Path $dir 'ops\deploy.sh'), "#!/bin/sh`nset -e`nnode dist/server.js`n", [Text.UTF8Encoding]::new($false))
}

# Fresh disposable store, wiped by a script that refuses to touch anything real. A refusal must
# ABORT the trial: continuing would run against an unclean store and report a verdict that looks
# like a result — which is how a contaminated number gets into a report.
Copy-Item "$env:APPDATA\dsh-desktop\harness\experience-memory\memory.db" (Join-Path $home_ 'experience-memory\memory.db') -Force
$env:DSH_HOME = $home_
& node (Join-Path $PSScriptRoot 'wipe.mjs') 2>&1 | ForEach-Object { "  wipe: $_" }
if ($LASTEXITCODE -ne 0) {
  [pscustomobject]@{ mode = $Mode; trial = $Trial; verdict = 'aborted-wipe-refused' } | ConvertTo-Json -Compress
  exit 4
}

$spoken = '记住一条我们组的约定：服务的示例配置（sample config）一律放在 conf/samples/ 目录下面，不要放在仓库根目录，也不要放在 src/ 里；仓库根目录只放真正生效的配置文件。'
$task = '给这个服务加一个 redis 的示例配置。写完一句话说明你依据什么写的。'

if ($Mode -eq 'with') {
  # Session 1: the user says it, in the same repo the later session works in. A different
  # directory is a different workspace id and a workspace-scoped record is deliberately not
  # visible there.
  New-Repo $ws
  Push-Location $ws
  $out1 = & node $entry --profile placeab $spoken 2>&1 | Out-String
  Pop-Location
}

# Session 2: a NEW session, same repo, no mention of any convention.
New-Repo $ws
Push-Location $ws
$out2 = & node $entry --profile placeab $task 2>&1 | Out-String
Pop-Location

# Judged by walking the whole workspace, not by enumerating the directories a guesser expects.
# The first version looked at conf/, conf/samples/, the root and src/ and reported "no-file" for
# runs where the model had written to config/ — a wrong place, not a missing file. An
# unanticipated directory cannot fall through this way.
$allNew = @()
foreach ($dir in @($ws, (Join-Path $ws 'ops'), (Join-Path $ws 'src'))) {
  $allNew += @(Get-ChildItem $dir -File -ErrorAction SilentlyContinue)
}
$allNew += @(Get-ChildItem $ws -Recurse -File -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -notmatch '\\(ops|src)\\' -and $_.DirectoryName -ne $ws })
$allNew = $allNew | Sort-Object FullName -Unique | Where-Object {
  $_.Name -ne 'README.md' -and $_.FullName -notmatch '\\ops\\deploy\.sh$'
}
$rel = @($allNew | ForEach-Object { ($_.FullName.Substring($ws.Length) -replace '\\', '/') })
$exact = @($rel | Where-Object { $_ -like '/conf/samples/*' -or $_ -like 'conf/samples/*' })
$near  = @($rel | Where-Object { ($_ -like '/conf/*' -or $_ -like 'conf/*') -and ($_ -notlike '/conf/samples/*' -and $_ -notlike 'conf/samples/*') })

$verdict = if ($exact.Count -gt 0) { 'correct' }
  elseif ($near.Count -gt 0) { 'near-miss' }
  elseif ($rel.Count -eq 0) { 'no-file' }
  else { 'wrong-place' }

[pscustomobject]@{
  mode     = $Mode
  trial    = $Trial
  verdict  = $verdict
  written  = @($rel)
} | ConvertTo-Json -Compress
