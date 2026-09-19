[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$OutputDirectory,
    [Parameter(Mandatory)][string]$ProfileDirectory,
    [ValidateSet("blackhole", "refuse", "slow", "flaky")][string]$Mode = "blackhole",
    [int]$LatencyMs = 2500,
    [string]$Label,
    [int]$RemoteDebugPort = 9232,
    # Seconds the app may take to leave its bootstrap screen ("Restoring your CodeForge session…").
    [int]$BootstrapBudgetSeconds = 30,
    [switch]$SkipRecovery
)
<#
.SYNOPSIS Start the installed CodeForge with its Cloud traffic routed through a fault-injecting proxy,
  observe how the product behaves while the Cloud is dead/slow, then heal the "network" live and prove
  the app recovers without a restart.
#>
$ErrorActionPreference = "Stop"
Import-Module (Join-Path $PSScriptRoot "CodeForgeProductAudit.psm1") -Force
if (-not $Label) { $Label = "network-$Mode" }
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$report = [ordered]@{ schemaVersion = 1; label = $Label; mode = $Mode; latencyMs = $LatencyMs; startedAtUtc = [DateTime]::UtcNow.ToString("o"); checks = [ordered]@{}; timeline = @() }
$c = $report.checks
$mark = { param($event, $extra) $script:report.timeline += ([ordered]@{ at = [DateTime]::UtcNow.ToString("o"); event = $event } + $(if ($extra) { $extra } else { @{} })) }

# 1. Fault proxy with a live-switchable mode.
$modeFile = Join-Path $OutputDirectory "$Label.mode"
Set-Content -LiteralPath $modeFile -Value $Mode -NoNewline
$node = (Get-Command node).Source
$proxyLog = Join-Path $OutputDirectory "$Label.proxy.log"
$psi = [System.Diagnostics.ProcessStartInfo]::new($node)
foreach ($a in @((Join-Path $PSScriptRoot "network-fault-proxy.mjs"), $Mode, "0", "$LatencyMs", "--mode-file", $modeFile)) { $psi.ArgumentList.Add($a) }
$psi.UseShellExecute = $false; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.CreateNoWindow = $true
$proxy = [System.Diagnostics.Process]::Start($psi)
$ready = $proxy.StandardOutput.ReadLine()
if ($ready -notmatch "^READY (\d+)$") { throw "fault proxy did not start: $ready" }
$proxyPort = [int]$Matches[1]
$errTask = $proxy.StandardError.ReadToEndAsync()
$report.proxyPort = $proxyPort

