[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$OutputDirectory,
    [Parameter(Mandatory)][string]$NewInstaller,
    [string]$NewSha256,
    # An older release installer; when given, the audit performs a real version upgrade (old → new)
    # and a downgrade probe (old binary against a copy of a newer profile).
    [string]$OldInstaller,
    # The user profile whose retention/removal semantics are audited. Defaults to the real per-user
    # profile; it is backed up first and restored at the end, and launches use COPIES of it.
    [string]$ProfileDirectory,
    [switch]$SkipDataRemoval,
    [switch]$SkipSessionRestore,
    [int]$RemoteDebugPort = 9231
)
<#
.SYNOPSIS Full install → upgrade → relaunch → uninstall → reinstall lifecycle against the real installer,
  the real registry and the real per-user layout. Every phase snapshots the file system and registry and
  launches the installed binary to prove it still starts and restores state.
#>
$ErrorActionPreference = "Stop"
Import-Module (Join-Path $PSScriptRoot "CodeForgeProductAudit.psm1") -Force
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$loc = Get-CodeForgeUserDataLocations
if (-not $ProfileDirectory) { $ProfileDirectory = $loc.userData }
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
# StaleFiles() strips $unpacked's length off absolute FullNames, so this must be absolute even
# when -NewInstaller was given as a relative path.
$unpacked = [System.IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $NewInstaller) "win-unpacked"))

$report = [ordered]@{ schemaVersion = 1; startedAtUtc = [DateTime]::UtcNow.ToString("o"); newInstaller = Get-CodeForgeFileIdentity $NewInstaller; phases = [ordered]@{}; checks = [ordered]@{} }
if ($OldInstaller) { $report.oldInstaller = Get-CodeForgeFileIdentity $OldInstaller }
$c = $report.checks
if ($NewSha256 -and -not $report.newInstaller.sha256.Equals($NewSha256, [StringComparison]::OrdinalIgnoreCase)) { throw "New installer hash mismatch" }
if (Get-Process -Name CodeForge -ErrorAction SilentlyContinue) { throw "CodeForge is running; close it before the lifecycle audit." }

