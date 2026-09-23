# Run N trials of each arm and summarise.
#   powershell -File tools/verified-user-ab/batch.ps1 [-Trials 6] [-Start 1]
param([int]$Trials = 6, [int]$Start = 1, [string]$Out = (Join-Path $env:TEMP 'dsh-exp-ab2-results.json'))
$ErrorActionPreference = 'Continue'
$rows = @()
foreach ($mode in @('without', 'with')) {
  for ($i = $Start; $i -lt ($Start + $Trials); $i++) {
    Write-Host "== $mode trial $i"
    $line = powershell -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'run-one.ps1') -Mode $mode -Trial $i 2>&1 |
      Select-String '^\{' | Select-Object -Last 1
    if ($line) { Write-Host "   $($line.Line)"; $rows += ($line.Line | ConvertFrom-Json) }
    else { Write-Host '   (no result)'; $rows += [pscustomobject]@{ mode = $mode; trial = $i; verdict = 'no-result'; exact = 0; near = 0 } }
  }
}
Write-Host ''
Write-Host '=== summary ==='
$rows | Format-Table mode, trial, verdict, exact, near, inRoot, inSrc -AutoSize | Out-String | Write-Host
foreach ($mode in @('without', 'with')) {
  $arm = $rows | Where-Object { $_.mode -eq $mode }
  $correct = ($arm | Where-Object { $_.verdict -eq 'correct' }).Count
  Write-Host ("{0,-8} n={1}  放对位置（conf/samples/）{2}" -f $mode, $arm.Count, $correct)
}
[IO.File]::WriteAllText($Out, ($rows | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
Write-Host "wrote $Out"
