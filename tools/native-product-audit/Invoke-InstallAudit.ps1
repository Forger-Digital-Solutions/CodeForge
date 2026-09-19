[CmdletBinding()]
param(
    [string]$InstallerPath,
    [string]$ExpectedSha256,
    [Parameter(Mandatory)][string]$OutputDirectory,
    [string]$Label = "install-audit",
    # Actually run the installer (silently) before auditing the installed state.
    [switch]$Install,
    [switch]$Interactive
)
<#
.SYNOPSIS Audit the CodeForge installer artifact and the installed product state.
.DESCRIPTION Records installer identity (hash, version resources, signature, architecture), optionally runs
  the installer, then inventories the program directory, the Apps & Features registration, shortcuts and
  the user-data locations. Every claim in the JSON comes from the real file system and registry.
#>
$ErrorActionPreference = "Stop"
Import-Module (Join-Path $PSScriptRoot "CodeForgeProductAudit.psm1") -Force

New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$installer = Get-CodeForgeInstaller -Path $InstallerPath
$report = [ordered]@{
    schemaVersion = 1
    label = $Label
    startedAtUtc = [DateTime]::UtcNow.ToString("o")
    machine = [ordered]@{ os = [Environment]::OSVersion.VersionString; user = $env:USERNAME; cores = [Environment]::ProcessorCount; dpiPercent = [int]((Get-ItemProperty "HKCU:\Control Panel\Desktop\WindowMetrics" -ErrorAction SilentlyContinue).AppliedDPI / 96 * 100) }
    installer = Get-CodeForgeFileIdentity $installer
    checks = [ordered]@{}
}
$c = $report.checks

$c.installerHash = if (-not $ExpectedSha256) { New-AuditResult "INFO" "No expected hash supplied; recorded $($report.installer.sha256)." }
    elseif ($report.installer.sha256 -ieq $ExpectedSha256) { New-AuditResult "PASS" "Installer SHA-256 matches the expected release hash." }
    else { New-AuditResult "FAIL" "Installer SHA-256 $($report.installer.sha256) does not match expected $ExpectedSha256." }
$c.installerArchitecture = if ($report.installer.architecture -eq "x86" -or $report.installer.architecture -eq "x64") { New-AuditResult "PASS" "NSIS stub is $($report.installer.architecture); it installs the x64 payload." } else { New-AuditResult "WARN" "Unexpected installer architecture $($report.installer.architecture)." }
$c.installerSignature = if ($report.installer.signatureStatus -eq "Valid") { New-AuditResult "PASS" "Installer is Authenticode-signed by $($report.installer.signerSubject)." } else { New-AuditResult "WARN" "Installer is not code-signed (status: $($report.installer.signatureStatus)). Windows SmartScreen will warn on first run." }
$c.installerIdentity = if ($report.installer.productName -eq "CodeForge" -and $report.installer.productVersion) { New-AuditResult "PASS" "Installer identifies as $($report.installer.productName) $($report.installer.productVersion)." } else { New-AuditResult "FAIL" "Installer product metadata is incomplete." }

if ($Install) {
    $report.installRun = Install-CodeForge -InstallerPath $installer -Silent:(-not $Interactive) -ExpectedSha256 $ExpectedSha256
    $c.installExit = if ($report.installRun.exitCode -eq 0) { New-AuditResult "PASS" "Installer exited 0 in $($report.installRun.elapsedMs) ms." } else { New-AuditResult "FAIL" "Installer exited $($report.installRun.exitCode)." }
}

$report.installed = Get-CodeForgeInstalledInventory
$report.registry = Get-CodeForgeRegistryState
$report.shortcuts = Get-CodeForgeShortcuts
$report.userData = Get-CodeForgeUserDataInventory
$report.releaseArchiveMatch = Get-CodeForgeReleaseArchiveMatch

if (-not $report.installed.installed) {
    $c.installed = New-AuditResult "FAIL" "CodeForge.exe was not found in any per-user Programs directory."
} else {
    $exe = $report.installed.executable
    $c.installed = New-AuditResult "PASS" "Installed at $($report.installed.installDirectory) ($($report.installed.fileCount) files, $([math]::Round($report.installed.totalBytes / 1MB)) MB)."
    $c.installedArchitecture = if ($exe.architecture -eq "x64") { New-AuditResult "PASS" "Installed executable is x64." } else { New-AuditResult "FAIL" "Installed executable is $($exe.architecture)." }
    $c.installedVersionMatchesInstaller = if ($exe.productVersion -like "$($report.installer.productVersion)*") { New-AuditResult "PASS" "Installed executable version $($exe.productVersion) matches installer $($report.installer.productVersion)." } else { New-AuditResult "FAIL" "Installed executable version $($exe.productVersion) differs from installer $($report.installer.productVersion)." }
    $c.installedCompanyName = if ($exe.companyName -and $exe.companyName -notmatch "GitHub") { New-AuditResult "PASS" "Executable CompanyName is '$($exe.companyName)'." } else { New-AuditResult "FAIL" "Executable CompanyName is '$($exe.companyName)' (Electron's default, not CodeForge's publisher)." }
    $c.installedSignature = if ($exe.signatureStatus -eq "Valid") { New-AuditResult "PASS" "Executable is signed." } else { New-AuditResult "WARN" "Installed executable is not code-signed ($($exe.signatureStatus))." }
    $suspicious = @($report.installed.suspiciousFiles | Where-Object { $_.class -in @("source-map", "env-file", "pdb", "test-artifact", "typescript-source", "backup", "log", "sqlite") })
    $c.installedFileHygiene = if ($suspicious.Count -eq 0) { New-AuditResult "PASS" "No source maps, .env files, PDBs, test artifacts, logs or databases in the program directory." } else { New-AuditResult "WARN" "$($suspicious.Count) suspicious file(s) in the program directory." @{ files = $suspicious } }
    $c.asarUnpackedPresent = if ($report.installed.unpackedDirectory) { New-AuditResult "PASS" "app.asar.unpacked (native modules) is present." } else { New-AuditResult "FAIL" "app.asar.unpacked is missing; native modules cannot load." }
    $c.releaseArchiveMatch = $report.releaseArchiveMatch
}

