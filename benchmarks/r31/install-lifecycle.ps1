param(
  [string]$CandidateRoot = "apps/desktop/release",
  [string]$InstallerPath = "",
  [string]$PreviousInstallerPath = "",
  [string]$OutputRoot = "docs/evidence/r31-production-release-closure/10-lifecycle",
  [string]$ExpectedSid = "",
  [string]$ExpectedProfileRoot = "",
  [string]$ExpectedInstallerSha256 = "",
  [switch]$Execute,
  [switch]$LeaveInstalled
)

$ErrorActionPreference = "Stop"
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "../.."))
function FullPath([string]$value) {
  if ([IO.Path]::IsPathRooted($value)) { return [IO.Path]::GetFullPath($value).TrimEnd('\', '/') }
  return [IO.Path]::GetFullPath((Join-Path $repositoryRoot $value)).TrimEnd('\', '/')
}
function IsWithin([string]$candidate, [string]$root) {
  $path = [IO.Path]::GetFullPath($candidate).TrimEnd('\', '/')
  $base = [IO.Path]::GetFullPath($root).TrimEnd('\', '/')
  return $path.StartsWith($base + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
}
function FileHashOrNull([string]$path) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
  return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
}
function CodeForgeEntries([string]$hive) {
  @(Get-ChildItem -LiteralPath $hive -ErrorAction SilentlyContinue |
    ForEach-Object { Get-ItemProperty -LiteralPath $_.PSPath } |
    Where-Object { $_.DisplayName -like "CodeForge*" })
}
function SaveReceipt([string]$name, [object]$value) {
  $path = Join-Path $output $name
  $value | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $path -Encoding utf8
  return $path
}

$output = FullPath $OutputRoot
$candidate = FullPath $CandidateRoot
if (-not (IsWithin $output $repositoryRoot)) { throw "Evidence output must remain inside the repository." }
if (-not (IsWithin $candidate $repositoryRoot)) { throw "Candidate release directory must remain inside the repository." }
New-Item -ItemType Directory -Force -Path $output | Out-Null
$currentVersion = (Get-Content -LiteralPath (Join-Path $repositoryRoot "apps/desktop/package.json") -Raw | ConvertFrom-Json).version
$installer = if ($InstallerPath) { FullPath $InstallerPath } else { Join-Path $candidate "CodeForge-Setup-$currentVersion.exe" }
$previousInstaller = if ($PreviousInstallerPath) { FullPath $PreviousInstallerPath } else { $null }
$unpackedExe = Join-Path $candidate "win-unpacked/CodeForge.exe"
$unpackedAsar = Join-Path $candidate "win-unpacked/resources/app.asar"
$installDir = Join-Path $output "installed-app"
$installedExe = Join-Path $installDir "CodeForge.exe"
$installedAsar = Join-Path $installDir "resources/app.asar"
$uninstaller = Join-Path $installDir "Uninstall CodeForge.exe"
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$profile = [Environment]::GetFolderPath("UserProfile")
$folders = [ordered]@{
  UserProfileEnvironment = $env:USERPROFILE
  ApplicationData = [Environment]::GetFolderPath("ApplicationData")
  ApplicationDataEnvironment = $env:APPDATA
  LocalApplicationData = [Environment]::GetFolderPath("LocalApplicationData")
  LocalApplicationDataEnvironment = $env:LOCALAPPDATA
  Desktop = [Environment]::GetFolderPath("Desktop")
  StartMenu = [Environment]::GetFolderPath("StartMenu")
}
$markerPath = Join-Path $profile ".codeforge-r31-disposable-profile.json"
$marker = $null
if (Test-Path -LiteralPath $markerPath -PathType Leaf) {
  try { $marker = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json } catch { $marker = $null }
}
$candidateHashes = [ordered]@{
  Installer = FileHashOrNull $installer
  UnpackedExecutable = FileHashOrNull $unpackedExe
  UnpackedArchive = FileHashOrNull $unpackedAsar
  PreviousInstaller = if ($previousInstaller) { FileHashOrNull $previousInstaller } else { $null }
}
$violations = [System.Collections.Generic.List[string]]::new()
if (-not (Test-Path -LiteralPath $profile -PathType Container)) { $violations.Add("current identity profile directory is unavailable") }
foreach ($key in $folders.Keys) {
  $folder = [string]$folders[$key]
  if (-not $folder -or ($key -eq "UserProfileEnvironment" -and (FullPath $folder) -ne (FullPath $profile)) -or
      ($key -ne "UserProfileEnvironment" -and -not (IsWithin $folder $profile))) {
    $violations.Add("$key resolves outside the current identity profile")
  }
}
if (-not $ExpectedSid -or $identity.User.Value -ne $ExpectedSid) { $violations.Add("explicit disposable-account SID was not supplied or does not match") }
if (-not $ExpectedProfileRoot -or (FullPath $ExpectedProfileRoot) -ne (FullPath $profile)) {
  $violations.Add("explicit disposable profile path was not supplied or does not match")
}
if (-not $marker -or $marker.schema -ne "codeforge-r31-disposable-profile-1" -or
    $marker.sid -ne $identity.User.Value -or $marker.disposable -ne $true) {
  $violations.Add("disposable profile marker is absent or invalid")
}
if (-not $candidateHashes.Installer -or -not $candidateHashes.UnpackedExecutable -or -not $candidateHashes.UnpackedArchive) {
  $violations.Add("candidate installer or unpacked payload is missing")
}
if (-not $ExpectedInstallerSha256 -or $candidateHashes.Installer -ne $ExpectedInstallerSha256.ToLowerInvariant()) {
  $violations.Add("candidate installer SHA-256 was not pinned or does not match")
}
if ($previousInstaller -and -not $candidateHashes.PreviousInstaller) { $violations.Add("previous installer is missing") }
if (Test-Path -LiteralPath $installDir) { $violations.Add("isolated install directory already exists") }
$hkcuEntries = @(CodeForgeEntries "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall")
$hklmEntries = @(CodeForgeEntries "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall")
if ($hkcuEntries.Count -gt 0 -or $hklmEntries.Count -gt 0) { $violations.Add("CodeForge install is already registered") }
$running = @(Get-Process -Name "CodeForge" -ErrorAction SilentlyContinue)
if ($running.Count -gt 0) { $violations.Add("CodeForge process is already running") }
$preflight = [ordered]@{
  schema = "codeforge-r31-install-preflight-1"
  checkedAt = (Get-Date).ToUniversalTime().ToString("o")
  identity = [ordered]@{ name = $identity.Name; sid = $identity.User.Value; profile = $profile }
  folders = $folders
  markerPath = $markerPath
  markerValid = -not ($violations -contains "disposable profile marker is absent or invalid")
  candidate = [ordered]@{ version = $currentVersion; installer = $installer; previousInstaller = $previousInstaller; hashes = $candidateHashes }
  installDirectory = $installDir
  existingInstallCount = $hkcuEntries.Count + $hklmEntries.Count
  runningProcessCount = $running.Count
  readyForExecution = $violations.Count -eq 0
  violations = @($violations)
  action = if ($Execute) { "execute_requested" } else { "preflight_only" }
}
$preflightPath = SaveReceipt "preflight.json" $preflight
Write-Output ("R31 lifecycle preflight: " + $(if ($preflight.readyForExecution) { "READY" } else { "BLOCKED" }))
Write-Output "Receipt: $preflightPath"
if (-not $Execute) { return }
if (-not $preflight.readyForExecution) { throw "R31 lifecycle execution refused: $($violations -join '; ')" }

function RequireOwnedInstall() {
  $entries = @(CodeForgeEntries "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall")
  if ($entries.Count -ne 1) { throw "Expected one isolated HKCU CodeForge install; found $($entries.Count)." }
  if (-not (Test-Path -LiteralPath $installedExe -PathType Leaf) -or
      -not (Test-Path -LiteralPath $installedAsar -PathType Leaf) -or
      -not (Test-Path -LiteralPath $uninstaller -PathType Leaf)) {
    throw "Installed executable, archive, or owned uninstaller is missing."
  }
  if ($entries[0].InstallLocation -and (FullPath ([string]$entries[0].InstallLocation)) -ne (FullPath $installDir)) {
    throw "HKCU install location differs from the isolated directory."
  }
}
function Install([string]$source, [string]$phase, [bool]$compareCandidate) {
  $started = (Get-Date).ToUniversalTime().ToString("o")
  $proc = Start-Process -FilePath $source -ArgumentList ("/S /D=" + $installDir) -PassThru -Wait -WindowStyle Hidden
  if ($proc.ExitCode -ne 0) { throw "$phase installer exited $($proc.ExitCode)." }
  for ($attempt = 0; $attempt -lt 30 -and -not (Test-Path -LiteralPath $installedExe -PathType Leaf); $attempt++) {
    Start-Sleep -Seconds 2
  }
  RequireOwnedInstall
  $hashes = [ordered]@{ executable = FileHashOrNull $installedExe; archive = FileHashOrNull $installedAsar }
  if ($compareCandidate -and ($hashes.executable -ne $candidateHashes.UnpackedExecutable -or
      $hashes.archive -ne $candidateHashes.UnpackedArchive)) {
    throw "$phase installed payload differs from the pinned candidate unpacked payload."
  }
  return [ordered]@{ phase = $phase; startedAt = $started; installerSha256 = FileHashOrNull $source; exitCode = $proc.ExitCode; installedHashes = $hashes; registryVersion = (@(CodeForgeEntries "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall"))[0].DisplayVersion }
}
function Uninstall([string]$phase) {
  RequireOwnedInstall
  $proc = Start-Process -FilePath $uninstaller -ArgumentList "/S /currentuser" -PassThru -Wait -WindowStyle Hidden
  for ($attempt = 0; $attempt -lt 30 -and ((Test-Path -LiteralPath $installedExe) -or
      @(CodeForgeEntries "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall").Count -gt 0); $attempt++) {
    Start-Sleep -Seconds 2
  }
  $removed = -not (Test-Path -LiteralPath $installedExe) -and
    @(CodeForgeEntries "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall").Count -eq 0
  if (-not $removed) { throw "$phase did not remove the owned install and HKCU entry." }
  return [ordered]@{ phase = $phase; exitCode = $proc.ExitCode; executableRemoved = $true; registryEntryRemoved = $true }
}

$receipt = [ordered]@{
  schema = "codeforge-r31-install-lifecycle-1"
  startedAt = (Get-Date).ToUniversalTime().ToString("o")
  preflightSha256 = FileHashOrNull $preflightPath
  phases = @()
  dataSentinel = $null
  previousToCurrentUpgradeExecuted = [bool]$previousInstaller
  finalStatus = "IN_PROGRESS"
  error = $null
}
$receiptPath = SaveReceipt "lifecycle.json" $receipt
$sentinelPath = Join-Path ([string]$folders.ApplicationData) "codeforge-desktop/r31-lifecycle-sentinel.json"
$sentinelId = [guid]::NewGuid().ToString("N")
function CheckSentinel([string]$phase) {
  if (-not (Test-Path -LiteralPath $sentinelPath -PathType Leaf)) { throw "$phase removed retained user data." }
  $stored = Get-Content -LiteralPath $sentinelPath -Raw | ConvertFrom-Json
  if ($stored.id -ne $sentinelId) { throw "$phase changed retained user data." }
}
try {
  $first = if ($previousInstaller) { $previousInstaller } else { $installer }
  $receipt.phases += Install $first "fresh_install" (-not [bool]$previousInstaller)
  $sentinelDir = Split-Path -Parent $sentinelPath
  New-Item -ItemType Directory -Force -Path $sentinelDir | Out-Null
  @{ schema = "codeforge-r31-data-sentinel-1"; id = $sentinelId } | ConvertTo-Json |
    Set-Content -LiteralPath $sentinelPath -Encoding utf8
  $receipt.dataSentinel = $sentinelPath
  if ($previousInstaller) {
    $receipt.phases += Install $installer "previous_to_current" $true
    CheckSentinel "previous_to_current"
  }
  $receipt.phases += Install $installer "same_version_repair" $true
  CheckSentinel "same_version_repair"
  $receipt.phases += Uninstall "uninstall"
  CheckSentinel "uninstall"
  $receipt.phases += Install $installer "reinstall_after_uninstall" $true
  CheckSentinel "reinstall_after_uninstall"

  $smokeRoot = Join-Path $output "installed-smoke"
  New-Item -ItemType Directory -Force -Path $smokeRoot | Out-Null
  $priorExecutable = $env:CODEFORGE_SMOKE_EXECUTABLE
  $priorSmokeRoot = $env:CODEFORGE_SMOKE_ROOT
  try {
    $env:CODEFORGE_SMOKE_EXECUTABLE = $installedExe
    $env:CODEFORGE_SMOKE_ROOT = $smokeRoot
    foreach ($mode in @("full", "interrupt", "recover")) {
      & node (Join-Path $repositoryRoot "apps/desktop/scripts/packaged-smoke.js") $mode
      $receipt.phases += [ordered]@{ phase = "installed_smoke_$mode"; exitCode = $LASTEXITCODE }
      if ($LASTEXITCODE -ne 0) { throw "Installed smoke $mode failed." }
      $null = SaveReceipt "lifecycle.json" $receipt
    }
  } finally {
    $env:CODEFORGE_SMOKE_EXECUTABLE = $priorExecutable
    $env:CODEFORGE_SMOKE_ROOT = $priorSmokeRoot
  }
  $receipt.finalStatus = if ($previousInstaller) { "PACKAGE_LIFECYCLE_PASS" } else { "PACKAGE_LIFECYCLE_PASS_UPGRADE_NOT_RUN" }
} catch {
  $receipt.error = $_.Exception.Message
  $receipt.finalStatus = "FAIL"
} finally {
  if (-not $LeaveInstalled -and (Test-Path -LiteralPath $uninstaller -PathType Leaf)) {
    try { $receipt.phases += Uninstall "final_cleanup" } catch { $receipt.cleanupError = $_.Exception.Message; $receipt.finalStatus = "FAIL" }
  }
  $receipt.finishedAt = (Get-Date).ToUniversalTime().ToString("o")
  $null = SaveReceipt "lifecycle.json" $receipt
}
Write-Output "Receipt: $receiptPath"
if ($receipt.finalStatus -eq "FAIL") { throw "R31 lifecycle failed: $($receipt.error) $($receipt.cleanupError)" }
Write-Output $receipt.finalStatus
