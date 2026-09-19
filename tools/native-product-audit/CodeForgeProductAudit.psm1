#requires -Version 5.1
<#
.SYNOPSIS
  CodeForge Windows application lifecycle harness (R16).

.DESCRIPTION
  Reusable release infrastructure for auditing the INSTALLED CodeForge desktop product:
  installer discovery and identity, silent install/upgrade/uninstall, installed-file and
  registry inventories, shortcut inspection, user-data inventories, real process launch with
  an isolated or retained profile, Chrome DevTools inspection of the live renderer, process-tree
  and console-window observation, graceful shutdown, leak detection, and before/after
  comparisons. Every function returns plain objects so callers can serialize them as evidence.

  Nothing here fakes product state: the harness only observes the real installer, the real
  installed executable, the real registry and the real renderer.
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$script:ProductName = "CodeForge"
$script:PackageName = "codeforge-desktop"
$script:AppId = "app.codeforge.desktop"
# electron-builder derives the NSIS registry GUID from appId (UUID v5, fixed namespace).
$script:InstallerGuid = "5f9ca3ee-d929-5c0e-815d-8c970892966c"
$script:RepositoryRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$script:CdpDriver = Join-Path $PSScriptRoot "cdp-driver.mjs"

# ----------------------------------------------------------------------------------------------
# Native interop: top-level window enumeration (console-window detection) and window messaging.
# ----------------------------------------------------------------------------------------------
if (-not ("CodeForgeAudit.Native" -as [type])) {
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
namespace CodeForgeAudit {
  public class WindowInfo { public long Handle; public uint Pid; public string ClassName; public string Title; public bool Visible; public int Left; public int Top; public int Width; public int Height; }
  public static class Native {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll", SetLastError = true)] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    public static List<WindowInfo> ListTopLevelWindows() {
      var list = new List<WindowInfo>();
      EnumWindows((h, l) => {
        var cls = new StringBuilder(256); GetClassName(h, cls, cls.Capacity);
        var title = new StringBuilder(512); GetWindowText(h, title, title.Capacity);
        uint pid; GetWindowThreadProcessId(h, out pid);
        RECT r; GetWindowRect(h, out r);
        list.Add(new WindowInfo { Handle = h.ToInt64(), Pid = pid, ClassName = cls.ToString(), Title = title.ToString(), Visible = IsWindowVisible(h), Left = r.Left, Top = r.Top, Width = r.Right - r.Left, Height = r.Bottom - r.Top });
        return true;
      }, IntPtr.Zero);
      return list;
    }
  }
}
"@
}

# ----------------------------------------------------------------------------------------------
# Result helpers
# ----------------------------------------------------------------------------------------------
function Get-Prop {
    <# .SYNOPSIS Strict-mode-safe property read: $null when the property does not exist. #>
    param([AllowNull()]$Object, [Parameter(Mandatory)][string]$Name)
    if ($null -eq $Object) { return $null }
    $p = $Object.PSObject.Properties[$Name]
    if ($null -eq $p) { return $null }
    return $p.Value
}

function New-AuditResult {
    param([Parameter(Mandatory)][ValidateSet("PASS", "FAIL", "WARN", "BLOCKED", "NOT_RUN", "INFO")][string]$Status, [Parameter(Mandatory)][string]$Detail, [hashtable]$Data)
    $r = [ordered]@{ status = $Status; detail = $Detail }
    if ($Data) { foreach ($k in $Data.Keys) { $r[$k] = $Data[$k] } }
    return $r
}

function Write-AuditJson {
    param([Parameter(Mandatory)]$Object, [Parameter(Mandatory)][string]$Path, [int]$Depth = 12)
    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $json = $Object | ConvertTo-Json -Depth $Depth
    [System.IO.File]::WriteAllText($Path, $json, [System.Text.UTF8Encoding]::new($false))
    return $Path
}

# ----------------------------------------------------------------------------------------------
# Installer discovery and identity
# ----------------------------------------------------------------------------------------------
function Get-CodeForgeInstaller {
    <# .SYNOPSIS Locate a CodeForge NSIS setup executable (newest by default). #>
    param([string]$Path, [string]$ReleaseDirectory)
    if ($Path) {
        if (-not (Test-Path -LiteralPath $Path)) { throw "Installer not found: $Path" }
        return (Get-Item -LiteralPath $Path).FullName
    }
    if (-not $ReleaseDirectory) { $ReleaseDirectory = Join-Path $script:RepositoryRoot "apps\desktop\release" }
    $candidate = Get-ChildItem -LiteralPath $ReleaseDirectory -Filter "CodeForge-Setup-*.exe" -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
    if (-not $candidate) { throw "No CodeForge-Setup-*.exe found under $ReleaseDirectory" }
    return $candidate.FullName
}

function Get-PeArchitecture {
    param([Parameter(Mandatory)][string]$Path)
    $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    try {
        $reader = [System.IO.BinaryReader]::new($stream)
        $stream.Seek(0x3c, [System.IO.SeekOrigin]::Begin) | Out-Null
        $headerOffset = $reader.ReadInt32()
        $stream.Seek($headerOffset + 4, [System.IO.SeekOrigin]::Begin) | Out-Null
        switch ($reader.ReadUInt16()) { 0x8664 { "x64" } 0x014c { "x86" } 0xAA64 { "arm64" } default { "unknown" } }
    } finally { $stream.Dispose() }
}