$u = $report.registry.uninstallKey
if (-not $u) {
    $c.registryUninstall = New-AuditResult "FAIL" "No Apps & Features (HKCU Uninstall) registration exists."
} else {
    $expectedVersion = if ($report.installed.installed) { $report.installed.executable.fileVersion } else { $report.installer.productVersion }
    $c.registryUninstall = New-AuditResult "PASS" "Registered as '$($u.displayName)' with quiet uninstall '$($u.quietUninstallString)'."
    $c.registryVersion = if ($u.displayVersion -eq $expectedVersion) { New-AuditResult "PASS" "Apps & Features version $($u.displayVersion) matches the installed executable." } else { New-AuditResult "FAIL" "Apps & Features shows version $($u.displayVersion) but the installed executable is $expectedVersion." }
    $c.registryPublisher = if ($u.publisher) { New-AuditResult "PASS" "Publisher is '$($u.publisher)'." } else { New-AuditResult "FAIL" "Publisher is blank in Apps & Features." }
    $c.registryIcon = if ($u.displayIcon -and (Test-Path -LiteralPath ($u.displayIcon -replace ',\d+$', ''))) { New-AuditResult "PASS" "DisplayIcon points at an existing file." } else { New-AuditResult "FAIL" "DisplayIcon is missing or points at a missing file." }
    $c.registryUninstallCommand = if ($u.uninstallString -and (Test-Path -LiteralPath (($u.uninstallString -replace '^"([^"]+)".*$', '$1')))) { New-AuditResult "PASS" "Uninstall command targets an existing uninstaller." } else { New-AuditResult "FAIL" "Uninstall command is missing or its executable does not exist." }
    $c.registryPerMachine = if ($report.registry.perMachineUninstallKeys.Count -eq 0) { New-AuditResult "PASS" "No per-machine (HKLM) registration; install is per-user as intended." } else { New-AuditResult "WARN" "Per-machine registrations exist." @{ keys = $report.registry.perMachineUninstallKeys } }
}

$startMenu = @($report.shortcuts | Where-Object { $_.path -like "*Start Menu*" })
$desktop = @($report.shortcuts | Where-Object { $_.path -like "*Desktop*" })
$c.startMenuShortcut = if ($startMenu.Count -gt 0 -and $startMenu[0].targetExists) { New-AuditResult "PASS" "Start Menu shortcut → $($startMenu[0].target)." } else { New-AuditResult "FAIL" "Start Menu shortcut is missing or dangling." }
$c.desktopShortcut = if ($desktop.Count -gt 0 -and $desktop[0].targetExists) { New-AuditResult "PASS" "Desktop shortcut → $($desktop[0].target)." } else { New-AuditResult "INFO" "No desktop shortcut." }
$stale = @($report.shortcuts | Where-Object { -not $_.targetExists -or $_.arguments })
$c.shortcutHygiene = if ($stale.Count -eq 0) { New-AuditResult "PASS" "Shortcuts point at the installed executable with no stale arguments." } else { New-AuditResult "FAIL" "Stale or argument-bearing shortcuts found." @{ shortcuts = $stale } }

$c.userDataSecrets = if ($report.userData.plaintextSecretSuspects.Count -eq 0) { New-AuditResult "PASS" "No plaintext credential values in settings.json (sealed keys: $($report.userData.sealedCredentialKeys -join ', ')." } else { New-AuditResult "FAIL" "Plaintext credential-shaped values present in settings.json." @{ keys = $report.userData.plaintextSecretSuspects } }
$c.updaterCache = if ($report.userData.updaterCache.exists) { New-AuditResult "INFO" "Installer cache exists at $($report.userData.updaterCache.path) ($([math]::Round($report.userData.updaterCache.totalBytes / 1MB)) MB)." } else { New-AuditResult "INFO" "No installer cache directory." }

$report.completedAtUtc = [DateTime]::UtcNow.ToString("o")
$fails = @($c.Values | Where-Object { $_.status -eq "FAIL" }).Count
$warns = @($c.Values | Where-Object { $_.status -eq "WARN" }).Count
$report.summary = [ordered]@{ fail = $fails; warn = $warns; pass = @($c.Values | Where-Object { $_.status -eq "PASS" }).Count; verdict = if ($fails -eq 0) { "PASS" } else { "FAIL" } }

$jsonPath = Write-AuditJson -Object $report -Path (Join-Path $OutputDirectory "$Label.json")
$md = @("# $Label", "", "Installer: ``$($report.installer.path)``", "", "SHA-256: ``$($report.installer.sha256)``", "", "| Check | Status | Detail |", "|---|---|---|")
foreach ($k in $c.Keys) { $md += "| $k | $($c[$k].status) | $(($c[$k].detail) -replace '\|', '\|') |" }
$md += ""; $md += "Verdict: **$($report.summary.verdict)** ($fails FAIL, $warns WARN)"
[System.IO.File]::WriteAllLines((Join-Path $OutputDirectory "$Label.md"), $md, [System.Text.UTF8Encoding]::new($false))
Write-Host ($report.summary | ConvertTo-Json -Compress)
Write-Host "evidence: $jsonPath"
if ($fails -gt 0) { exit 1 }
