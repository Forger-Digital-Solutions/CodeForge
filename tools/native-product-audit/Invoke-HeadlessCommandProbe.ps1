<#
.SYNOPSIS
  Proves whether background agent commands open a visible terminal window on this machine.
.DESCRIPTION
  Runs each command through the INSTALLED application's own execution path (packaged
  @codeforge/terminal executor under the packaged Electron runtime, exactly as the agent's
  run-command tool and ForgeVerify do) while a 40 ms window sampler records every console window
  (conhost, Windows Terminal, mintty) that appears. Any window seen is a FAIL.
.PARAMETER Commands   Commands to run (default: the fixture's "npm test", a bare node script, and a bash -c call).
.PARAMETER Cwd        Working directory for the commands (default: the r16 bugfix fixture).
#>
[CmdletBinding()]
param(
    [string]$InstallDirectory,
    [string]$Cwd = (Join-Path $env:USERPROFILE "Documents\r16-fixtures\bugfix-repo"),
    [string[]]$Commands = @('npm test', 'node -e "console.log(1)"', 'npm run --silent test', 'cmd /c echo cmd-child', 'bash -c "echo bash-child"'),
    [string]$OutputDirectory = (Join-Path $PSScriptRoot "..\..\docs\evidence\r16-desktop-product\06-terminal-headless"),
    [switch]$IncludeShellMode,
    # Path to a repo "packages" directory whose built dist should be exercised instead of the installed copy.
    [string]$PackagesDirectory,
    [string]$OutputName = "headless-command-probe"
)
$ErrorActionPreference = "Stop"
Import-Module (Join-Path $PSScriptRoot "CodeForgeProductAudit.psm1") -Force
if (-not $InstallDirectory) { $InstallDirectory = Get-CodeForgeInstallDirectory }
if (-not $InstallDirectory) { throw "CodeForge is not installed" }
$exe = Join-Path $InstallDirectory "CodeForge.exe"
$resources = Join-Path $InstallDirectory "resources"
$probe = Join-Path $PSScriptRoot "scenarios\headless-command-probe.cjs"
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null

$runs = @()
$modes = @("prepared"); if ($IncludeShellMode) { $modes += @("shell", "shell-electron") }
foreach ($mode in $modes) {
    foreach ($command in $Commands) {
        $watch = Start-ConsoleWindowWatch -IntervalMs 40
        $stdoutFile = Join-Path $env:TEMP ("cf-headless-" + [guid]::NewGuid().ToString("N") + ".json")
        $env:ELECTRON_RUN_AS_NODE = "1"
        try {
            $argList = @("`"$probe`"", "`"$resources`"", "`"$Cwd`"", "`"$($command.Replace('"', '\"'))`"", "--mode", $mode)
            if ($PackagesDirectory) { $argList += @("--packages", "`"$PackagesDirectory`"") }
            $proc = Start-Process -FilePath $exe -ArgumentList $argList -NoNewWindow -Wait -PassThru -RedirectStandardOutput $stdoutFile
        } finally {
            Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
        }
        Start-Sleep -Milliseconds 400
        $windows = Stop-ConsoleWindowWatch -Watch $watch
        $raw = (Get-Content -LiteralPath $stdoutFile -Raw -ErrorAction SilentlyContinue)
        Remove-Item -LiteralPath $stdoutFile -Force -ErrorAction SilentlyContinue
        $parsed = $null; try { $parsed = $raw | ConvertFrom-Json } catch {}
        $runs += [ordered]@{
            command = $command
            mode = $mode
            probeExit = $proc.ExitCode
            backend = (Get-Prop $parsed "backend")
            exitCode = (Get-Prop $parsed "exitCode")
            runtimeKind = (Get-Prop (Get-Prop $parsed "prepared") "runtimeKind")
            spawnError = (Get-Prop $parsed "spawnError")
            outputTail = (Get-Prop $parsed "outputTail")
            samples = $windows.samples
            consoleWindowsSeen = @($windows.consoleWindowsSeen)
            pass = (@($windows.consoleWindowsSeen).Count -eq 0)
        }
        Write-Host ("{0,-9} {1,-40} backend={2} exit={3} windows={4}" -f $mode, $command, (Get-Prop $parsed "backend"), (Get-Prop $parsed "exitCode"), @($windows.consoleWindowsSeen).Count)
    }
}
$report = [ordered]@{
    generatedAt = [DateTime]::UtcNow.ToString("o")
    installDirectory = $InstallDirectory
    appVersion = (Get-CodeForgeFileIdentity -Path $exe).productVersion
    cwd = $Cwd
    packagesDirectory = $(if ($PackagesDirectory) { $PackagesDirectory } else { "installed" })
    npmScriptShell = (& npm config get script-shell 2>$null)
    defaultTerminalDelegation = (Get-ItemProperty -Path "HKCU:\Console\%%Startup" -ErrorAction SilentlyContinue).DelegationTerminal
    runs = $runs
    verdict = $(if (@($runs | Where-Object { -not $_.pass }).Count -eq 0) { "PASS" } else { "FAIL" })
}
$json = Join-Path $OutputDirectory "$OutputName.json"
$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $json -Encoding UTF8
Write-Host "verdict: $($report.verdict)  ->  $json"