$instance = $null
try {
    $env0 = @{
        NODE_USE_ENV_PROXY = "1"
        HTTPS_PROXY = "http://127.0.0.1:$proxyPort"
        HTTP_PROXY = "http://127.0.0.1:$proxyPort"
        NO_PROXY = "127.0.0.1,localhost"
    }
    & $mark "launch"
    $instance = Start-CodeForgeInstance -ProfileDirectory $ProfileDirectory -RemoteDebugPort $RemoteDebugPort -LaunchTimeoutSeconds 60 -Environment $env0 -LogDirectory $OutputDirectory
    if (-not $instance.Cdp) { throw "app did not expose DevTools (exited=$($instance.Process.HasExited))" }
    & $mark "devtools" @{ ms = $instance.CdpReadyMs }
    $c.startsWhileCloudDead = New-AuditResult "PASS" "App started with Cloud traffic $Mode; DevTools at $($instance.CdpReadyMs) ms."

    # 2. How long does the bootstrap screen last, and what does the user end up seeing?
    $t0 = [DateTime]::UtcNow; $bootstrapText = $null; $settledText = $null
    $deadline = $t0.AddSeconds($BootstrapBudgetSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        try { $txt = [string](Invoke-CodeForgeCdp -Port $RemoteDebugPort -Command text) } catch { Start-Sleep -Milliseconds 300; continue }
        # An empty body means the interface has not rendered yet — not that the bootstrap is over.
        if ($txt.Trim().Length -lt 20) { Start-Sleep -Milliseconds 300; continue }
        if ($null -eq $bootstrapText) { $bootstrapText = $txt }
        if ($txt -notmatch "Restoring your CodeForge session") { $settledText = $txt; break }
        Start-Sleep -Milliseconds 300
    }
    $bootstrapMs = [int]([DateTime]::UtcNow - $t0).TotalMilliseconds
    & $mark "bootstrap-settled" @{ ms = $bootstrapMs; settled = ($null -ne $settledText) }
    $report.bootstrapMs = $bootstrapMs
    $settledClean = if ($settledText) { $settledText -replace "\s+", " " } else { $null }
    $report.settledText = if ($settledClean) { $settledClean.Substring(0, [Math]::Min(700, $settledClean.Length)) } else { $null }
    $c.noEndlessSpinner = if ($settledText) { New-AuditResult "PASS" "Bootstrap screen left within $bootstrapMs ms while the Cloud was $Mode." } else { New-AuditResult "FAIL" "Still on the bootstrap screen after $BootstrapBudgetSeconds s with the Cloud $Mode." }
    $c.keepsSignedInIdentityOffline = if ($settledText -and $settledText -notmatch "Continue with GitHub") { New-AuditResult "PASS" "A previously signed-in user is not thrown to the sign-in screen by an unreachable Cloud." } elseif ($settledText) { New-AuditResult "FAIL" "Unreachable Cloud forced the sign-in screen for a signed-in profile." } else { New-AuditResult "NOT_RUN" "Bootstrap never settled." }
    $outageLine = if ($settledText) { (@($settledText -split "`n") | Where-Object { $_ -match "offline|unreachable|unavailable" } | Select-Object -First 1) } else { $null }
    $menuLine = if ($report.Contains("offlineAccountMenu") -and $report.offlineAccountMenu) { (@($report.offlineAccountMenu -split "`n") | Where-Object { $_ -match "offline|unreachable|unavailable" } | Select-Object -First 1) } else { $null }
    $c.offlineIsCommunicated = if ($outageLine -or $menuLine) { New-AuditResult "PASS" "The UI names the Cloud outage: '$(($outageLine, $menuLine | Where-Object { $_ } | Select-Object -First 1).Trim())'." } elseif ($settledText) { New-AuditResult "WARN" "No visible outage wording on the settled screen or account menu." } else { New-AuditResult "NOT_RUN" "Bootstrap never settled." }
    Start-Sleep -Seconds 2
    $shot = Join-Path $OutputDirectory "$Label-offline.png"
    Invoke-CodeForgeCdp -Port $RemoteDebugPort -Command screenshot -Arguments @($shot) | Out-Null
    $report.offlineScreenshot = $shot
    $report.offlineConsole = Invoke-CodeForgeCdp -Port $RemoteDebugPort -Command console -Arguments @("2000")
    $report.offlineAccountMenu = $null
    try {
        Invoke-CodeForgeCdp -Port $RemoteDebugPort -Command click -Arguments @(".cloud-account-btn") | Out-Null
        Start-Sleep -Milliseconds 400
        $report.offlineAccountMenu = (Invoke-CodeForgeCdp -Port $RemoteDebugPort -Command text) -replace "\s+", " "
        Invoke-CodeForgeCdp -Port $RemoteDebugPort -Command screenshot -Arguments @((Join-Path $OutputDirectory "$Label-offline-account-menu.png")) | Out-Null
        Invoke-CodeForgeCdp -Port $RemoteDebugPort -Command key -Arguments @("Escape") | Out-Null
    } catch {}
    $menuLine = if ($report.offlineAccountMenu) { (@(($report.offlineAccountMenu -replace " (Cloud offline|unreachable|unavailable)", "`n`$1") -split "`n") | Where-Object { $_ -match "offline|unreachable|unavailable" } | Select-Object -First 1) } else { $null }
    if ($menuLine -and $c.offlineIsCommunicated.status -ne "PASS") { $c.offlineIsCommunicated = New-AuditResult "PASS" "The account menu names the Cloud outage: '$($menuLine.Trim())'." }
    $report.offlineResources = Get-ProcessResourceSample -RootPid $instance.Pid -SampleSeconds 5
    $c.responsiveWhileOffline = if ($report.offlineResources.totalCpuPercentOfMachine -lt 5) { New-AuditResult "PASS" "Idle CPU $($report.offlineResources.totalCpuPercentOfMachine)% while the Cloud is $Mode (no retry storm)." } else { New-AuditResult "WARN" "CPU $($report.offlineResources.totalCpuPercentOfMachine)% while offline." }

    # 3. Heal the network live and ask the app to re-check without restarting it.
    if (-not $SkipRecovery) {
        Set-Content -LiteralPath $modeFile -Value "forward" -NoNewline
        & $mark "network-restored"
        $refresh = Invoke-CodeForgeCdp -Port $RemoteDebugPort -Command eval -Arguments @("window.electronAPI.refreshCatalog().then((r) => JSON.stringify(r)).catch((e) => 'ERR:' + e.message)") -TimeoutSeconds 90
        # cloud:account:get deliberately answers within CLOUD_ACCOUNT_FAST_PATH_MS with the remembered
        # identity (offline+pending) while the live fetch finishes; recovery means the account settles
        # non-offline within a bounded window, not on the first read.
        $account = $null
        $acctDeadline = [DateTime]::UtcNow.AddSeconds(30)
        while ([DateTime]::UtcNow -lt $acctDeadline) {
            $account = Invoke-CodeForgeCdp -Port $RemoteDebugPort -Command eval -Arguments @("window.electronAPI.getCloudAccount().then((a) => JSON.stringify({ offline: a && a.offline === true, pending: a && a.pending === true, plan: a && a.planName, name: a && a.user && a.user.displayName })).catch((e) => 'ERR:' + e.message)") -TimeoutSeconds 60
            $acctProbe = if ($account -is [string]) { try { $account | ConvertFrom-Json } catch { $null } } else { $account }
            if ($acctProbe -and -not $acctProbe.offline -and -not $acctProbe.pending -and $acctProbe.name) { break }
            Start-Sleep -Milliseconds 1000
        }
        $report.recovery = [ordered]@{ refresh = $refresh; account = $account }
        $acct = if ($account -is [string]) { try { $account | ConvertFrom-Json } catch { $null } } else { $account }
        $c.recoversWithoutRestart = if ($acct -and -not $acct.offline -and $acct.name) { New-AuditResult "PASS" "After the network healed, the same process re-established the Cloud account ($($acct.name), $($acct.plan)) — no restart." } else { New-AuditResult "FAIL" "Account did not recover after the network healed: $account" }
        $rf = if ($refresh -is [string]) { try { $refresh | ConvertFrom-Json } catch { $null } } else { $refresh }
        $c.catalogRecovers = if ($rf -and $rf.ok -and $rf.freeModels -gt 0) { New-AuditResult "PASS" "Catalog refresh after recovery: $($rf.freeModels) free models." } else { New-AuditResult "WARN" "Catalog refresh after recovery returned: $refresh" }
        $headerHealed = $false
        $deadline2 = [DateTime]::UtcNow.AddSeconds(20)
        while ([DateTime]::UtcNow -lt $deadline2) {
            $t = Invoke-CodeForgeCdp -Port $RemoteDebugPort -Command text
            if ($t -notmatch "Cloud offline") { $headerHealed = $true; break }
            Start-Sleep -Milliseconds 500
        }
        $c.headerReflectsRecovery = if ($headerHealed) { New-AuditResult "PASS" "The header dropped the 'Cloud offline' state on its own after the network healed." } else { New-AuditResult "FAIL" "The header still says 'Cloud offline' 20 s after the network healed." }
        Invoke-CodeForgeCdp -Port $RemoteDebugPort -Command screenshot -Arguments @((Join-Path $OutputDirectory "$Label-recovered.png")) | Out-Null
        $recoveredAll = (Invoke-CodeForgeCdp -Port $RemoteDebugPort -Command text) -replace "\s+", " "
        $report.recoveredText = $recoveredAll.Substring(0, [Math]::Min(400, $recoveredAll.Length))
    }
} catch {
    $report.error = $_.Exception.Message
} finally {
    if ($instance) {
        $report.shutdown = Stop-CodeForgeInstance -Instance $instance -GraceSeconds 15
        $c.cleanExitAfterFault = if ($report.shutdown.exitedWithinGraceMs) { New-AuditResult "PASS" "Process tree exited in $($report.shutdown.exitMs) ms after the fault run." } else { New-AuditResult "FAIL" "Processes survived close after the fault run." @{ survivors = $report.shutdown.survivorsForceKilled } }
    }
    try { $proxy.Kill() } catch {}
    $report.proxyEvents = @(($errTask.Result -split "`n") | Where-Object { $_.Trim() } | ForEach-Object { try { $_ | ConvertFrom-Json } catch { $_ } })
    $report.completedAtUtc = [DateTime]::UtcNow.ToString("o")
    $fails = @($c.Values | Where-Object { $_.status -eq "FAIL" }).Count
    $report.summary = [ordered]@{ fail = $fails; warn = @($c.Values | Where-Object { $_.status -eq "WARN" }).Count; pass = @($c.Values | Where-Object { $_.status -eq "PASS" }).Count; verdict = if ($fails -eq 0 -and -not $report.Contains("error")) { "PASS" } else { "FAIL" } }
    Write-AuditJson -Object $report -Path (Join-Path $OutputDirectory "$Label.json") | Out-Null
    $md = @("# $Label", "", "Cloud traffic mode: **$Mode** (latency $LatencyMs ms) via fault proxy on 127.0.0.1:$proxyPort", "", "| Check | Status | Detail |", "|---|---|---|")
    foreach ($k in $c.Keys) { $md += "| $k | $($c[$k].status) | $(($c[$k].detail) -replace '\|', '\|') |" }
    if ($report.Contains("error")) { $md += ""; $md += "Error: $($report.error)" }
    $md += ""; $md += "Verdict: **$($report.summary.verdict)**"
    [System.IO.File]::WriteAllLines((Join-Path $OutputDirectory "$Label.md"), $md, [System.Text.UTF8Encoding]::new($false))
    Write-Host ($report.summary | ConvertTo-Json -Compress)
}
if ($report.summary.verdict -ne "PASS") { exit 1 }
