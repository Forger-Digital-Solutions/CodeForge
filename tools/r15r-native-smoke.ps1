[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Fa-f0-9]{64}$')]
    [string]$ExpectedSha256,

    [string]$InstallerPath,

    [string]$CloudUrl = "https://codeforge-cloud-va.onrender.com",

    [string]$EvidenceDirectory,

    [ValidateRange(1024, 65535)]
    [int]$RemoteDebugPort = 9224,

    [ValidateRange(10, 120)]
    [int]$LaunchTimeoutSeconds = 45,

    [switch]$Install,

    [switch]$KeepOpen
)

$ErrorActionPreference = "Stop"
$repositoryRoot = Split-Path -Parent $PSScriptRoot
if (-not $EvidenceDirectory) {
    $EvidenceDirectory = Join-Path $repositoryRoot "docs\evidence\r15r-native-closure\04-native-harness"
}

function New-Result([string]$Status, [string]$Detail) {
    return [ordered]@{ status = $Status; detail = $Detail }
}

function Get-PeArchitecture([string]$Path) {
    $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    try {
        $reader = [System.IO.BinaryReader]::new($stream)
        $stream.Seek(0x3c, [System.IO.SeekOrigin]::Begin) | Out-Null
        $headerOffset = $reader.ReadInt32()
        $stream.Seek($headerOffset + 4, [System.IO.SeekOrigin]::Begin) | Out-Null
        $machine = $reader.ReadUInt16()
        switch ($machine) {
            0x8664 { return "x64" }
            0x014c { return "x86" }
            0xAA64 { return "arm64" }
            default { return "unknown-0x{0:X4}" -f $machine }
        }
    }
    finally {
        $stream.Dispose()
    }
}

function Find-InstalledCodeForge([string]$Installer) {
    $expectedPaths = @(
        (Join-Path $env:LOCALAPPDATA "Programs\codeforge-desktop\CodeForge.exe"),
        (Join-Path $env:LOCALAPPDATA "Programs\CodeForge\CodeForge.exe")
    ) | Where-Object { Test-Path -LiteralPath $_ }
    if (@($expectedPaths).Count -gt 0) { return ($expectedPaths | Select-Object -First 1) }

    if ($Install) {
        Write-Host "Opening the verified installer for the ordinary per-user install flow. Complete its visible screens, then close it."
        $installerProcess = Start-Process -FilePath $Installer -PassThru -Wait
        if ($installerProcess.ExitCode -ne 0) { throw "Installer exited with code $($installerProcess.ExitCode)." }
        $expectedPaths = @(
            (Join-Path $env:LOCALAPPDATA "Programs\codeforge-desktop\CodeForge.exe"),
            (Join-Path $env:LOCALAPPDATA "Programs\CodeForge\CodeForge.exe")
        ) | Where-Object { Test-Path -LiteralPath $_ }
        if (@($expectedPaths).Count -gt 0) { return ($expectedPaths | Select-Object -First 1) }
    }

    throw "No ordinary installed CodeForge.exe was found. Re-run with -Install to open the verified installer, or complete the normal installer flow first."
}

function Test-CloudTarget([string]$Value) {
    try {
        $uri = [Uri]$Value
    }
    catch {
        return New-Result "FAIL" "Cloud endpoint is not an absolute URL."
    }
    $hostName = $uri.Host.TrimEnd('.').ToLowerInvariant()
    $isLoopback = $hostName -eq "localhost" -or $hostName -eq "::1" -or $hostName.StartsWith("127.")
    if ($uri.Scheme -ne "https" -or $isLoopback -or $hostName.Contains("staging") -or $hostName.Contains("dev")) {
        return New-Result "FAIL" "Cloud endpoint is not a public production HTTPS origin."
    }
    return New-Result "PASS" "Public production HTTPS origin accepted for the native run."
}

function Wait-ForCdp([int]$Port, [int]$TimeoutSeconds) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        try {
            $version = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 3
            if ($version.Browser) { return $version }
        }
        catch {
            Start-Sleep -Milliseconds 500
        }
    }
    return $null
}

New-Item -ItemType Directory -Path $EvidenceDirectory -Force | Out-Null
$runId = [Guid]::NewGuid().ToString("N")
$profileDirectory = Join-Path $EvidenceDirectory "smoke-user-data-$runId"
$screenshotPath = Join-Path $EvidenceDirectory "r15r-native-first-frame-$runId.png"
$stdoutPath = Join-Path $EvidenceDirectory "r15r-native-$runId.stdout.log"
$stderrPath = Join-Path $EvidenceDirectory "r15r-native-$runId.stderr.log"
$reportPath = Join-Path $EvidenceDirectory "r15r-native-smoke.json"
$startedAt = [DateTime]::UtcNow.ToString("o")
$result = [ordered]@{
    schemaVersion = 1
    startedAtUtc = $startedAt
    installer = New-Result "NOT_RUN" "Installer was not validated."
    installedApplication = New-Result "NOT_RUN" "Ordinary installed application was not located."
    architecture = New-Result "NOT_RUN" "Executable architecture was not inspected."
    cloudTarget = Test-CloudTarget $CloudUrl
    freshProfile = New-Result "NOT_RUN" "Fresh profile was not created."
    rendererFirstFrame = New-Result "NOT_RUN" "The renderer was not launched."
    githubOAuth = New-Result "NOT_RUN" "Requires a human to complete GitHub authorization after the visible first-frame check."
    certification = "BLOCKED"
}