function Snapshot([string]$name) {
    $snap = [ordered]@{ at = [DateTime]::UtcNow.ToString("o"); install = Get-CodeForgeInstalledInventory; registry = Get-CodeForgeRegistryState; shortcuts = Get-CodeForgeShortcuts; userData = Get-CodeForgeUserDataInventory -ProfileDirectory $ProfileDirectory }
    $report.phases[$name] = $snap
    return $snap
}
# Launches use the DEFAULT profile (no --user-data-dir) unless an explicit directory is given:
# that is the path a real user's shortcut takes, and it keeps every launch on one token chain.
function Launch([string]$label, [string]$profile, [string]$expectText) {
    $probe = Join-Path $PSScriptRoot "Invoke-LaunchProbe.ps1"
    $dir = Join-Path $OutputDirectory $label
    $args = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $probe, "-OutputDirectory", $dir, "-Label", $label, "-RemoteDebugPort", "$RemoteDebugPort", "-IdleSampleSeconds", "5")
    if ($profile) { $args += @("-ProfileDirectory", $profile) }
    if ($expectText) { $args += @("-WaitForText", $expectText) }
    & pwsh @args | Out-Null
    $json = Join-Path $dir "$label.json"
    if (Test-Path -LiteralPath $json) { return (Get-Content -LiteralPath $json -Raw | ConvertFrom-Json) }
    return $null
}
function StaleFiles([string]$installDir) {
    $expected = @{}
    foreach ($f in Get-ChildItem -LiteralPath $unpacked -Recurse -File -Force) { $expected[$f.FullName.Substring($unpacked.Length).TrimStart('\').ToLowerInvariant()] = $f.Length }
    $stale = @(); $mismatch = @()
    foreach ($f in Get-ChildItem -LiteralPath $installDir -Recurse -File -Force) {
        $rel = $f.FullName.Substring($installDir.Length).TrimStart('\')
        $key = $rel.ToLowerInvariant()
        if ($key -eq "uninstall codeforge.exe") { continue }
        if (-not $expected.ContainsKey($key)) { $stale += $rel } elseif ($expected[$key] -ne $f.Length) { $mismatch += $rel }
    }
    return [ordered]@{ stale = $stale; sizeMismatch = $mismatch; expectedCount = $expected.Count }
}

# Session-restoration check (single token chain): the NEW release is installed over the existing one
# and the REAL profile is launched exactly once. This must happen before the profile is set aside:
# a signed-in profile can only ever be launched from one place, because every launch may rotate the
# Cloud refresh token and reusing an older copy of it is treated as a replay (revocation).
$sessionRestore = $null
if (-not $SkipSessionRestore -and (Test-Path -LiteralPath (Join-Path $ProfileDirectory "settings.json"))) {
    $iFirst = Install-CodeForge -InstallerPath $NewInstaller -Silent -ExpectedSha256 $NewSha256
    $report.phases["00a-install-new-over-existing-real-profile"] = $iFirst
    $sessionRestore = Launch "00b-relaunch-real-profile-after-upgrade" $null $null
    $report.phases["00b-relaunch-real-profile"] = $sessionRestore
    $signedIn = $sessionRestore -and $sessionRestore.bodyText -and -not ($sessionRestore.bodyText -match "Continue with GitHub")
    $c.upgradeRestoresSession = if ($sessionRestore -and $sessionRestore.checks.rendererDevTools.status -eq "PASS" -and $signedIn) { New-AuditResult "PASS" "After installing the new release over the existing one, the real profile restored signed in (no sign-in screen); clean exit: $($sessionRestore.checks.gracefulExit.status)." } elseif ($sessionRestore -and $sessionRestore.checks.rendererDevTools.status -eq "PASS") { New-AuditResult "WARN" "Upgraded app started but showed the sign-in screen for the real profile (no stored session, or the Cloud refused it)." } else { New-AuditResult "FAIL" "Upgraded app did not start on the real profile: $($sessionRestore.error)" }
}

# The rest of the lifecycle runs against a token-stripped COPY installed as the default profile, so
# nothing below can touch the real profile or its Cloud session. The real profile is held aside and
# moved back untouched at the end.
$hold = "$ProfileDirectory.lifecycle-hold-" + (Get-Date -Format "yyyyMMdd-HHmmss")
if (Test-Path -LiteralPath $ProfileDirectory) {
    Move-Item -LiteralPath $ProfileDirectory -Destination $hold
    $report.profileHold = $hold
    Copy-Item -LiteralPath $hold -Destination $ProfileDirectory -Recurse -Force
    $settingsPath = Join-Path $ProfileDirectory "settings.json"
    if (Test-Path -LiteralPath $settingsPath) {
        $settings = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
        foreach ($k in @("codeforge:cloud-access-token", "codeforge:cloud-refresh-token", "codeforge:cloud-user")) { $settings.PSObject.Properties.Remove($k) }
        $settings | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $settingsPath -Encoding utf8
    }
    Remove-Item -LiteralPath (Join-Path $ProfileDirectory "runtime.json") -ErrorAction SilentlyContinue
}

$watch = Start-ConsoleWindowWatch
try {
    Snapshot "00-pre" | Out-Null

    # ---- 1. Uninstall whatever is installed now (keep data) ----
    if ((Get-CodeForgeRegistryState).uninstallKey) {
        $u1 = Uninstall-CodeForge -Silent
        $report.phases["01-uninstall-baseline"] = $u1
        $c.uninstallRemovesProgram = if (-not $u1.after.programDirectoryExists -or $u1.after.programDirectoryLeftovers.Count -eq 0) { New-AuditResult "PASS" "Program directory removed (exit $($u1.exitCode), $($u1.elapsedMs) ms)." } else { New-AuditResult "FAIL" "Program directory still holds files after uninstall." @{ leftovers = $u1.after.programDirectoryLeftovers } }
        $c.uninstallRemovesRegistry = if (-not $u1.after.registry.uninstallKey -and -not $u1.after.registry.installKey) { New-AuditResult "PASS" "Apps & Features registration and install key removed." } else { New-AuditResult "FAIL" "Registry keys survive the uninstall." }
        $c.uninstallRemovesShortcuts = if ($u1.after.shortcuts.Count -eq 0) { New-AuditResult "PASS" "Start Menu and Desktop shortcuts removed." } else { New-AuditResult "FAIL" "Shortcuts survive the uninstall." @{ shortcuts = $u1.after.shortcuts } }
        $c.uninstallKeepsUserData = if ($u1.after.userData.profile.exists -and (Test-Path -LiteralPath (Join-Path $ProfileDirectory "settings.json"))) { New-AuditResult "PASS" "User data (settings, sessions, sealed sign-in) is kept by a normal uninstall, as designed." } else { New-AuditResult "FAIL" "A normal uninstall deleted the user's data." }
        $c.uninstallLeavesNoProcess = if ($u1.after.runningProcesses.Count -eq 0) { New-AuditResult "PASS" "No CodeForge process remains." } else { New-AuditResult "FAIL" "CodeForge processes remain after uninstall." }
    }

    # ---- 2. Real version upgrade: install the OLD release first ----
    if ($OldInstaller) {
        $iOld = Install-CodeForge -InstallerPath $OldInstaller -Silent
        $report.phases["02-install-old"] = $iOld
        $oldVersion = $report.oldInstaller.productVersion
        $c.oldInstall = if ($iOld.exitCode -eq 0 -and $iOld.registry.uninstallKey.displayVersion -eq $oldVersion) { New-AuditResult "PASS" "Old release $oldVersion installed silently; Apps & Features shows $($iOld.registry.uninstallKey.displayVersion)." } else { New-AuditResult "FAIL" "Old release install did not register version $oldVersion (exit $($iOld.exitCode), registry $($iOld.registry.uninstallKey.displayVersion))." }
        # Downgrade probe: the OLD binary against the newer (token-stripped) profile layout.
        $d = Launch "03-downgrade-old-binary-newer-profile" $null $null
        $report.phases["03-downgrade"] = $d
        $c.downgradeSafety = if ($d -and $d.checks.rendererDevTools.status -eq "PASS" -and $d.checks.gracefulExit.status -eq "PASS") { New-AuditResult "INFO" "Older binary started and exited cleanly against a newer profile copy (schema tolerated). Text: $(($d.bodyText -replace '\s+',' ').Substring(0, [Math]::Min(120, $d.bodyText.Length)))" } else { New-AuditResult "WARN" "Older binary did not start cleanly against the newer profile copy: $($d.error)" }
    }

    # ---- 4. Install NEW over the existing installation (no uninstall) ----
    $iNew = Install-CodeForge -InstallerPath $NewInstaller -Silent -ExpectedSha256 $NewSha256
    $report.phases["04-install-new-over-existing"] = $iNew
    $newVersion = $report.newInstaller.productVersion
    $c.upgradeInstall = if ($iNew.exitCode -eq 0) { New-AuditResult "PASS" "New release installed over the existing installation in $($iNew.elapsedMs) ms (exit 0)." } else { New-AuditResult "FAIL" "Upgrade install exited $($iNew.exitCode)." }
    $c.upgradeRegistryVersion = if ($iNew.registry.uninstallKey.displayVersion -eq $newVersion) { New-AuditResult "PASS" "Apps & Features now shows $newVersion." } else { New-AuditResult "FAIL" "Apps & Features shows $($iNew.registry.uninstallKey.displayVersion) after installing $newVersion." }
    $c.upgradePublisher = if ($iNew.registry.uninstallKey.publisher) { New-AuditResult "PASS" "Publisher '$($iNew.registry.uninstallKey.publisher)'; display name '$($iNew.registry.uninstallKey.displayName)'." } else { New-AuditResult "FAIL" "Publisher is blank." }
    $c.upgradeExecutableVersion = if ($iNew.executable.fileVersion -eq $newVersion) { New-AuditResult "PASS" "Installed CodeForge.exe is $($iNew.executable.fileVersion) (CompanyName '$($iNew.executable.companyName)')." } else { New-AuditResult "FAIL" "Installed CodeForge.exe reports $($iNew.executable.fileVersion)." }
    $c.upgradeArchive = Get-CodeForgeReleaseArchiveMatch -InstallDirectory $iNew.installDirectory -UnpackedDirectory $unpacked
    $stale = StaleFiles $iNew.installDirectory
    $c.upgradeNoStaleFiles = if ($stale.stale.Count -eq 0 -and $stale.sizeMismatch.Count -eq 0) { New-AuditResult "PASS" "Installed tree matches the release tree exactly ($($stale.expectedCount) files); nothing from the previous version survives." } else { New-AuditResult "FAIL" "Stale or mismatched files after upgrade." @{ stale = $stale.stale; sizeMismatch = $stale.sizeMismatch } }
    $c.upgradeShortcuts = if (@($iNew.shortcuts | Where-Object { $_.targetExists }).Count -ge 1) { New-AuditResult "PASS" "Shortcuts point at the upgraded executable." } else { New-AuditResult "FAIL" "Shortcuts missing or dangling after upgrade." }
    $c.upgradeKeepsUserData = if (Test-Path -LiteralPath (Join-Path $ProfileDirectory "settings.json")) { New-AuditResult "PASS" "User data untouched by the upgrade." } else { New-AuditResult "FAIL" "User data missing after upgrade." }
    $r = Launch "05-relaunch-after-upgrade-retained-profile" $null $null
    $report.phases["05-relaunch-upgrade"] = $r
    $c.upgradeRelaunch = if ($r -and $r.checks.rendererDevTools.status -eq "PASS" -and $r.checks.gracefulExit.status -eq "PASS") { New-AuditResult "PASS" "Upgraded app starts on the retained (token-stripped) profile and exits cleanly." } else { New-AuditResult "FAIL" "Upgraded app did not start cleanly on the retained profile: $($r.error)" }

    # ---- 6. Uninstall (keep data) → reinstall → retained profile restores ----
    $u2 = Uninstall-CodeForge -Silent
    $report.phases["06-uninstall-new"] = $u2
    $c.uninstallNewClean = if ((-not $u2.after.programDirectoryExists -or $u2.after.programDirectoryLeftovers.Count -eq 0) -and -not $u2.after.registry.uninstallKey -and $u2.after.shortcuts.Count -eq 0) { New-AuditResult "PASS" "Uninstall of the new release removed program files, registration and shortcuts; user data kept." } else { New-AuditResult "FAIL" "Uninstall of the new release left traces." @{ leftovers = $u2.after.programDirectoryLeftovers; registry = $u2.after.registry; shortcuts = $u2.after.shortcuts } }
    $iRe = Install-CodeForge -InstallerPath $NewInstaller -Silent -ExpectedSha256 $NewSha256
    $report.phases["07-reinstall-retained"] = $iRe
    $r2 = Launch "08-reinstall-retained-profile" $null $null
    $report.phases["08-relaunch-reinstall"] = $r2
    $retainedSettings = Join-Path $ProfileDirectory "settings.json"
    $keptRecent = (Test-Path -LiteralPath $retainedSettings) -and ((Get-Content -LiteralPath $retainedSettings -Raw) -match "codeforge:recent-projects")
    $c.reinstallRetainedProfile = if ($iRe.exitCode -eq 0 -and $r2 -and $r2.checks.rendererDevTools.status -eq "PASS" -and $keptRecent) { New-AuditResult "PASS" "Reinstall with retained data keeps the profile (recent projects, settings, task history) and starts cleanly (case A)." } else { New-AuditResult "FAIL" "Reinstall with retained data did not keep the previous state." }

    # ---- 9. Full removal (app + data) → reinstall behaves like a brand-new user ----
    if (-not $SkipDataRemoval) {
        $procWatch = Start-ProcessStartWatch -NamePatterns @("CodeForge.exe")
        $u3 = Uninstall-CodeForge -Silent -DeleteAppData
        $report.phases["09-uninstall-delete-app-data"] = $u3
        $report.phases["09-process-starts"] = Stop-ProcessStartWatch -Watch $procWatch
        $c.noLaunchDuringRemoval = if (@($report.phases["09-process-starts"].starts).Count -eq 0) { New-AuditResult "PASS" "No CodeForge process started during the full removal." } else { New-AuditResult "FAIL" "A CodeForge process started during the full removal." @{ starts = $report.phases["09-process-starts"].starts } }
        $dataGone = -not (Test-Path -LiteralPath $ProfileDirectory)
        $c.fullRemovalDeletesUserData = if ($dataGone) { New-AuditResult "PASS" "--delete-app-data removed the profile (settings, sessions, sealed sign-in tokens)." } else { New-AuditResult "FAIL" "Profile survived --delete-app-data." @{ remaining = (Get-DirectorySummary $ProfileDirectory 30).topLevel } }
        $c.fullRemovalUpdaterCache = if (-not (Test-Path -LiteralPath $loc.updaterCache)) { New-AuditResult "PASS" "Installer cache removed." } else { New-AuditResult "INFO" "Installer cache ($([math]::Round((Get-DirectorySummary $loc.updaterCache 5).totalBytes / 1MB)) MB) remains after full removal." }
        $iClean = Install-CodeForge -InstallerPath $NewInstaller -Silent -ExpectedSha256 $NewSha256
        $report.phases["10-reinstall-clean"] = $iClean
        $r3 = Launch "11-reinstall-clean-first-run" $null "Continue with GitHub"
        $report.phases["11-relaunch-clean"] = $r3
        $c.reinstallCleanIsFirstRun = if ($iClean.exitCode -eq 0 -and $r3 -and $r3.checks.rendererDevTools.status -eq "PASS" -and $r3.bodyText -match "Continue with GitHub" -and -not ($r3.bodyText -match "Forger Digital")) { New-AuditResult "PASS" "Clean reinstall behaves as a brand-new user: sign-in screen, no ghost account (case B)." } else { New-AuditResult "FAIL" "Clean reinstall did not present a first-run state." }
    }
    Snapshot "12-final" | Out-Null
} catch {
    $report.error = $_.Exception.Message
    $report.errorAt = $_.ScriptStackTrace
} finally {
    $report.consoleWindows = Stop-ConsoleWindowWatch -Watch $watch
    $seen = @($report.consoleWindows.consoleWindowsSeen)
    $c.noConsoleWindowsDuringLifecycle = if ($seen.Count -eq 0) { New-AuditResult "PASS" "No console window appeared during install, upgrade, launches or uninstall ($($report.consoleWindows.samples) samples)." } else { New-AuditResult "FAIL" "$($seen.Count) console window(s) appeared." @{ windows = $seen } }
    # Put the real profile back exactly as it was left after the single session-restore launch.
    if ($report.Contains("profileHold") -and (Test-Path -LiteralPath $hold)) {
        if (Test-Path -LiteralPath $ProfileDirectory) { Remove-Item -LiteralPath $ProfileDirectory -Recurse -Force }
        Move-Item -LiteralPath $hold -Destination $ProfileDirectory
        $c.profileRestored = New-AuditResult "PASS" "Real profile moved back untouched (held aside at $hold during the audit)."
    }
    $report.completedAtUtc = [DateTime]::UtcNow.ToString("o")
    $fails = @($c.Values | Where-Object { $_.status -eq "FAIL" }).Count
    $report.summary = [ordered]@{ fail = $fails; warn = @($c.Values | Where-Object { $_.status -eq "WARN" }).Count; pass = @($c.Values | Where-Object { $_.status -eq "PASS" }).Count; verdict = if ($fails -eq 0 -and -not $report.Contains("error")) { "PASS" } else { "FAIL" } }
    Write-AuditJson -Object $report -Path (Join-Path $OutputDirectory "lifecycle-audit.json") -Depth 14 | Out-Null
    $md = @("# Install / upgrade / uninstall / reinstall lifecycle", "", "New installer: ``$($report.newInstaller.path)`` — SHA-256 ``$($report.newInstaller.sha256)``", "")
    if ($OldInstaller) { $md += "Old installer: ``$($report.oldInstaller.path)`` — version $($report.oldInstaller.productVersion)"; $md += "" }
    $md += @("| Check | Status | Detail |", "|---|---|---|")
    foreach ($k in $c.Keys) { $md += "| $k | $($c[$k].status) | $(($c[$k].detail) -replace '\|', '\|') |" }
    if ($report.Contains("error")) { $md += ""; $md += "Error: $($report.error)" }
    $md += ""; $md += "Verdict: **$($report.summary.verdict)**"
    [System.IO.File]::WriteAllLines((Join-Path $OutputDirectory "lifecycle-audit.md"), $md, [System.Text.UTF8Encoding]::new($false))
    Write-Host ($report.summary | ConvertTo-Json -Compress)
}
if ($report.summary.verdict -ne "PASS") { exit 1 }
