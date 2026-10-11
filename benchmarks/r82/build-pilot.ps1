param([string]$EngineRoot='C:\Program Files\Epic Games\UE_4.27')
$ErrorActionPreference='Stop'
$workspace=(Resolve-Path '.').Path
$project=Join-Path $workspace '.scratch/pilot/DeadTrailsWest.uproject'
if (-not (Test-Path -LiteralPath $project)) { throw 'Run node benchmarks/r82/init-pilot.mjs first' }
$buildTemp=Join-Path $workspace '.scratch/build-temp'
New-Item -ItemType Directory -Path $buildTemp -Force | Out-Null
$oldTemp=$env:TEMP
$oldTmp=$env:TMP
try {
  $env:TEMP=$buildTemp
  $env:TMP=$buildTemp
  & (Join-Path $EngineRoot 'Engine/Build/BatchFiles/Build.bat') DeadTrailsWestEditor Win64 Development $project -WaitMutex -NoHotReload -NoUBTMakefiles -MaxParallelActions=2
  if ($LASTEXITCODE -ne 0) { throw "Native build failed: $LASTEXITCODE" }
} finally { $env:TEMP=$oldTemp; $env:TMP=$oldTmp }