function Get-CodeForgeFileIdentity {
    <# .SYNOPSIS SHA-256, size, version resources, Authenticode state and PE architecture of an executable. #>
    param([Parameter(Mandatory)][string]$Path)
    $item = Get-Item -LiteralPath $Path
    $sig = Get-AuthenticodeSignature -LiteralPath $Path
    $vi = $item.VersionInfo
    return [ordered]@{
        path = $item.FullName
        fileName = $item.Name
        sizeBytes = $item.Length
        lastWriteUtc = $item.LastWriteTimeUtc.ToString("o")
        sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash
        architecture = Get-PeArchitecture $Path
        productName = $vi.ProductName
        productVersion = $vi.ProductVersion
        fileVersion = $vi.FileVersion
        companyName = $vi.CompanyName
        fileDescription = $vi.FileDescription
        legalCopyright = $vi.LegalCopyright
        signatureStatus = [string]$sig.Status
        signerSubject = if ($sig.SignerCertificate) { $sig.SignerCertificate.Subject } else { $null }
    }
}

# ----------------------------------------------------------------------------------------------
# Installed state: program directory, registry, shortcuts
# ----------------------------------------------------------------------------------------------
function Get-CodeForgeInstallDirectory {
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA "Programs\$($script:PackageName)"),
        (Join-Path $env:LOCALAPPDATA "Programs\$($script:ProductName)")
    )
    $reg = Get-ItemProperty -Path "HKCU:\Software\$($script:InstallerGuid)" -ErrorAction SilentlyContinue
    if ($reg -and (Get-Prop $reg InstallLocation)) { $candidates = @((Get-Prop $reg InstallLocation)) + $candidates }
    foreach ($c in $candidates) { if (Test-Path -LiteralPath (Join-Path $c "CodeForge.exe")) { return (Get-Item -LiteralPath $c).FullName } }
    return $null
}

function Get-CodeForgeRegistryState {
    <# .SYNOPSIS Uninstall registration (Apps & Features) and install-location key, HKCU and HKLM. #>
    $out = [ordered]@{ uninstallKey = $null; installKey = $null; perMachineUninstallKeys = @() }
    $u = Get-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$($script:InstallerGuid)" -ErrorAction SilentlyContinue
    if ($u) {
        $out.uninstallKey = [ordered]@{
            key = "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\$($script:InstallerGuid)"
            displayName = Get-Prop $u DisplayName; displayVersion = Get-Prop $u DisplayVersion; publisher = Get-Prop $u Publisher
            displayIcon = Get-Prop $u DisplayIcon; uninstallString = Get-Prop $u UninstallString; quietUninstallString = Get-Prop $u QuietUninstallString
            installLocation = Get-Prop $u InstallLocation; estimatedSizeKb = Get-Prop $u EstimatedSize; noModify = Get-Prop $u NoModify; noRepair = Get-Prop $u NoRepair
            comments = Get-Prop $u Comments; helpLink = Get-Prop $u HelpLink; urlInfoAbout = Get-Prop $u URLInfoAbout
        }
    }
    $i = Get-ItemProperty -Path "HKCU:\Software\$($script:InstallerGuid)" -ErrorAction SilentlyContinue
    if ($i) { $out.installKey = [ordered]@{ key = "HKCU\Software\$($script:InstallerGuid)"; installLocation = Get-Prop $i InstallLocation; keepShortcuts = Get-Prop $i KeepShortcuts; shortcutName = Get-Prop $i ShortcutName } }
    foreach ($root in @("HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall", "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall")) {
        Get-ChildItem $root -ErrorAction SilentlyContinue | ForEach-Object {
            $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
            if ($p -and ((Get-Prop $p DisplayName) -like "*CodeForge*")) { $out.perMachineUninstallKeys += $_.PSPath }
        }
    }
    return $out
}

