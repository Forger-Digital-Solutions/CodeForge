[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$OutputDirectory,
    [Parameter(Mandatory)][string]$ProfileDirectory,
    [string]$Label = "window-behavior",
    [int]$RemoteDebugPort = 9233
)
<#
.SYNOPSIS Native window behaviour of the installed app: maximize/restore/minimize, small-laptop and large
  sizes, a second monitor with different scaling, and persisted window state across a relaunch. Layout
  is checked from inside the real renderer (overflow, offscreen controls, composer visibility).
#>
$ErrorActionPreference = "Stop"
Import-Module (Join-Path $PSScriptRoot "CodeForgeProductAudit.psm1") -Force
Add-Type -AssemblyName System.Windows.Forms
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$report = [ordered]@{ schemaVersion = 1; label = $Label; startedAtUtc = [DateTime]::UtcNow.ToString("o"); checks = [ordered]@{}; states = @() }
$c = $report.checks
$screens = @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object { [ordered]@{ device = $_.DeviceName; primary = $_.Primary; bounds = @($_.Bounds.X, $_.Bounds.Y, $_.Bounds.Width, $_.Bounds.Height) } })
$report.screens = $screens

function Observe([int]$port, [string]$name, [int]$rootPid) {
    Start-Sleep -Milliseconds 700
    $layout = Invoke-CodeForgeCdp -Port $port -Command eval -Arguments @("(() => { const de = document.documentElement; const composer = document.querySelector('.composer-input'); const send = document.querySelector('button[aria-label=\'Send\'], .composer-send, button[title=\'Send\']'); const r = composer ? composer.getBoundingClientRect() : null; const s = send ? send.getBoundingClientRect() : null; const inView = (b) => b && b.width > 0 && b.height > 0 && b.left >= 0 && b.top >= 0 && b.right <= de.clientWidth + 1 && b.bottom <= de.clientHeight + 1; return { viewport: [de.clientWidth, de.clientHeight], dpr: window.devicePixelRatio, horizontalOverflow: de.scrollWidth > de.clientWidth + 1, composerVisible: inView(r), sendVisible: s ? inView(s) : null, sidebarVisible: Boolean(document.querySelector('.nav, .sidebar, nav')), headerVisible: Boolean(document.querySelector('header')) }; })()")
    $win = Get-CodeForgeMainWindow -RootPid $rootPid
    $shot = Join-Path $OutputDirectory "$Label-$name.png"
    try { Invoke-CodeForgeCdp -Port $port -Command screenshot -Arguments @($shot) | Out-Null } catch { $shot = $null }
    $entry = [ordered]@{ state = $name; window = $win; layout = $layout; screenshot = $shot }
    $script:report.states += $entry
    return $entry
}

