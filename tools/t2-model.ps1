# 读一个 DSH settings.yaml 里选的模型（provider/model）。给 T2 的 run 与 preflight 共用一份，
# 免得两处各写一份解析、慢慢漂移。
#
# 为什么值得单独一个文件（2026-09-24 夜实测）：隔离 home 里的 settings.yaml 是**第一次建环境时
# 拷的**，真机后来换了模型它并不知道 —— 那批"配额用尽"的格子跑的是旧端点，而结果行里没有任何
# 字段能看出来。模型是实验条件，必须跟着数字走。
function Read-AgentModel([string]$settingsPath) {
  if (-not (Test-Path $settingsPath)) { return 'unknown' }
  $lines = [IO.File]::ReadAllLines($settingsPath)
  $start = -1
  for ($i = 0; $i -lt $lines.Length; $i++) {
    if ($lines[$i] -match '^\s*agent-default-model:\s*$') { $start = $i; break }
  }
  if ($start -lt 0) { return 'unknown' }
  $provider = ''; $model = ''
  for ($j = $start + 1; $j -lt [Math]::Min($start + 8, $lines.Length); $j++) {
    if ($lines[$j] -match '^\s*provider:\s*(\S+)') { $provider = $Matches[1] }
    if ($lines[$j] -match '^\s*model:\s*(\S+)') { $model = $Matches[1] }
    if ($provider -ne '' -and $model -ne '') { break }
  }
  if ($provider -eq '' -and $model -eq '') { return 'unknown' }
  return "$provider/$model"
}