function Get-CodeForgeShortcuts {
    $sh = New-Object -ComObject WScript.Shell
    $paths = @(
        (Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\CodeForge.lnk"),
        (Join-Path $env:USERPROFILE "Desktop\CodeForge.lnk"),
        (Join-Path $env:PUBLIC "Desktop\CodeForge.lnk"),
        (Join-Path $env:ProgramData "Microsoft\Windows\Start Menu\Programs\CodeForge.lnk")
    )
    $list = @()
    foreach ($p in $paths) {
        if (-not (Test-Path -LiteralPath $p)) { continue }
        $s = $sh.CreateShortcut($p)
        $list += [ordered]@{ path = $p; target = $s.TargetPath; workingDirectory = $s.WorkingDirectory; arguments = $s.Arguments; iconLocation = $s.IconLocation; targetExists = (Test-Path -LiteralPath $s.TargetPath) }
    }
    return $list
}

$script:SuspiciousInstalledPatterns = @(
    @{ id = "source-map"; pattern = '\.map$' },
    @{ id = "env-file"; pattern = '(^|\\)\.env(\.|$)' },
    @{ id = "pdb"; pattern = '\.pdb$' },
    @{ id = "test-artifact"; pattern = '(^|\\)(test|tests|__tests__|fixtures?)(\\|$)' },
    @{ id = "typescript-source"; pattern = '\.tsx?$' },
    @{ id = "backup"; pattern = '\.(bak|orig|tmp)$' },
    @{ id = "log"; pattern = '\.log$' },
    @{ id = "markdown-docs"; pattern = '\.md$' },
    @{ id = "sqlite"; pattern = '\.(db|sqlite)$' }
)

function Get-CodeForgeInstalledInventory {
    <# .SYNOPSIS Every file under the program directory plus asar hash and a suspicious-file classification. #>
    param([string]$InstallDirectory)
    if (-not $InstallDirectory) { $InstallDirectory = Get-CodeForgeInstallDirectory }
    if (-not $InstallDirectory) { return [ordered]@{ installed = $false } }
    $files = @(Get-ChildItem -LiteralPath $InstallDirectory -Recurse -File -Force)
    $total = ($files | Measure-Object -Property Length -Sum).Sum
    $suspicious = @()
    foreach ($f in $files) {
        $rel = $f.FullName.Substring($InstallDirectory.Length).TrimStart('\')
        foreach ($p in $script:SuspiciousInstalledPatterns) {
            if ($rel -match $p.pattern) { $suspicious += [ordered]@{ class = $p.id; path = $rel; sizeBytes = $f.Length } }
        }
    }
    $asar = Join-Path $InstallDirectory "resources\app.asar"
    $exe = Join-Path $InstallDirectory "CodeForge.exe"
    $largest = @($files | Sort-Object Length -Descending | Select-Object -First 12 | ForEach-Object { [ordered]@{ path = $_.FullName.Substring($InstallDirectory.Length).TrimStart('\'); sizeBytes = $_.Length } })
    return [ordered]@{
        installed = $true
        installDirectory = $InstallDirectory
        fileCount = $files.Count
        totalBytes = $total
        executable = if (Test-Path -LiteralPath $exe) { Get-CodeForgeFileIdentity $exe } else { $null }
        asarSha256 = if (Test-Path -LiteralPath $asar) { (Get-FileHash -Algorithm SHA256 -LiteralPath $asar).Hash } else { $null }
        asarBytes = if (Test-Path -LiteralPath $asar) { (Get-Item -LiteralPath $asar).Length } else { $null }
        unpackedDirectory = Test-Path -LiteralPath (Join-Path $InstallDirectory "resources\app.asar.unpacked")
        topLevel = @(Get-ChildItem -LiteralPath $InstallDirectory -Force | ForEach-Object { $_.Name })
        largestFiles = $largest
        suspiciousFiles = $suspicious
        files = @($files | ForEach-Object { [ordered]@{ path = $_.FullName.Substring($InstallDirectory.Length).TrimStart('\'); sizeBytes = $_.Length; lastWriteUtc = $_.LastWriteTimeUtc.ToString("o") } })
    }
}

function Get-CodeForgeReleaseArchiveMatch {
    <# .SYNOPSIS Compare the installed app.asar with the release's win-unpacked app.asar. #>
    param([string]$InstallDirectory, [string]$UnpackedDirectory)
    if (-not $InstallDirectory) { $InstallDirectory = Get-CodeForgeInstallDirectory }
    if (-not $UnpackedDirectory) { $UnpackedDirectory = Join-Path $script:RepositoryRoot "apps\desktop\release\win-unpacked" }
    $a = Join-Path $InstallDirectory "resources\app.asar"
    $b = Join-Path $UnpackedDirectory "resources\app.asar"
    if (-not (Test-Path -LiteralPath $a) -or -not (Test-Path -LiteralPath $b)) { return New-AuditResult "BLOCKED" "Installed or release app.asar is missing." }
    $ha = (Get-FileHash -Algorithm SHA256 -LiteralPath $a).Hash
    $hb = (Get-FileHash -Algorithm SHA256 -LiteralPath $b).Hash
    if ($ha -eq $hb) { return New-AuditResult "PASS" "Installed app.asar matches the release archive." @{ sha256 = $ha } }
    return New-AuditResult "FAIL" "Installed app.asar differs from the release archive." @{ installedSha256 = $ha; releaseSha256 = $hb }
}

# ----------------------------------------------------------------------------------------------
# User data (Electron userData, updater cache, repository indexes, temp)
# ----------------------------------------------------------------------------------------------
function Get-CodeForgeUserDataLocations {
    return [ordered]@{
        userData = Join-Path $env:APPDATA $script:PackageName
        updaterCache = Join-Path $env:LOCALAPPDATA "$($script:PackageName)-updater"
        localAppData = Join-Path $env:LOCALAPPDATA $script:ProductName
        legacyRoaming = Join-Path $env:APPDATA "@codeforge"
    }
}

function Get-DirectorySummary {
    param([Parameter(Mandatory)][string]$Path, [int]$MaxFiles = 400)
    if (-not (Test-Path -LiteralPath $Path)) { return [ordered]@{ path = $Path; exists = $false } }
    $files = @(Get-ChildItem -LiteralPath $Path -Recurse -File -Force -ErrorAction SilentlyContinue)
    $bytes = 0
    if ($files.Count -gt 0) { $bytes = ($files | Measure-Object -Property Length -Sum).Sum }
    return [ordered]@{
        path = $Path; exists = $true; fileCount = $files.Count; totalBytes = [int64]$bytes
        topLevel = @(Get-ChildItem -LiteralPath $Path -Force -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
        files = @($files | Select-Object -First $MaxFiles | ForEach-Object { [ordered]@{ path = $_.FullName.Substring($Path.Length).TrimStart('\'); sizeBytes = $_.Length } })
    }
}

function Get-CodeForgeUserDataInventory {
    param([string]$ProfileDirectory)
    $loc = Get-CodeForgeUserDataLocations
    $profileDir = if ($ProfileDirectory) { $ProfileDirectory } else { $loc.userData }
    $settingsPath = Join-Path $profileDir "settings.json"
    $settingsKeys = @(); $sealedCredentialKeys = @(); $plaintextSecretSuspects = @()
    if (Test-Path -LiteralPath $settingsPath) {
        try {
            $settings = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
            $settingsKeys = @($settings.PSObject.Properties.Name)
            foreach ($k in @("codeforge:cloud-access-token", "codeforge:cloud-refresh-token")) {
                if ($settingsKeys -contains $k) {
                    $v = [string]$settings.$k
                    if ($v.StartsWith("enc:")) { $sealedCredentialKeys += $k } else { $plaintextSecretSuspects += $k }
                }
            }
            if ($settingsKeys -contains "codeforge:provider-credentials") {
                foreach ($p in $settings."codeforge:provider-credentials".PSObject.Properties) {
                    if ([string]$p.Value -like "enc:*") { $sealedCredentialKeys += "provider:$($p.Name)" } else { $plaintextSecretSuspects += "provider:$($p.Name)" }
                }
            }
        } catch { $settingsKeys = @("<unparseable settings.json>") }
    }
    return [ordered]@{
        profile = Get-DirectorySummary $profileDir
        settingsKeys = $settingsKeys
        sealedCredentialKeys = $sealedCredentialKeys
        plaintextSecretSuspects = $plaintextSecretSuspects
        hasCloudSession = ($sealedCredentialKeys -contains "codeforge:cloud-access-token")
        updaterCache = Get-DirectorySummary $loc.updaterCache 50
        localAppData = Get-DirectorySummary $loc.localAppData 50
        legacyRoaming = Get-DirectorySummary $loc.legacyRoaming 50
    }
}

# ----------------------------------------------------------------------------------------------
# Install / upgrade / uninstall
# ----------------------------------------------------------------------------------------------
function Wait-ForNoProcess {
    param([Parameter(Mandatory)][string[]]$Names, [int]$TimeoutSeconds = 180)
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        $alive = Get-Process -Name $Names -ErrorAction SilentlyContinue
        if (-not $alive) { return $true }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

function Install-CodeForge {
    <#
    .SYNOPSIS Run the NSIS installer. -Silent uses the installer's /S mode (what an upgrade or a scripted deployment uses).
    .OUTPUTS Result object with exit code, elapsed time and the post-install state.
    #>
    param([Parameter(Mandatory)][string]$InstallerPath, [switch]$Silent, [string]$ExpectedSha256, [int]$TimeoutSeconds = 600)
    $identity = Get-CodeForgeFileIdentity $InstallerPath
    if ($ExpectedSha256 -and -not $identity.sha256.Equals($ExpectedSha256, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Installer SHA-256 $($identity.sha256) does not match expected $ExpectedSha256"
    }
    $argList = @()
    if ($Silent) { $argList += "/S" }
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $proc = if ($argList.Count -gt 0) { Start-Process -FilePath $InstallerPath -ArgumentList $argList -PassThru } else { Start-Process -FilePath $InstallerPath -PassThru }
    $finished = $proc.WaitForExit($TimeoutSeconds * 1000)
    $sw.Stop()
    if (-not $finished) { try { Stop-Process -Id $proc.Id -Force } catch {}; throw "Installer did not finish within $TimeoutSeconds s" }
    $installerName = [System.IO.Path]::GetFileNameWithoutExtension($InstallerPath)
    Wait-ForNoProcess -Names @($installerName, "Un_A", "Au_") -TimeoutSeconds 30 | Out-Null
    $dir = Get-CodeForgeInstallDirectory
    return [ordered]@{
        installer = $identity
        silent = [bool]$Silent
        exitCode = $proc.ExitCode
        elapsedMs = $sw.ElapsedMilliseconds
        installDirectory = $dir
        registry = Get-CodeForgeRegistryState
        shortcuts = Get-CodeForgeShortcuts
        executable = if ($dir) { Get-CodeForgeFileIdentity (Join-Path $dir "CodeForge.exe") } else { $null }
    }
}

function Uninstall-CodeForge {
    <#
    .SYNOPSIS Run the registered uninstaller (QuietUninstallString when -Silent) and wait for it to finish.
    .DESCRIPTION NSIS uninstallers copy themselves to %TEMP% and exit immediately; this waits for the
      helper process to disappear and for the program directory to be released before inventorying.
    #>
    param([switch]$Silent, [switch]$DeleteAppData, [int]$TimeoutSeconds = 300)
    $reg = Get-CodeForgeRegistryState
    if (-not $reg.uninstallKey) { throw "CodeForge is not registered in Apps & Features (no uninstall key)." }
    $cmd = if ($Silent) { $reg.uninstallKey.quietUninstallString } else { $reg.uninstallKey.uninstallString }
    if (-not $cmd) { throw "No uninstall command registered." }
    if ($cmd -match '^"([^"]+)"\s*(.*)$') { $exe = $Matches[1]; $rest = $Matches[2] } else { $parts = $cmd -split ' ', 2; $exe = $parts[0]; $rest = if ($parts.Count -gt 1) { $parts[1] } else { "" } }
    if ($DeleteAppData) { $rest = "$rest --delete-app-data".Trim() }
    $before = [ordered]@{ install = Get-CodeForgeInstalledInventory; registry = $reg; shortcuts = Get-CodeForgeShortcuts; userData = Get-CodeForgeUserDataInventory }
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $proc = if ($rest) { Start-Process -FilePath $exe -ArgumentList $rest -PassThru } else { Start-Process -FilePath $exe -PassThru }
    $proc.WaitForExit($TimeoutSeconds * 1000) | Out-Null
    # The real work happens in the temp copy (Un_A.exe / Au_.exe); wait for it to leave.
    Wait-ForNoProcess -Names @("Un_A", "Au_", "Uninstall CodeForge") -TimeoutSeconds $TimeoutSeconds | Out-Null
    $dir = $before.install.installDirectory
    $deadline = [DateTime]::UtcNow.AddSeconds(60)
    while ([DateTime]::UtcNow -lt $deadline -and (Test-Path -LiteralPath (Join-Path $dir "CodeForge.exe"))) { Start-Sleep -Milliseconds 500 }
    $sw.Stop()
    $leftoverFiles = @()
    if (Test-Path -LiteralPath $dir) { $leftoverFiles = @(Get-ChildItem -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName.Substring($dir.Length).TrimStart('\') }) }
    return [ordered]@{
        command = $cmd
        silent = [bool]$Silent
        deleteAppData = [bool]$DeleteAppData
        exitCode = $proc.ExitCode
        elapsedMs = $sw.ElapsedMilliseconds
        before = $before
        after = [ordered]@{
            programDirectoryExists = (Test-Path -LiteralPath $dir)
            programDirectoryLeftovers = $leftoverFiles
            registry = Get-CodeForgeRegistryState
            shortcuts = Get-CodeForgeShortcuts
            userData = Get-CodeForgeUserDataInventory
            runningProcesses = @(Get-Process -Name "CodeForge" -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
        }
    }
}

# ----------------------------------------------------------------------------------------------
# Process tree, console windows, launch and shutdown
# ----------------------------------------------------------------------------------------------
function Get-ProcessTree {
    <# .SYNOPSIS All descendants of a root PID with names, command lines and memory. #>
    param([Parameter(Mandatory)][int]$RootPid)
    $all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CommandLine, WorkingSetSize, CreationDate)
    $byParent = @{}
    foreach ($p in $all) { $pp = [int]$p.ParentProcessId; if (-not $byParent.ContainsKey($pp)) { $byParent[$pp] = @() }; $byParent[$pp] += $p }
    $result = @(); $queue = [System.Collections.Queue]::new(); $queue.Enqueue($RootPid); $seen = @{}
    while ($queue.Count -gt 0) {
        $pid0 = [int]$queue.Dequeue()
        if ($seen.ContainsKey($pid0)) { continue }; $seen[$pid0] = $true
        $self = $all | Where-Object { [int]$_.ProcessId -eq $pid0 } | Select-Object -First 1
        if ($self) {
            $cmd = [string]$self.CommandLine
            $cmd = $cmd -replace '--[a-z-]*(token|secret|key)=[^ ]+', '--$1=<redacted>'
            $result += [ordered]@{ pid = [int]$self.ProcessId; parentPid = [int]$self.ParentProcessId; name = $self.Name; workingSetBytes = [int64]$self.WorkingSetSize; commandLine = $cmd }
        }
        if ($byParent.ContainsKey($pid0)) { foreach ($c in $byParent[$pid0]) { $queue.Enqueue([int]$c.ProcessId) } }
    }
    return $result
}

# Every window class a stray console can materialise as: classic conhost, Windows Terminal (the
# Windows 11 default terminal host, so a console allocated by a background command opens a WT
# window, not a conhost one) and mintty (Git Bash's own terminal).
$script:ConsoleWindowClasses = @("ConsoleWindowClass", "CASCADIA_HOSTING_WINDOW_CLASS", "mintty")

function Get-VisibleConsoleWindows {
    <# .SYNOPSIS Visible top-level console windows (conhost, Windows Terminal, mintty) right now — the "flashing terminal" signal. #>
    return @([CodeForgeAudit.Native]::ListTopLevelWindows() | Where-Object { $_.Visible -and ($script:ConsoleWindowClasses -contains $_.ClassName) } | ForEach-Object { [ordered]@{ pid = $_.Pid; title = $_.Title; handle = $_.Handle; class = $_.ClassName } })
}

function Start-ConsoleWindowWatch {
    <#
    .SYNOPSIS Background sampler that records every visible console window that appears while the watch runs.
    .DESCRIPTION Samples EnumWindows every 40 ms in a background runspace. Any console window that was not
      present at start is recorded with its pid, title and first-seen timestamp — a console that flashes
      for even a few frames is caught because the sampler is faster than a typical create+close.
    #>
    param([int]$IntervalMs = 40)
    $baseline = @(Get-VisibleConsoleWindows | ForEach-Object { $_.handle })
    $stopFile = Join-Path $env:TEMP ("cf-console-watch-" + [guid]::NewGuid().ToString("N"))
    Set-Content -LiteralPath $stopFile -Value "run"
    $rs = [runspacefactory]::CreateRunspace(); $rs.Open()
    $rs.SessionStateProxy.SetVariable("baseline", $baseline)
    $rs.SessionStateProxy.SetVariable("intervalMs", $IntervalMs)
    $rs.SessionStateProxy.SetVariable("stopFile", $stopFile)
    $rs.SessionStateProxy.SetVariable("modulePath", (Join-Path $PSScriptRoot "CodeForgeProductAudit.psm1"))
    $ps = [powershell]::Create(); $ps.Runspace = $rs
    $ps.AddScript({
        Import-Module $modulePath -Force
        $seen = @{}; $events = @(); $samples = 0
        while ((Get-Content -LiteralPath $stopFile -Raw -ErrorAction SilentlyContinue) -notmatch "stop") {
            $samples++
            foreach ($w in Get-VisibleConsoleWindows) {
                if ($baseline -contains $w.handle) { continue }
                if (-not $seen.ContainsKey($w.handle)) { $seen[$w.handle] = $true; $events += [ordered]@{ firstSeenUtc = [DateTime]::UtcNow.ToString("o"); pid = $w.pid; title = $w.title; class = $w.class } }
            }
            Start-Sleep -Milliseconds $intervalMs
        }
        return [ordered]@{ samples = $samples; consoleWindowsSeen = $events }
    }) | Out-Null
    $handle = $ps.BeginInvoke()
    Start-Sleep -Milliseconds 200
    return [pscustomobject]@{ PowerShell = $ps; Runspace = $rs; Handle = $handle; StopFile = $stopFile }
}

function Stop-ConsoleWindowWatch {
    param([Parameter(Mandatory)]$Watch)
    Set-Content -LiteralPath $Watch.StopFile -Value "stop"
    $result = $Watch.PowerShell.EndInvoke($Watch.Handle)
    $Watch.PowerShell.Dispose(); $Watch.Runspace.Dispose()
    Remove-Item -LiteralPath $Watch.StopFile -Force -ErrorAction SilentlyContinue
    return $result[0]
}

function Wait-ForCdp {
    param([Parameter(Mandatory)][int]$Port, [int]$TimeoutSeconds = 45)
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        try { $v = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 3; if ($v.Browser) { return $v } } catch { Start-Sleep -Milliseconds 250 }
    }
    return $null
}

function Start-CodeForgeInstance {
    <#
    .SYNOPSIS Launch the installed (or any) CodeForge.exe with a profile directory and a DevTools port, and wait for the renderer.
    .PARAMETER ProfileDirectory  --user-data-dir. Omit to use the real per-user profile (%APPDATA%\codeforge-desktop).
    .PARAMETER Environment       Extra environment for the child (e.g. @{ CODEFORGE_SMOKE_OUT = "..." }).
    #>
    param(
        [string]$ExecutablePath,
        [string]$ProfileDirectory,
        [int]$RemoteDebugPort = 9229,
        [int]$LaunchTimeoutSeconds = 60,
        [hashtable]$Environment,
        [string]$LogDirectory,
        [string[]]$ExtraArguments
    )
    if (-not $ExecutablePath) { $dir = Get-CodeForgeInstallDirectory; if (-not $dir) { throw "CodeForge is not installed." }; $ExecutablePath = Join-Path $dir "CodeForge.exe" }
    if (-not $LogDirectory) { $LogDirectory = Join-Path $env:TEMP "codeforge-audit-logs" }
    New-Item -ItemType Directory -Path $LogDirectory -Force | Out-Null
    $stamp = [DateTime]::UtcNow.ToString("yyyyMMddTHHmmssfffZ")
    $stdout = Join-Path $LogDirectory "launch-$stamp.stdout.log"
    $stderr = Join-Path $LogDirectory "launch-$stamp.stderr.log"
    $argList = @()
    if ($ProfileDirectory) { New-Item -ItemType Directory -Path $ProfileDirectory -Force | Out-Null; $argList += "--user-data-dir=`"$ProfileDirectory`"" }
    if ($RemoteDebugPort -gt 0) { $argList += "--remote-debugging-port=$RemoteDebugPort" }
    if ($ExtraArguments) { $argList += $ExtraArguments }
    $saved = @{}
    # The host may be an Electron-as-Node process; strip inherited Electron mode so Chromium starts normally.
    # Removal must go through Remove-Item: passing $null to SetEnvironmentVariable from PowerShell binds an
    # EMPTY string, which creates the variable — and Electron treats a present-but-empty
    # ELECTRON_RUN_AS_NODE as "run as Node" (every Chromium switch then fails with "bad option").
    foreach ($name in @("ELECTRON_RUN_AS_NODE", "ELECTRON_NO_ATTACH_CONSOLE")) { $saved[$name] = [Environment]::GetEnvironmentVariable($name, "Process"); Remove-Item -Path "Env:\$name" -ErrorAction SilentlyContinue }
    if ($Environment) { foreach ($k in $Environment.Keys) { $saved[$k] = [Environment]::GetEnvironmentVariable($k, "Process"); Set-Item -Path "Env:\$k" -Value ([string]$Environment[$k]) } }
    $cdp = $null; $cdpReadyMs = $null
    try {
        $startedAt = [DateTime]::UtcNow
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        $proc = if ($argList.Count -gt 0) { Start-Process -FilePath $ExecutablePath -ArgumentList $argList -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr } else { Start-Process -FilePath $ExecutablePath -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr }
        if ($RemoteDebugPort -gt 0) { $cdp = Wait-ForCdp -Port $RemoteDebugPort -TimeoutSeconds $LaunchTimeoutSeconds }
        $cdpReadyMs = $sw.ElapsedMilliseconds
    } finally {
        foreach ($k in $saved.Keys) { if ($null -eq $saved[$k]) { Remove-Item -Path "Env:\$k" -ErrorAction SilentlyContinue } else { Set-Item -Path "Env:\$k" -Value $saved[$k] } }
    }
    return [pscustomobject]@{
        Process = $proc; Pid = $proc.Id; ExecutablePath = $ExecutablePath; ProfileDirectory = $ProfileDirectory
        RemoteDebugPort = $RemoteDebugPort; StartedAtUtc = $startedAt.ToString("o"); CdpReadyMs = $cdpReadyMs; Cdp = $cdp
        StdoutPath = $stdout; StderrPath = $stderr
    }
}

function Invoke-CodeForgeCdp {
    <# .SYNOPSIS Run a cdp-driver.mjs command against a running instance and return parsed JSON (or raw text). #>
    param([Parameter(Mandatory)][int]$Port, [Parameter(Mandatory)][string]$Command, [string[]]$Arguments, [int]$TimeoutSeconds = 120)
    $node = (Get-Command node -ErrorAction Stop).Source
    $saved = [Environment]::GetEnvironmentVariable("CDP_PORT", "Process")
    [Environment]::SetEnvironmentVariable("CDP_PORT", "$Port", "Process")
    try {
        $psi = [System.Diagnostics.ProcessStartInfo]::new()
        $psi.FileName = $node; $psi.UseShellExecute = $false; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.CreateNoWindow = $true
        $psi.ArgumentList.Add($script:CdpDriver); $psi.ArgumentList.Add($Command)
        foreach ($a in @($Arguments)) { if ($null -ne $a) { $psi.ArgumentList.Add([string]$a) } }
        $p = [System.Diagnostics.Process]::Start($psi)
        $out = $p.StandardOutput.ReadToEndAsync(); $err = $p.StandardError.ReadToEndAsync()
        if (-not $p.WaitForExit($TimeoutSeconds * 1000)) { try { $p.Kill() } catch {}; throw "cdp-driver $Command timed out" }
        $stdout = $out.Result.Trim(); $stderr = $err.Result.Trim()
        if ($p.ExitCode -ne 0) { throw "cdp-driver $Command failed ($($p.ExitCode)): $stderr $stdout" }
        try { return ($stdout | ConvertFrom-Json) } catch { return $stdout }
    } finally { [Environment]::SetEnvironmentVariable("CDP_PORT", $saved, "Process") }
}

function Get-CodeForgeWindows {
    param([Parameter(Mandatory)][int]$RootPid)
    $pids = @((Get-ProcessTree -RootPid $RootPid) | ForEach-Object { $_.pid })
    return @([CodeForgeAudit.Native]::ListTopLevelWindows() | Where-Object { $pids -contains [int]$_.Pid } | ForEach-Object { [ordered]@{ handle = $_.Handle; pid = $_.Pid; className = $_.ClassName; title = $_.Title; visible = $_.Visible; left = $_.Left; top = $_.Top; width = $_.Width; height = $_.Height } })
}

function Stop-CodeForgeInstance {
    <#
    .SYNOPSIS Close the app the way a user does (WM_CLOSE to the main window), wait for the whole tree to exit, then report leaks.
    .DESCRIPTION Records the process tree before the close, the time to exit, any survivors after the grace
      period, and whether force-kill was needed. Survivors are force-killed only after being recorded.
    #>
    param([Parameter(Mandatory)]$Instance, [int]$GraceSeconds = 15, [switch]$Force)
    $rootPid = $Instance.Pid
    $treeBefore = @(Get-ProcessTree -RootPid $rootPid)
    $windows = @(Get-CodeForgeWindows -RootPid $rootPid | Where-Object { $_.visible -and $_.className -like "Chrome_WidgetWin*" })
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $method = "none"
    if ($Force) {
        $method = "force"
        try { Stop-Process -Id $rootPid -Force -ErrorAction SilentlyContinue } catch {}
    } elseif ($windows.Count -gt 0) {
        $method = "WM_CLOSE"
        [CodeForgeAudit.Native]::PostMessage([IntPtr]$windows[0].handle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
    } else {
        $method = "CloseMainWindow"
        try { $Instance.Process.CloseMainWindow() | Out-Null } catch {}
    }
    $deadline = [DateTime]::UtcNow.AddSeconds($GraceSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        $alive = @($treeBefore | Where-Object { Get-Process -Id $_.pid -ErrorAction SilentlyContinue })
        if ($alive.Count -eq 0) { break }
        Start-Sleep -Milliseconds 200
    }
    $exitMs = $sw.ElapsedMilliseconds
    $survivors = @($treeBefore | Where-Object { Get-Process -Id $_.pid -ErrorAction SilentlyContinue })
    foreach ($s in $survivors) { try { Stop-Process -Id $s.pid -Force -ErrorAction SilentlyContinue } catch {} }
    $rootExit = $null; try { $rootExit = $Instance.Process.ExitCode } catch {}
    return [ordered]@{
        method = $method
        processTreeBefore = $treeBefore
        exitedWithinGraceMs = ($survivors.Count -eq 0)
        exitMs = $exitMs
        rootExitCode = $rootExit
        survivorsForceKilled = @($survivors | ForEach-Object { [ordered]@{ pid = $_.pid; name = $_.name; commandLine = $_.commandLine } })
    }
}

function Get-CodeForgeStrayProcesses {
    <# .SYNOPSIS Any CodeForge.exe (or children launched from the program directory) still alive system-wide. #>
    param([string]$InstallDirectory)
    if (-not $InstallDirectory) { $InstallDirectory = Get-CodeForgeInstallDirectory }
    $procs = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq "CodeForge.exe" -or ($InstallDirectory -and $_.ExecutablePath -and $_.ExecutablePath.StartsWith($InstallDirectory, [StringComparison]::OrdinalIgnoreCase)) }
    return @($procs | ForEach-Object { [ordered]@{ pid = [int]$_.ProcessId; name = $_.Name; parentPid = [int]$_.ParentProcessId; path = $_.ExecutablePath } })
}

function Get-ProcessResourceSample {
    <# .SYNOPSIS CPU% (over the sample window) and memory for every process in a tree. #>
    param([Parameter(Mandatory)][int]$RootPid, [int]$SampleSeconds = 10)
    $tree = @(Get-ProcessTree -RootPid $RootPid)
    $pids = @($tree | ForEach-Object { $_.pid })
    $start = @{}
    foreach ($p in $pids) { $pr = Get-Process -Id $p -ErrorAction SilentlyContinue; if ($pr) { $start[$p] = $pr.TotalProcessorTime } }
    $t0 = [DateTime]::UtcNow
    Start-Sleep -Seconds $SampleSeconds
    $elapsed = ([DateTime]::UtcNow - $t0).TotalSeconds
    $cores = [Environment]::ProcessorCount
    $rows = @(); $totalCpu = 0.0; $totalWs = [int64]0; $totalPrivate = [int64]0
    foreach ($p in $pids) {
        $pr = Get-Process -Id $p -ErrorAction SilentlyContinue
        if (-not $pr -or -not $start.ContainsKey($p)) { continue }
        $cpuSec = ($pr.TotalProcessorTime - $start[$p]).TotalSeconds
        $pct = [math]::Round(100.0 * $cpuSec / $elapsed / $cores, 2)
        $totalCpu += $pct; $totalWs += $pr.WorkingSet64; $totalPrivate += $pr.PrivateMemorySize64
        $entry = $tree | Where-Object { $_.pid -eq $p } | Select-Object -First 1
        $name = $entry.name; $cmd = [string]$entry.commandLine
        $kind = if ($cmd -match "--type=renderer") { "renderer" } elseif ($cmd -match "--type=gpu-process") { "gpu" } elseif ($cmd -match "--type=utility") { "utility" } elseif ($name -eq "CodeForge.exe") { "main" } else { $name }
        $rows += [ordered]@{ pid = $p; kind = $kind; cpuPercentOfMachine = $pct; workingSetBytes = $pr.WorkingSet64; privateBytes = $pr.PrivateMemorySize64; handles = $pr.HandleCount; threads = $pr.Threads.Count }
    }
    return [ordered]@{ sampleSeconds = [math]::Round($elapsed, 2); logicalCores = $cores; totalCpuPercentOfMachine = [math]::Round($totalCpu, 2); totalWorkingSetBytes = $totalWs; totalPrivateBytes = $totalPrivate; processes = $rows }
}

function Get-TempInventory {
    <# .SYNOPSIS Snapshot of %TEMP% entries (name, mtime) to diff before/after a run. #>
    $items = @(Get-ChildItem -LiteralPath $env:TEMP -Force -ErrorAction SilentlyContinue)
    return @($items | ForEach-Object { [ordered]@{ name = $_.Name; isDirectory = $_.PSIsContainer; lastWriteUtc = $_.LastWriteTimeUtc.ToString("o") } })
}

function Compare-NameSets {
    param([string[]]$Before = @(), [string[]]$After = @())
    return [ordered]@{ added = @($After | Where-Object { $Before -notcontains $_ }); removed = @($Before | Where-Object { $After -notcontains $_ }) }
}

Export-ModuleMember -Function *

# ----------------------------------------------------------------------------------------------
# Native window control (Electron's DevTools browser target does not expose window bounds)
# ----------------------------------------------------------------------------------------------
if (-not ("CodeForgeAudit.Win" -as [type])) {
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
namespace CodeForgeAudit {
  public static class Win {
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  }
}
"@
}

function Get-CodeForgeMainWindow {
    param([Parameter(Mandatory)][int]$RootPid)
    $w = @(Get-CodeForgeWindows -RootPid $RootPid | Where-Object { $_.className -like "Chrome_WidgetWin*" -and $_.title -eq "CodeForge" })
    if ($w.Count -eq 0) { return $null }
    $h = [IntPtr]$w[0].handle
    return [ordered]@{ handle = $w[0].handle; pid = $w[0].pid; visible = $w[0].visible; left = $w[0].left; top = $w[0].top; width = $w[0].width; height = $w[0].height; minimized = [CodeForgeAudit.Win]::IsIconic($h); maximized = [CodeForgeAudit.Win]::IsZoomed($h); foreground = ([CodeForgeAudit.Win]::GetForegroundWindow() -eq $h) }
}

function Set-CodeForgeWindowState {
    <# .SYNOPSIS Minimize/maximize/restore the main window, or move/resize it (physical pixels). #>
    param([Parameter(Mandatory)][int]$RootPid, [ValidateSet("minimized", "maximized", "normal")][string]$State, [int]$X = -1, [int]$Y = -1, [int]$Width = 0, [int]$Height = 0)
    $w = Get-CodeForgeMainWindow -RootPid $RootPid
    if (-not $w) { throw "No CodeForge main window" }
    $h = [IntPtr]$w.handle
    switch ($State) { "minimized" { [CodeForgeAudit.Win]::ShowWindow($h, 6) | Out-Null } "maximized" { [CodeForgeAudit.Win]::ShowWindow($h, 3) | Out-Null } "normal" { [CodeForgeAudit.Win]::ShowWindow($h, 9) | Out-Null } }
    if ($Width -gt 0 -and $Height -gt 0) {
        $flags = 0x0004 -bor 0x0040 # SWP_NOZORDER | SWP_SHOWWINDOW
        if ($X -lt 0 -or $Y -lt 0) { $flags = $flags -bor 0x0002 } # SWP_NOMOVE
        [CodeForgeAudit.Win]::SetWindowPos($h, [IntPtr]::Zero, $X, $Y, $Width, $Height, $flags) | Out-Null
    }
    Start-Sleep -Milliseconds 400
    return Get-CodeForgeMainWindow -RootPid $RootPid
}

Export-ModuleMember -Function *

# ----------------------------------------------------------------------------------------------
# Process-start watch: who launched what while an installer/uninstaller ran
# ----------------------------------------------------------------------------------------------
function Start-ProcessStartWatch {
    <# .SYNOPSIS Background sampler recording every new process whose name matches, with parent and command line. #>
    param([string[]]$NamePatterns = @("CodeForge.exe"), [int]$IntervalMs = 120)
    $stopFile = Join-Path $env:TEMP ("cf-procwatch-" + [guid]::NewGuid().ToString("N"))
    Set-Content -LiteralPath $stopFile -Value "run"
    $rs = [runspacefactory]::CreateRunspace(); $rs.Open()
    $rs.SessionStateProxy.SetVariable("patterns", $NamePatterns)
    $rs.SessionStateProxy.SetVariable("intervalMs", $IntervalMs)
    $rs.SessionStateProxy.SetVariable("stopFile", $stopFile)
    $ps = [powershell]::Create(); $ps.Runspace = $rs
    $ps.AddScript({
        $seen = @{}; $starts = @(); $samples = 0
        foreach ($p in Get-CimInstance Win32_Process) { $seen[[int]$p.ProcessId] = $true }
        while ((Get-Content -LiteralPath $stopFile -Raw -ErrorAction SilentlyContinue) -notmatch "stop") {
            $samples++
            foreach ($p in Get-CimInstance Win32_Process) {
                $id = [int]$p.ProcessId
                if ($seen.ContainsKey($id)) { continue }
                $seen[$id] = $true
                $name = [string]$p.Name
                if (-not ($patterns | Where-Object { $name -like $_ })) { continue }
                $parent = Get-CimInstance Win32_Process -Filter "ProcessId = $($p.ParentProcessId)" -ErrorAction SilentlyContinue
                $starts += [ordered]@{ at = [DateTime]::UtcNow.ToString("o"); pid = $id; name = $name; parentPid = [int]$p.ParentProcessId; parentName = $(if ($parent) { $parent.Name } else { $null }); commandLine = [string]$p.CommandLine }
            }
            Start-Sleep -Milliseconds $intervalMs
        }
        return [ordered]@{ samples = $samples; starts = $starts }
    }) | Out-Null
    $handle = $ps.BeginInvoke()
    Start-Sleep -Milliseconds 300
    return [pscustomobject]@{ PowerShell = $ps; Runspace = $rs; Handle = $handle; StopFile = $stopFile }
}

function Stop-ProcessStartWatch {
    param([Parameter(Mandatory)]$Watch)
    Set-Content -LiteralPath $Watch.StopFile -Value "stop"
    $result = $Watch.PowerShell.EndInvoke($Watch.Handle)
    $Watch.PowerShell.Dispose(); $Watch.Runspace.Dispose()
    Remove-Item -LiteralPath $Watch.StopFile -Force -ErrorAction SilentlyContinue
    return $result[0]
}

Export-ModuleMember -Function *
