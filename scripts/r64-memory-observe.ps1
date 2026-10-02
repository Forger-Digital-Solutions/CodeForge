$r64Output = Join-Path $PSScriptRoot '..\docs\evidence\free-capacity-fabric\R64-memory-observations.json'
$r64StartedAt = [DateTime]::UtcNow.ToString('o')
$r64PeakTree = 0L
$r64PeakProcess = 0L
$r64Samples = 0
do {
  $r64Processes = @(Get-CimInstance Win32_Process)
  $r64Roots = @($r64Processes | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*scripts/r64-bounded-tests.mjs*' } | Select-Object -ExpandProperty ProcessId)
  $r64Ids = @($r64Roots)
  do {
    $r64New = @($r64Processes | Where-Object { $r64Ids -contains $_.ParentProcessId -and $r64Ids -notcontains $_.ProcessId } | Select-Object -ExpandProperty ProcessId)
    $r64Ids += $r64New
  } while ($r64New.Count -gt 0)
  if ($r64Ids.Count -gt 0) {
    $r64Memory = @(Get-Process -Id $r64Ids -ErrorAction SilentlyContinue)
    $r64PeakTree = [Math]::Max($r64PeakTree, [long](($r64Memory | Measure-Object WorkingSet64 -Sum).Sum))
    $r64PeakProcess = [Math]::Max($r64PeakProcess, [long](($r64Memory | Measure-Object PeakWorkingSet64 -Maximum).Maximum))
    $r64Samples++
  }
  @{ startedAt = $r64StartedAt; observedAt = [DateTime]::UtcNow.ToString('o'); complete = $r64Roots.Count -eq 0; samples = $r64Samples; peakProcessTreeWorkingSetBytes = $r64PeakTree; peakSingleProcessWorkingSetBytes = $r64PeakProcess; method = 'Win32_Process ancestry for the bounded runner, all descendants, 15-second sampling' } | ConvertTo-Json | Set-Content -LiteralPath $r64Output -Encoding utf8
  if ($r64Roots.Count -gt 0) { Start-Sleep -Seconds 15 }
} while ($r64Roots.Count -gt 0)
