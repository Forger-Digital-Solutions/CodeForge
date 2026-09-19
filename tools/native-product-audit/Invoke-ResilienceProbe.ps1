[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$OutputDirectory,
    [Parameter(Mandatory)][string]$ProjectPath,
    [string]$Label = "resilience",
    [string]$TaskText = "Read every file in this repository and write a short summary of what each module does into NOTES.md.",
    [int]$RemoteDebugPort = 9238,
    [switch]$SkipRendererCrash
)
<#
.SYNOPSIS Interrupt the installed app the way real life does — a second launch, a close while work is
  running, Stop, a renderer crash, a force-kill mid-task — and prove each one is handled: the right
  dialog, no phantom completion, a settled UI that accepts the next message, a clean restart.
  Uses the real per-user profile (single Cloud session chain). Requires a signed-in profile.
#>
$ErrorActionPreference = "Stop"
Import-Module (Join-Path $PSScriptRoot "CodeForgeProductAudit.psm1") -Force
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$report = [ordered]@{ schemaVersion = 1; label = $Label; startedAtUtc = [DateTime]::UtcNow.ToString("o"); checks = [ordered]@{}; timeline = @() }
$c = $report.checks
$mark = { param($e, $x) $script:report.timeline += ([ordered]@{ at = [DateTime]::UtcNow.ToString("o"); event = $e } + $(if ($x) { $x } else { @{} })) }
$node = (Get-Command node).Source
$driver = Join-Path $PSScriptRoot "scenarios\agent-task.mjs"
$profile = (Get-CodeForgeUserDataLocations).userData
function Text([int]$port) { return ((Invoke-CodeForgeCdp -Port $port -Command text) -replace "\s+", " ") }
function Shot([int]$port, [string]$name) { $f = Join-Path $OutputDirectory "$Label-$name.png"; Invoke-CodeForgeCdp -Port $port -Command screenshot -Arguments @($f) | Out-Null; return $f }
function SessionSnapshot([int]$port, [string]$sessionId) {
    # $sessionId is a bare UUID — interpolate it inside the JS string literal; JSON-quoting before
    # encodeURIComponent would send literal quotes and /api/sessions/<id> would 404.
    return Invoke-CodeForgeCdp -Port $port -Command eval -Arguments @("window.electronAPI.getRuntimeEndpoint().then((e) => fetch(e + '/api/sessions/' + encodeURIComponent('$sessionId')).then((r) => r.json())).then((d) => JSON.stringify({ status: d.session && d.session.status, turns: (d.turns || []).map((t) => ({ id: t.id, status: t.status, error: t.error || null })), pendingApprovals: (d.pendingApprovals || []).length, events: (d.events || []).length }))") -TimeoutSeconds 60
}
function StartTask([int]$port, [string]$label) {
    $env:CDP_PORT = "$port"
    $out = Join-Path $OutputDirectory $label
    & $node $driver $out $ProjectPath $TaskText --no-wait --new-task --label $label 2>&1 | Out-Null
    $json = Join-Path $out "$label.json"
    if (-not (Test-Path -LiteralPath $json)) { throw "task driver produced no report for $label" }
    return (Get-Content -LiteralPath $json -Raw | ConvertFrom-Json)
}
function WaitRunning([int]$port, [string]$sessionId, [int]$seconds) {
    $deadline = [DateTime]::UtcNow.AddSeconds($seconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        $snap = SessionSnapshot $port $sessionId
        if ($snap -and @($snap.turns | Where-Object { $_.status -eq "running" }).Count -gt 0) { return $snap }
        Start-Sleep -Milliseconds 500
    }
    return $null
}