$instance = $null
try {
    $instance = Start-CodeForgeInstance -ProfileDirectory $ProfileDirectory -RemoteDebugPort $RemoteDebugPort -LaunchTimeoutSeconds 60 -LogDirectory $OutputDirectory
    if (-not $instance.Cdp) { throw "app did not start" }
    Start-Sleep -Seconds 4
    $pid0 = $instance.Pid
    $initial = Observe $RemoteDebugPort "initial" $pid0
    $c.initialLayout = if (-not $initial.layout.horizontalOverflow -and $initial.layout.composerVisible -ne $false) { New-AuditResult "PASS" "Initial window $($initial.window.width)x$($initial.window.height) at DPR $($initial.layout.dpr): no horizontal overflow; composer visible." } else { New-AuditResult "FAIL" "Initial layout overflow=$($initial.layout.horizontalOverflow) composerVisible=$($initial.layout.composerVisible)." }

    # The launch may restore maximized from the persisted profile, so capture an explicit normal-state
    # baseline before maximize/restore comparisons — comparing a restored rect against maximized bounds
    # would fail every correctly-behaving app.
    Set-CodeForgeWindowState -RootPid $pid0 -State normal | Out-Null
    $baseline = Observe $RemoteDebugPort "baseline-normal" $pid0

    Set-CodeForgeWindowState -RootPid $pid0 -State maximized | Out-Null
    $max = Observe $RemoteDebugPort "maximized" $pid0
    $c.maximize = if ($max.window.maximized -and -not $max.layout.horizontalOverflow) { New-AuditResult "PASS" "Maximized: viewport $($max.layout.viewport -join 'x'), no overflow." } else { New-AuditResult "FAIL" "Maximize did not apply cleanly (maximized=$($max.window.maximized), overflow=$($max.layout.horizontalOverflow))." }

    Set-CodeForgeWindowState -RootPid $pid0 -State normal | Out-Null
    $restored = Observe $RemoteDebugPort "restored" $pid0
    $c.restore = if (-not $restored.window.maximized -and [math]::Abs($restored.window.width - $baseline.window.width) -le 4) { New-AuditResult "PASS" "Restore returns to the previous size ($($restored.window.width)x$($restored.window.height))." } else { New-AuditResult "FAIL" "Restore geometry differs: $($restored.window.width)x$($restored.window.height) vs normal baseline $($baseline.window.width)x$($baseline.window.height)." }

    Set-CodeForgeWindowState -RootPid $pid0 -State minimized | Out-Null
    $min = Get-CodeForgeMainWindow -RootPid $pid0
    $c.minimize = if ($min.minimized) { New-AuditResult "PASS" "Minimize applies." } else { New-AuditResult "FAIL" "Window did not minimize." }
    Set-CodeForgeWindowState -RootPid $pid0 -State normal | Out-Null
    $afterMin = Get-CodeForgeMainWindow -RootPid $pid0
    $c.restoreFromMinimize = if (-not $afterMin.minimized -and $afterMin.visible) { New-AuditResult "PASS" "Restores from the taskbar." } else { New-AuditResult "FAIL" "Did not restore from minimized." }

    # Small laptop screen: 1366x768 physical at 100% ~= the smallest common Windows laptop. The
    # native SetWindowPos space vs the CSS viewport is calibrated from the observed window rather
    # than assumed — depending on DPI awareness it may be physical (dpr x css) or already logical.
    $pxPerCss = if ($initial.layout.viewport -and $initial.layout.viewport[0] -gt 0) { [double]$initial.window.width / [double]$initial.layout.viewport[0] } else { 1.0 }
    $smallW = [int](1280 * $pxPerCss); $smallH = [int](720 * $pxPerCss)
    Set-CodeForgeWindowState -RootPid $pid0 -State normal -X 20 -Y 20 -Width $smallW -Height $smallH | Out-Null
    $small = Observe $RemoteDebugPort "small-1280x720" $pid0
    $c.smallLaptop = if (-not $small.layout.horizontalOverflow -and $small.layout.composerVisible -ne $false -and ($small.layout.sendVisible -ne $false)) { New-AuditResult "PASS" "1280x720 CSS viewport: no overflow, composer and send visible." } else { New-AuditResult "FAIL" "1280x720 CSS viewport: overflow=$($small.layout.horizontalOverflow) composer=$($small.layout.composerVisible) send=$($small.layout.sendVisible)." }

    $tinyW = [int](1024 * $pxPerCss); $tinyH = [int](640 * $pxPerCss)
    Set-CodeForgeWindowState -RootPid $pid0 -State normal -X 20 -Y 20 -Width $tinyW -Height $tinyH | Out-Null
    $tiny = Observe $RemoteDebugPort "minimum-1024x640" $pid0
    $c.minimumSize = if (-not $tiny.layout.horizontalOverflow -and $tiny.layout.composerVisible -ne $false) { New-AuditResult "PASS" "At the smallest allowed size the composer stays reachable and nothing overflows horizontally (viewport $($tiny.layout.viewport -join 'x'))." } else { New-AuditResult "WARN" "Minimum size: overflow=$($tiny.layout.horizontalOverflow) composer=$($tiny.layout.composerVisible) viewport=$($tiny.layout.viewport -join 'x')." }

    # Second monitor (different scaling) when present.
    $secondary = $screens | Where-Object { -not $_.primary } | Select-Object -First 1
    if ($secondary) {
        $bx = $secondary.bounds
        Set-CodeForgeWindowState -RootPid $pid0 -State normal -X ($bx[0] + 40) -Y ($bx[1] + 40) -Width ([int]($bx[2] * 0.8)) -Height ([int]($bx[3] * 0.8)) | Out-Null
        $second = Observe $RemoteDebugPort "second-monitor" $pid0
        $onSecond = $second.window.left -ge $bx[0] - 50 -and $second.window.left -lt ($bx[0] + $bx[2])
        $c.secondMonitor = if ($onSecond -and -not $second.layout.horizontalOverflow -and $second.layout.composerVisible -ne $false) { New-AuditResult "PASS" "On the second monitor (DPR $($second.layout.dpr), viewport $($second.layout.viewport -join 'x')): layout intact." } else { New-AuditResult "WARN" "Second monitor move: onSecond=$onSecond overflow=$($second.layout.horizontalOverflow) composer=$($second.layout.composerVisible)." }
        # Snap-like half width on the secondary, then back to primary.
        Set-CodeForgeWindowState -RootPid $pid0 -State normal -X 60 -Y 40 -Width ([int](1400 * $pxPerCss)) -Height ([int](816 * $pxPerCss)) | Out-Null
    }
    # Leave a distinctive, valid geometry so the relaunch check can prove persistence. It must fit
    # the logical work area — the app correctly clamps oversized saved bounds, so asking for more
    # than the screen would test the clamp, not persistence.
    $finalW = [int](1100 * $pxPerCss); $finalH = [int](680 * $pxPerCss)
    Set-CodeForgeWindowState -RootPid $pid0 -State normal -X 90 -Y 60 -Width $finalW -Height $finalH | Out-Null
    $final = Observe $RemoteDebugPort "final" $pid0
    $report.shutdown = Stop-CodeForgeInstance -Instance $instance -GraceSeconds 15
    $instance = $null
    Start-Sleep -Seconds 2
    $instance = Start-CodeForgeInstance -ProfileDirectory $ProfileDirectory -RemoteDebugPort $RemoteDebugPort -LaunchTimeoutSeconds 60 -LogDirectory $OutputDirectory
    Start-Sleep -Seconds 4
    $again = Observe $RemoteDebugPort "relaunched" $instance.Pid
    $dw = [math]::Abs($again.window.width - $final.window.width); $dh = [math]::Abs($again.window.height - $final.window.height)
    $c.windowStatePersists = if ($dw -le 8 -and $dh -le 8) { New-AuditResult "PASS" "Window size restored across relaunch ($($again.window.width)x$($again.window.height) vs $($final.window.width)x$($final.window.height))." } else { New-AuditResult "FAIL" "Window geometry not restored: relaunched $($again.window.width)x$($again.window.height), expected $($final.window.width)x$($final.window.height)." }
} catch {
    $report.error = $_.Exception.Message
} finally {
    if ($instance) { $report.shutdown2 = Stop-CodeForgeInstance -Instance $instance -GraceSeconds 15 }
    $report.completedAtUtc = [DateTime]::UtcNow.ToString("o")
    $fails = @($c.Values | Where-Object { $_.status -eq "FAIL" }).Count
    $report.summary = [ordered]@{ fail = $fails; warn = @($c.Values | Where-Object { $_.status -eq "WARN" }).Count; pass = @($c.Values | Where-Object { $_.status -eq "PASS" }).Count; verdict = if ($fails -eq 0 -and -not $report.Contains("error")) { "PASS" } else { "FAIL" } }
    Write-AuditJson -Object $report -Path (Join-Path $OutputDirectory "$Label.json") | Out-Null
    $md = @("# $Label", "", "| Check | Status | Detail |", "|---|---|---|")
    foreach ($k in $c.Keys) { $md += "| $k | $($c[$k].status) | $(($c[$k].detail) -replace '\|', '\|') |" }
    if ($report.Contains("error")) { $md += ""; $md += "Error: $($report.error)" }
    $md += ""; $md += "Verdict: **$($report.summary.verdict)**"
    [System.IO.File]::WriteAllLines((Join-Path $OutputDirectory "$Label.md"), $md, [System.Text.UTF8Encoding]::new($false))
    Write-Host ($report.summary | ConvertTo-Json -Compress)
}
if ($report.summary.verdict -ne "PASS") { exit 1 }
