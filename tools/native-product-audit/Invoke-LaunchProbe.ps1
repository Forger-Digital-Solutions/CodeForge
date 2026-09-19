[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$OutputDirectory,
    [string]$Label = "launch-probe",
    [string]$ExecutablePath,
    # Isolated profile directory. Omit for the real per-user profile; pass -FreshProfile for a new empty one.
    [string]$ProfileDirectory,
    [switch]$FreshProfile,
    [int]$RemoteDebugPort = 9229,
    [int]$LaunchTimeoutSeconds = 60,
    # Seconds of idle resource sampling after the renderer is interactive (0 to skip).
    [int]$IdleSampleSeconds = 10,
    # Keep the app running (no close/leak phase). The caller must stop it.
    [switch]$KeepOpen,
    [hashtable]$Environment,
    [string]$WaitForText
)
<#
.SYNOPSIS Launch the installed CodeForge, observe first frame → interactive, idle resources, console windows,
  then close it like a user would and account for every process.
#>
$ErrorActionPreference = "Stop"
Import-Module (Join-Path $PSScriptRoot "CodeForgeProductAudit.psm1") -Force
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null

if ($FreshProfile -and -not $ProfileDirectory) { $ProfileDirectory = Join-Path $OutputDirectory "profile-$([guid]::NewGuid().ToString('N').Substring(0, 8))" }
$report = [ordered]@{
    schemaVersion = 1
    label = $Label
    startedAtUtc = [DateTime]::UtcNow.ToString("o")
    profileDirectory = if ($ProfileDirectory) { $ProfileDirectory } else { (Get-CodeForgeUserDataLocations).userData }
    freshProfile = [bool]$FreshProfile
    checks = [ordered]@{}
}
$c = $report.checks
$tempBefore = @(Get-TempInventory | ForEach-Object { $_.name })
$strayBefore = @(Get-CodeForgeStrayProcesses)
$watch = Start-ConsoleWindowWatch
$instance = $null
try {
    $instance = Start-CodeForgeInstance -ExecutablePath $ExecutablePath -ProfileDirectory $ProfileDirectory -RemoteDebugPort $RemoteDebugPort -LaunchTimeoutSeconds $LaunchTimeoutSeconds -Environment $Environment -LogDirectory $OutputDirectory
    $report.executable = Get-CodeForgeFileIdentity $instance.ExecutablePath
    $report.pid = $instance.Pid
    $report.cdpReadyMs = $instance.CdpReadyMs
    if (-not $instance.Cdp) {
        $exited = $instance.Process.HasExited
        $c.rendererDevTools = New-AuditResult "FAIL" ($(if ($exited) { "Process exited with code $($instance.Process.ExitCode) before exposing DevTools." } else { "No DevTools target within $LaunchTimeoutSeconds s." }))
        throw "launch failed"
    }
    $c.rendererDevTools = New-AuditResult "PASS" "DevTools target available $($instance.CdpReadyMs) ms after process start."

    # Wait for the renderer's own startup marks (root-mounted/first-frame are always stamped; workspace marks only inside a project).
    $deadline = [DateTime]::UtcNow.AddSeconds(30); $life = $null
    while ([DateTime]::UtcNow -lt $deadline) {
        try { $life = Invoke-CodeForgeCdp -Port $RemoteDebugPort -Command lifecycle; if ($life.marks.PSObject.Properties["first-frame"]) { break } } catch {}
        Start-Sleep -Milliseconds 250
    }
    $report.lifecycle = $life
    $c.firstFrame = if ($life -and $life.marks.PSObject.Properties["first-frame"]) { New-AuditResult "PASS" "Renderer first frame at +$($life.relativeMs.'first-frame') ms from document start (DevTools at +$($instance.CdpReadyMs) ms from process start)." } else { New-AuditResult "FAIL" "Renderer never stamped first-frame." }
    if ($WaitForText) {
        try { Invoke-CodeForgeCdp -Port $RemoteDebugPort -Command wait-text -Arguments @($WaitForText, "30000") | Out-Null; $c.expectedText = New-AuditResult "PASS" "Renderer showed '$WaitForText'." }
        catch { $c.expectedText = New-AuditResult "FAIL" "Renderer did not show '$WaitForText' within 30 s." }
    }
    Start-Sleep -Seconds 2
    $report.bodyText = Invoke-CodeForgeCdp -Port $RemoteDebugPort -Command text
    $shot = Join-Path $OutputDirectory "$Label.png"
    Invoke-CodeForgeCdp -Port $RemoteDebugPort -Command screenshot -Arguments @($shot) | Out-Null
    $report.screenshot = $shot
    $report.console = Invoke-CodeForgeCdp -Port $RemoteDebugPort -Command console -Arguments @("2500")
    $errors = @($report.console | Where-Object { $_.type -in @("error", "exception", "log:error") })
    $c.consoleErrors = if ($errors.Count -eq 0) { New-AuditResult "PASS" "No renderer console errors or exceptions during the observation window." } else { New-AuditResult "WARN" "$($errors.Count) console error(s)/exception(s)." @{ entries = $errors } }
    $report.accessibility = Invoke-CodeForgeCdp -Port $RemoteDebugPort -Command a11y
    $c.unnamedControls = if ($report.accessibility.unnamedCount -eq 0) { New-AuditResult "PASS" "Every visible control has an accessible name." } else { New-AuditResult "WARN" "$($report.accessibility.unnamedCount) visible control(s) have no accessible name." }
    $report.overflow = Invoke-CodeForgeCdp -Port $RemoteDebugPort -Command overflow
    $c.layoutOverflow = if (-not $report.overflow.horizontalOverflow -and $report.overflow.offscreenCount -eq 0) { New-AuditResult "PASS" "No horizontal overflow; no controls outside the viewport." } else { New-AuditResult "WARN" "Horizontal overflow=$($report.overflow.horizontalOverflow); $($report.overflow.offscreenCount) control(s) outside the viewport." }
    $report.metrics = Invoke-CodeForgeCdp -Port $RemoteDebugPort -Command metrics
    $report.processTree = @(Get-ProcessTree -RootPid $instance.Pid)
    $report.windows = @(Get-CodeForgeWindows -RootPid $instance.Pid | Where-Object { $_.visible })
    $visibleMain = @($report.windows | Where-Object { $_.className -like "Chrome_WidgetWin*" -and $_.title -eq "CodeForge" })
    $c.mainWindowVisible = if ($visibleMain.Count -ge 1) { New-AuditResult "PASS" "A visible top-level 'CodeForge' window exists ($($visibleMain[0].width)x$($visibleMain[0].height) at $($visibleMain[0].left),$($visibleMain[0].top))." } else { New-AuditResult "FAIL" "No visible top-level CodeForge window." }
    if ($IdleSampleSeconds -gt 0) {
        $report.idleResources = Get-ProcessResourceSample -RootPid $instance.Pid -SampleSeconds $IdleSampleSeconds
        $cpu = $report.idleResources.totalCpuPercentOfMachine
        $c.idleCpu = if ($cpu -lt 2.0) { New-AuditResult "PASS" "Idle CPU $cpu% of the machine over $IdleSampleSeconds s ($($report.idleResources.logicalCores) cores); RSS $([math]::Round($report.idleResources.totalWorkingSetBytes / 1MB)) MB across $($report.idleResources.processes.Count) processes." } elseif ($cpu -lt 5.0) { New-AuditResult "WARN" "Idle CPU $cpu% of the machine." } else { New-AuditResult "FAIL" "Idle CPU $cpu% of the machine — the app is busy while idle." }
    }
} catch {
    $report.error = $_.Exception.Message
} finally {
    if ($instance) {
        if ($KeepOpen) {
            $report.keptOpen = $true
        } else {
            $report.shutdown = Stop-CodeForgeInstance -Instance $instance -GraceSeconds 15
            $c.gracefulExit = if ($report.shutdown.exitedWithinGraceMs) { New-AuditResult "PASS" "Whole process tree exited $($report.shutdown.exitMs) ms after $($report.shutdown.method) (root exit code $($report.shutdown.rootExitCode))." } else { New-AuditResult "FAIL" "$($report.shutdown.survivorsForceKilled.Count) process(es) survived the close and were force-killed." @{ survivors = $report.shutdown.survivorsForceKilled } }
            Start-Sleep -Seconds 2
            $strayAfter = @(Get-CodeForgeStrayProcesses | Where-Object { $_.pid -notin @($strayBefore | ForEach-Object { $_.pid }) })
            $c.strayProcesses = if ($strayAfter.Count -eq 0) { New-AuditResult "PASS" "No CodeForge processes remain after close." } else { New-AuditResult "FAIL" "Stray CodeForge processes remain." @{ processes = $strayAfter } }
            if ($report.PSObject.Properties["lifecycle"] -or $report.Contains("lifecycle")) {
                $runtimeJson = Join-Path $report.profileDirectory "runtime.json"
                $c.runtimeMetadataCleared = if (-not (Test-Path -LiteralPath $runtimeJson)) { New-AuditResult "PASS" "runtime.json was removed on clean exit." } else { New-AuditResult "WARN" "runtime.json still exists after a clean exit." }
            }
        }
    }
    $report.consoleWindows = Stop-ConsoleWindowWatch -Watch $watch
    $seen = @($report.consoleWindows.consoleWindowsSeen)
    $c.noConsoleWindows = if ($seen.Count -eq 0) { New-AuditResult "PASS" "No console/terminal window appeared during the run ($($report.consoleWindows.samples) samples)." } else { New-AuditResult "FAIL" "$($seen.Count) console window(s) flashed during the run." @{ windows = $seen } }
    $tempAfter = @(Get-TempInventory | ForEach-Object { $_.name })
    $report.tempDiff = Compare-NameSets -Before $tempBefore -After $tempAfter
    $report.stdoutTail = if (Test-Path -LiteralPath $instance.StdoutPath) { @(Get-Content -LiteralPath $instance.StdoutPath -Tail 40) } else { @() }
    $report.stderrTail = if ($instance -and (Test-Path -LiteralPath $instance.StderrPath)) { @(Get-Content -LiteralPath $instance.StderrPath -Tail 40) } else { @() }
    $report.completedAtUtc = [DateTime]::UtcNow.ToString("o")
    $fails = @($c.Values | Where-Object { $_.status -eq "FAIL" }).Count
    $report.summary = [ordered]@{ fail = $fails; warn = @($c.Values | Where-Object { $_.status -eq "WARN" }).Count; pass = @($c.Values | Where-Object { $_.status -eq "PASS" }).Count; verdict = if ($fails -eq 0 -and -not $report.Contains("error")) { "PASS" } else { "FAIL" } }
    Write-AuditJson -Object $report -Path (Join-Path $OutputDirectory "$Label.json") | Out-Null
    $md = @("# $Label", "", "Profile: ``$($report.profileDirectory)`` (fresh: $($report.freshProfile))", "", "| Check | Status | Detail |", "|---|---|---|")
    foreach ($k in $c.Keys) { $md += "| $k | $($c[$k].status) | $(($c[$k].detail) -replace '\|', '\|') |" }
    if ($report.Contains("error")) { $md += ""; $md += "Error: $($report.error)" }
    $md += ""; $md += "Verdict: **$($report.summary.verdict)**"
    [System.IO.File]::WriteAllLines((Join-Path $OutputDirectory "$Label.md"), $md, [System.Text.UTF8Encoding]::new($false))
    Write-Host ($report.summary | ConvertTo-Json -Compress)
}
if ($report.summary.verdict -ne "PASS") { exit 1 }
