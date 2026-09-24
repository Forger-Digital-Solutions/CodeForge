param(
  [string]$RepositoryRoot = "G:\CodeForge"
)

$ErrorActionPreference = "Stop"
$root = [IO.Path]::GetFullPath($RepositoryRoot)
$evidence = Join-Path $root "docs/evidence/r30-release-unblocking/08-install-lifecycle"
$installDir = Join-Path $evidence "installed-app"
$smokeDir = Join-Path $evidence "installed-smoke"
$setup = Join-Path $root "apps/desktop/release/CodeForge-Setup-0.4.0.exe"
$receiptPath = Join-Path $evidence "local-install-lifecycle.json"

if (-not $installDir.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Install target escaped repository."
}
if (Test-Path -LiteralPath $installDir) { throw "Install target already exists; refusing to overwrite it." }
if (-not (Test-Path -LiteralPath $setup -PathType Leaf)) { throw "Fresh installer is missing." }
$existing = @(Get-ChildItem "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall" -ErrorAction SilentlyContinue |
  ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object { $_.DisplayName -match "CodeForge" })
if ($existing.Count -gt 0) { throw "An existing CodeForge install is registered; refusing to replace it." }
if (Get-Process -Name CodeForge -ErrorAction SilentlyContinue) { throw "CodeForge is running; refusing to interrupt it." }

New-Item -ItemType Directory -Force -Path $evidence | Out-Null
$receipt = [ordered]@{
  Schema = "r30-local-install-lifecycle-1"
  StartedAt = (Get-Date).ToUniversalTime().ToString("o")
  Installer = $setup
  InstallerSha256 = (Get-FileHash -LiteralPath $setup -Algorithm SHA256).Hash.ToLowerInvariant()
  InstallDirectory = $installDir
  InstallerExitCode = $null
  InstalledPayloadPresent = $false
  InstalledAsarSha256 = $null
  InstalledExecutableSha256 = $null
  PayloadMatchesBuiltArchive = $false
  InstalledSmoke = [ordered]@{ full = $null; interrupt = $null; recover = $null }
  UninstallerExitCode = $null
  ExecutableRemoved = $false
  RegistryEntryRemoved = $false
  Error = $null
}
$installedExe = Join-Path $installDir "CodeForge.exe"
$uninstallString = $null
try {
  $process = Start-Process -FilePath $setup -ArgumentList @("/S", "/D=$installDir") -PassThru -Wait -WindowStyle Hidden
  $receipt.InstallerExitCode = $process.ExitCode
  if ($process.ExitCode -ne 0) { throw "Installer exited $($process.ExitCode)." }
  $native = Join-Path $installDir "resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
  $asar = Join-Path $installDir "resources/app.asar"
  $receipt.InstalledPayloadPresent = (Test-Path -LiteralPath $installedExe) -and (Test-Path -LiteralPath $asar) -and (Test-Path -LiteralPath $native)
  if (-not $receipt.InstalledPayloadPresent) { throw "Installed executable, archive, or native SQLite binding is missing." }
  $receipt.InstalledAsarSha256 = (Get-FileHash -LiteralPath $asar -Algorithm SHA256).Hash.ToLowerInvariant()
  $receipt.InstalledExecutableSha256 = (Get-FileHash -LiteralPath $installedExe -Algorithm SHA256).Hash.ToLowerInvariant()
  $receipt.PayloadMatchesBuiltArchive =
    $receipt.InstalledAsarSha256 -eq (Get-FileHash -LiteralPath (Join-Path $root "apps/desktop/release/win-unpacked/resources/app.asar") -Algorithm SHA256).Hash.ToLowerInvariant() -and
    $receipt.InstalledExecutableSha256 -eq (Get-FileHash -LiteralPath (Join-Path $root "apps/desktop/release/win-unpacked/CodeForge.exe") -Algorithm SHA256).Hash.ToLowerInvariant()
  if (-not $receipt.PayloadMatchesBuiltArchive) { throw "Installed executable or archive differs from the built payload." }
  $entry = @(Get-ChildItem "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall" -ErrorAction SilentlyContinue |
    ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object { $_.DisplayName -match "CodeForge" } | Select-Object -First 1)
  if ($entry.Count -ne 1) { throw "Installed CodeForge has no unique HKCU uninstall entry." }
  $uninstallString = if ($entry[0].QuietUninstallString) { $entry[0].QuietUninstallString } else { $entry[0].UninstallString }

  $env:CODEFORGE_SMOKE_EXECUTABLE = $installedExe
  $env:CODEFORGE_SMOKE_ROOT = $smokeDir
  foreach ($mode in @("full", "interrupt", "recover")) {
    & node (Join-Path $root "apps/desktop/scripts/packaged-smoke.js") $mode | Out-Null
    $receipt.InstalledSmoke[$mode] = $LASTEXITCODE
    if ($LASTEXITCODE -ne 0) { throw "Installed packaged smoke mode $mode failed." }
  }
} catch {
  $receipt.Error = $_.Exception.Message
} finally {
  if (-not $uninstallString) {
    $entry = @(Get-ChildItem "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall" -ErrorAction SilentlyContinue |
      ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object { $_.DisplayName -match "CodeForge" } | Select-Object -First 1)
    if ($entry.Count -eq 1) {
      $uninstallString = if ($entry[0].QuietUninstallString) { $entry[0].QuietUninstallString } else { $entry[0].UninstallString }
    }
  }
  if ($uninstallString) {
    if ($uninstallString -match '^\s*"([^"]+)"\s*(.*)$') { $uninstallExe = $Matches[1]; $uninstallArgs = $Matches[2] }
    elseif ($uninstallString -match '^\s*(\S+)\s*(.*)$') { $uninstallExe = $Matches[1]; $uninstallArgs = $Matches[2] }
    else { $receipt.Error = "Unparseable uninstall command: $uninstallString" }
    if ($uninstallExe) {
      if ($uninstallArgs -notmatch "/S") { $uninstallArgs = ("/S " + $uninstallArgs).Trim() }
      try {
        $process = Start-Process -FilePath $uninstallExe -ArgumentList $uninstallArgs -PassThru -Wait -WindowStyle Hidden
        $receipt.UninstallerExitCode = $process.ExitCode
        for ($attempt = 0; $attempt -lt 30; $attempt++) {
          if (-not (Test-Path -LiteralPath $installedExe)) { break }
          Start-Sleep -Seconds 2
        }
      } catch {
        $receipt.Error = "$($receipt.Error) Uninstall failed: $($_.Exception.Message)".Trim()
      }
    }
  }
  $receipt.ExecutableRemoved = -not (Test-Path -LiteralPath $installedExe)
  $remaining = @(Get-ChildItem "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall" -ErrorAction SilentlyContinue |
    ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object { $_.DisplayName -match "CodeForge" })
  $receipt.RegistryEntryRemoved = $remaining.Count -eq 0
  $receipt.FinishedAt = (Get-Date).ToUniversalTime().ToString("o")
  $receipt | ConvertTo-Json -Depth 7 | Set-Content -LiteralPath $receiptPath -Encoding utf8
}
if ($receipt.Error -or $receipt.InstallerExitCode -ne 0 -or -not $receipt.InstalledPayloadPresent -or -not $receipt.PayloadMatchesBuiltArchive -or
    @($receipt.InstalledSmoke.Values | Where-Object { $_ -ne 0 }).Count -gt 0 -or
    -not $receipt.ExecutableRemoved -or -not $receipt.RegistryEntryRemoved) {
  throw "R30 local install lifecycle failed; inspect $receiptPath"
}
$receipt | ConvertTo-Json -Depth 7