$instance = $null
$watch = Start-ConsoleWindowWatch
try {
    $instance = Start-CodeForgeInstance -RemoteDebugPort $RemoteDebugPort -LaunchTimeoutSeconds 60 -LogDirectory $OutputDirectory
    if (-not $instance.Cdp) { throw "app did not start" }
    Invoke-CodeForgeCdp -Port $RemoteDebugPort -Command wait-selector -Arguments @(".composer-input", "40000") | Out-Null
    & $mark "launched"

    # ---- A. Second launch focuses the existing instance instead of starting another ----
    $exe = $instance.ExecutablePath
    $second = Start-Process -FilePath $exe -PassThru
    $secondExited = $second.WaitForExit(15000)
    $roots = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq "CodeForge.exe" -and $_.CommandLine -notmatch "--type=" })
    $c.singleInstance = if ($secondExited -and $roots.Count -eq 1) { New-AuditResult "PASS" "A second launch exited in $([int]([DateTime]::UtcNow - $second.StartTime.ToUniversalTime()).TotalMilliseconds) ms (code $($second.ExitCode)); exactly one CodeForge instance remains." } else { New-AuditResult "FAIL" "Second launch: exited=$secondExited, root instances=$($roots.Count)." }
    $mainWin = Get-CodeForgeMainWindow -RootPid $instance.Pid
    $c.singleInstanceFocus = if ($mainWin -and $mainWin.visible -and -not $mainWin.minimized) { New-AuditResult "PASS" "Existing window is visible and restored after the second launch (foreground=$($mainWin.foreground))." } else { New-AuditResult "WARN" "Existing window state after second launch: $($mainWin | ConvertTo-Json -Compress)" }

    # ---- B. Close while a task is running ----
    $task = StartTask $RemoteDebugPort "B-task"
    $running = WaitRunning $RemoteDebugPort $task.sessionId 30
    & $mark "task-running" @{ session = $task.sessionId }
    if (-not $running) { throw "task never reached running state (session $($task.sessionId))" }
    Start-Sleep -Seconds 2
    $win = Get-CodeForgeMainWindow -RootPid $instance.Pid
    [CodeForgeAudit.Native]::PostMessage([IntPtr]$win.handle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
    Start-Sleep -Milliseconds 1500
    $afterClose = Text $RemoteDebugPort
    $dialogUp = $afterClose -match "Cancel" -and ($afterClose -match "Quit CodeForge|Quit anyway|running")
    $stillAlive = -not $instance.Process.HasExited
    Shot $RemoteDebugPort "B-close-dialog" | Out-Null
    $c.closeProtectsActiveWork = if ($stillAlive -and $dialogUp) { New-AuditResult "PASS" "Closing during a running task shows the safe-close dialog instead of quitting." } elseif ($stillAlive) { New-AuditResult "FAIL" "Close during a running task neither quit nor showed the dialog: $($afterClose.Substring(0, [Math]::Min(200, $afterClose.Length)))" } else { New-AuditResult "FAIL" "The app quit immediately while a task was running." }
    try { Invoke-CodeForgeCdp -Port $RemoteDebugPort -Command click-text -Arguments @("Cancel", "button") | Out-Null } catch {}
    Start-Sleep -Milliseconds 600
    $c.closeDialogCancel = if (-not $instance.Process.HasExited -and ((Text $RemoteDebugPort) -notmatch "Quit CodeForge|Quit anyway")) { New-AuditResult "PASS" "Cancel dismisses the dialog and the task keeps running." } else { New-AuditResult "FAIL" "Cancel did not return to the running workspace." }

    # ---- C. Stop the running task from the UI ----
    $stopped = $false
    try { Invoke-CodeForgeCdp -Port $RemoteDebugPort -Command click-text -Arguments @("Stop", "button") | Out-Null; $stopped = $true } catch { try { Invoke-CodeForgeCdp -Port $RemoteDebugPort -Command key -Arguments @("Escape") | Out-Null; $stopped = $true } catch {} }
    & $mark "stop-requested"
    $deadline = [DateTime]::UtcNow.AddSeconds(30); $settled = $null
    while ([DateTime]::UtcNow -lt $deadline) {
        $snap = SessionSnapshot $RemoteDebugPort $task.sessionId
        if ($snap -and @($snap.turns | Where-Object { $_.status -in @("running", "paused", "waiting_for_approval") }).Count -eq 0) { $settled = $snap; break }
        Start-Sleep -Milliseconds 500
    }
    $stopMs = [int]([DateTime]::UtcNow - [DateTime]::Parse($report.timeline[-1].at).ToUniversalTime()).TotalMilliseconds
    Shot $RemoteDebugPort "C-after-stop" | Out-Null
    $stopText = Text $RemoteDebugPort
    $turnStates = if ($settled) { ($settled.turns | ForEach-Object { $_.status }) -join "," } else { "still running" }
    $c.stopCancelsWork = if ($settled -and ($settled.turns | Where-Object { $_.status -in @("cancelled", "failed") })) { New-AuditResult "PASS" "Stop settled the run in ${stopMs} ms (turn states: $turnStates); no phantom completion (session $($settled.status))." } else { New-AuditResult "FAIL" "Stop did not settle the run within 30 s (turn states: $turnStates)." }
    $c.stopNoPhantomCompletion = if ($stopText -notmatch "\bDone\b" -and ($settled -and $settled.status -ne "completed")) { New-AuditResult "PASS" "The stopped task is not presented as completed." } else { New-AuditResult "FAIL" "The stopped task reads as completed." }
    $composerEnabled = Invoke-CodeForgeCdp -Port $RemoteDebugPort -Command eval -Arguments @("(() => { const el = document.querySelector('.composer-input'); return el ? !el.disabled : false; })()")
    $c.uiSettlesAfterStop = if ($composerEnabled -eq $true -or "$composerEnabled" -eq "True") { New-AuditResult "PASS" "Composer is enabled after Stop; the next message can be sent." } else { New-AuditResult "FAIL" "Composer is not usable after Stop." }

    # ---- D. Renderer crash → interface reloads, runtime and conversation survive ----
    if (-not $SkipRendererCrash) {
        $treeBefore = @(Get-ProcessTree -RootPid $instance.Pid)
        $rendererPid = ($treeBefore | Where-Object { $_.commandLine -match "--type=renderer" } | Select-Object -First 1).pid
        try { Invoke-CodeForgeCdp -Port $RemoteDebugPort -Command eval -Arguments @("1") | Out-Null } catch {}
        & $mark "renderer-crash" @{ rendererPid = $rendererPid }
        if ($rendererPid) { Stop-Process -Id $rendererPid -Force }
        $recovered = $false
        $deadline = [DateTime]::UtcNow.AddSeconds(20)
        while ([DateTime]::UtcNow -lt $deadline) {
            try { $t = Text $RemoteDebugPort; if ($t -match "New task" -and $t -notmatch "Restoring your") { $recovered = $true; break } } catch {}
            Start-Sleep -Milliseconds 500
        }
        Shot $RemoteDebugPort "D-after-renderer-crash" | Out-Null
        $aliveMain = -not $instance.Process.HasExited
        $c.rendererCrashRecovery = if ($aliveMain -and $recovered) { New-AuditResult "PASS" "After the renderer process was killed, the interface came back on its own within 20 s; the main process and runtime stayed up." } elseif ($aliveMain) { New-AuditResult "FAIL" "Renderer killed: main process alive but the interface did not come back within 20 s." } else { New-AuditResult "FAIL" "Killing the renderer took the whole application down." }
        if ($recovered) {
            $snapAfter = SessionSnapshot $RemoteDebugPort $task.sessionId
            $c.rendererCrashKeepsConversation = if ($snapAfter -and $snapAfter.events -gt 0) { New-AuditResult "PASS" "The conversation ($($snapAfter.events) events) is intact after the interface reload." } else { New-AuditResult "FAIL" "Conversation data unavailable after the interface reload." }
        }
    }

    # ---- E. Force-kill during a task, then relaunch ----
    $task2 = StartTask $RemoteDebugPort "E-task"
    $running2 = WaitRunning $RemoteDebugPort $task2.sessionId 30
    & $mark "task2-running" @{ session = $task2.sessionId }
    $tree = @(Get-ProcessTree -RootPid $instance.Pid)
    foreach ($p in $tree) { try { Stop-Process -Id $p.pid -Force -ErrorAction SilentlyContinue } catch {} }
    Start-Sleep -Seconds 2
    $survivors = @($tree | Where-Object { Get-Process -Id $_.pid -ErrorAction SilentlyContinue })
    $runtimeJson = Join-Path $profile "runtime.json"
    $staleRuntime = Test-Path -LiteralPath $runtimeJson
    & $mark "force-killed" @{ survivors = $survivors.Count; staleRuntimeJson = $staleRuntime }
    $instance = $null
    $relaunch = Start-CodeForgeInstance -RemoteDebugPort $RemoteDebugPort -LaunchTimeoutSeconds 60 -LogDirectory $OutputDirectory
    $instance = $relaunch
    if (-not $relaunch.Cdp) { throw "app did not restart after force-kill (exited=$($relaunch.Process.HasExited))" }
    Invoke-CodeForgeCdp -Port $RemoteDebugPort -Command wait-selector -Arguments @(".composer-input", "40000") | Out-Null
    Start-Sleep -Seconds 3
    $after = SessionSnapshot $RemoteDebugPort $task2.sessionId
    Shot $RemoteDebugPort "E-after-force-kill-relaunch" | Out-Null
    $turnStatesAfter = if ($after) { ($after.turns | ForEach-Object { $_.status }) -join "," } else { "unavailable" }
    $c.forceKillRestart = New-AuditResult "PASS" "App restarted after a force-kill mid-task (stale runtime.json present before relaunch: $staleRuntime)."
    $c.forceKillNoPhantomCompletion = if ($after -and $after.status -ne "completed" -and -not ($after.turns | Where-Object { $_.status -eq "completed" })) { New-AuditResult "PASS" "The interrupted task is not reported as completed after restart (session '$($after.status)', turns: $turnStatesAfter)." } else { New-AuditResult "FAIL" "The interrupted task reads as completed after restart (session '$($after.status)', turns: $turnStatesAfter)." }
    $c.forceKillDatabaseUsable = if ($after -and $after.events -gt 0) { New-AuditResult "PASS" "Session database opened cleanly after the crash ($($after.events) events preserved)." } else { New-AuditResult "FAIL" "Session data unavailable after the crash." }
    $c.forceKillNoStaleLock = if (-not (Get-Process -Name CodeForge -ErrorAction SilentlyContinue | Where-Object { $_.Id -notin @(Get-ProcessTree -RootPid $relaunch.Pid | ForEach-Object { $_.pid }) })) { New-AuditResult "PASS" "No orphaned CodeForge processes from the killed instance." } else { New-AuditResult "FAIL" "Orphaned processes from the killed instance remain." }
} catch {
    $report.error = $_.Exception.Message
    $report.errorAt = $_.ScriptStackTrace
} finally {
    if ($instance -and -not $instance.Process.HasExited) {
        # A recovering/running task may be active: use the dialog path (Quit anyway) if it appears.
        $sd = Stop-CodeForgeInstance -Instance $instance -GraceSeconds 6
        if (-not $sd.exitedWithinGraceMs) {
            try { Invoke-CodeForgeCdp -Port $RemoteDebugPort -Command click-text -Arguments @("Quit anyway", "button") | Out-Null } catch { try { Invoke-CodeForgeCdp -Port $RemoteDebugPort -Command click-text -Arguments @("Quit CodeForge", "button") | Out-Null } catch {} }
            Start-Sleep -Seconds 5
            foreach ($p in @(Get-ProcessTree -RootPid $instance.Pid)) { try { Stop-Process -Id $p.pid -Force -ErrorAction SilentlyContinue } catch {} }
        }
        $report.shutdown = $sd
    }
    $report.consoleWindows = Stop-ConsoleWindowWatch -Watch $watch
    $seen = @($report.consoleWindows.consoleWindowsSeen)
    $c.noConsoleWindows = if ($seen.Count -eq 0) { New-AuditResult "PASS" "No console window appeared during tasks, Stop, crash or restart ($($report.consoleWindows.samples) samples)." } else { New-AuditResult "FAIL" "$($seen.Count) console window(s) appeared." @{ windows = $seen } }
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