$applicationProcess = $null
$originalElectronRunAsNode = [Environment]::GetEnvironmentVariable("ELECTRON_RUN_AS_NODE", "Process")
$originalCdpPort = [Environment]::GetEnvironmentVariable("CDP_PORT", "Process")

try {
    if (-not $InstallerPath) {
        $releaseDirectory = Join-Path $repositoryRoot "apps\desktop\release"
        $InstallerPath = Get-ChildItem -LiteralPath $releaseDirectory -Filter "CodeForge-Setup-*.exe" -File |
            Sort-Object LastWriteTimeUtc -Descending |
            Select-Object -First 1 -ExpandProperty FullName
    }
    if (-not $InstallerPath -or -not (Test-Path -LiteralPath $InstallerPath)) { throw "A CodeForge setup executable could not be found." }

    $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $InstallerPath).Hash
    if (-not $actualHash.Equals($ExpectedSha256, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Installer SHA-256 does not match the supplied expected hash."
    }
    $result.installer = New-Result "PASS" "Installer SHA-256 matches the supplied release hash."

    $exePath = Find-InstalledCodeForge $InstallerPath
    $result.installedApplication = New-Result "PASS" "Ordinary installed CodeForge executable was selected."
    $architecture = Get-PeArchitecture $exePath
    $result.architecture = if ($architecture -eq "x64") { New-Result "PASS" "Installed executable is x64." } else { New-Result "FAIL" "Installed executable architecture is $architecture, not x64." }
    if ($result.architecture.status -ne "PASS") { throw $result.architecture.detail }

    New-Item -ItemType Directory -Path $profileDirectory -Force | Out-Null
    $result.freshProfile = New-Result "PASS" "A new isolated Electron user-data directory was created for this run."

    $argumentList = "--user-data-dir=`"$profileDirectory`" --remote-debugging-port=$RemoteDebugPort"
    # The host may itself use Electron-as-Node. Remove that inherited mode for the real desktop
    # child so Chromium receives the profile and DevTools flags normally.
    $applicationProcess = Start-Process -FilePath $exePath -ArgumentList $argumentList -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -Environment @{ ELECTRON_RUN_AS_NODE = $null }
    $cdpVersion = Wait-ForCdp -Port $RemoteDebugPort -TimeoutSeconds $LaunchTimeoutSeconds
    if (-not $cdpVersion) {
        $state = if ($applicationProcess.HasExited) { "The application process exited with code $($applicationProcess.ExitCode) before it exposed DevTools." } else { "The application process did not expose a renderer DevTools target." }
        $result.rendererFirstFrame = New-Result "FAIL" $state
        $result.rendererFirstFrame.stdout = $stdoutPath
        $result.rendererFirstFrame.stderr = $stderrPath
        throw $state
    }

    $cdpScript = Join-Path $repositoryRoot "scripts\cert\cdp.mjs"
    $node = Get-Command node -ErrorAction Stop | Select-Object -First 1 -ExpandProperty Source
    [Environment]::SetEnvironmentVariable("CDP_PORT", "$RemoteDebugPort", "Process")
    $rendererState = & $node $cdpScript eval "JSON.stringify({readyState:document.readyState,title:document.title,hasRoot:Boolean(document.querySelector('#root'))})"
    if ($LASTEXITCODE -ne 0) { throw "CDP could not inspect the renderer first frame." }
    & $node $cdpScript screenshot $screenshotPath | Out-Null
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $screenshotPath)) { throw "CDP could not capture the renderer first frame." }
    $result.rendererFirstFrame = New-Result "PASS" "Renderer DevTools responded and a first-frame screenshot was captured."
    $result.rendererFirstFrame.rendererState = $rendererState
    $result.rendererFirstFrame.screenshot = $screenshotPath
    $result.certification = "BLOCKED"
}
catch {
    if ($result.rendererFirstFrame.status -eq "NOT_RUN") {
        $result.rendererFirstFrame = New-Result "BLOCKED" $_.Exception.Message
    }
    $result.certification = "BLOCKED"
}
finally {
    [Environment]::SetEnvironmentVariable("ELECTRON_RUN_AS_NODE", $originalElectronRunAsNode, "Process")
    [Environment]::SetEnvironmentVariable("CDP_PORT", $originalCdpPort, "Process")
    if ($applicationProcess -and -not $KeepOpen -and -not $applicationProcess.HasExited) {
        Stop-Process -Id $applicationProcess.Id -Force
    }
    $result.completedAtUtc = [DateTime]::UtcNow.ToString("o")
    $result.profileDirectory = $profileDirectory
    $result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $reportPath -Encoding utf8
    $result | ConvertTo-Json -Depth 6
}

if ($result.rendererFirstFrame.status -ne "PASS") { exit 1 }
if ($result.githubOAuth.status -ne "PASS") { exit 2 }
