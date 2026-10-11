param([string]$EngineRoot='C:\Program Files\Epic Games\UE_4.27')
$ErrorActionPreference='Stop'
$workspace=(Resolve-Path '.').Path
$project=Join-Path $workspace '.scratch/r83pilot/DeadTrailsWest.uproject'
if (-not (Test-Path -LiteralPath $project)) { throw 'Run node benchmarks/r83/init-r83-pilot.mjs first' }
$buildTemp=Join-Path $workspace '.scratch/r83build-temp'
New-Item -ItemType Directory -Path $buildTemp -Force | Out-Null
$oldTemp=$env:TEMP
$oldTmp=$env:TMP
try {
  $env:TEMP=$buildTemp
  $env:TMP=$buildTemp
  & (Join-Path $EngineRoot 'Engine/Build/BatchFiles/Build.bat') DeadTrailsWestEditor Win64 Development $project -WaitMutex -NoHotReload -NoUBTMakefiles -MaxParallelActions=2
  if ($LASTEXITCODE -ne 0) { throw "R83 native build failed: $LASTEXITCODE" }
} finally { $env:TEMP=$oldTemp; $env:TMP=$oldTmp }
Write-Output "R83 pilot build completed"
