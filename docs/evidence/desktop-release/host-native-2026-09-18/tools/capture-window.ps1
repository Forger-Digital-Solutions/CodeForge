# DPI-aware capture of the largest visible top-level window owned by a process, plus a JSON
# process-context record (ancestry, session, window rect, child process types).
# Usage: capture-window.ps1 -ProcessName CodeForge -OutPng <path.png> -OutJson <path.json>
param(
  [string]$ProcessName = "CodeForge",
  [Parameter(Mandatory = $true)][string]$OutPng,
  [Parameter(Mandatory = $true)][string]$OutJson
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class Win32Cap {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static System.Collections.Generic.List<IntPtr> TopLevel() {
    var list = new System.Collections.Generic.List<IntPtr>();
    EnumWindows((h, l) => { list.Add(h); return true; }, IntPtr.Zero);
    return list;
  }
}
'@
[Win32Cap]::SetProcessDPIAware() | Out-Null

$procs = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue
if (-not $procs) { throw "No process named $ProcessName" }
$pids = @($procs | ForEach-Object { [uint32]$_.Id })
$best = $null; $bestArea = 0; $bestTitle = ""; $bestPid = 0
foreach ($h in [Win32Cap]::TopLevel()) {
  if (-not [Win32Cap]::IsWindowVisible($h)) { continue }
  [uint32]$wpid = 0; [Win32Cap]::GetWindowThreadProcessId($h, [ref]$wpid) | Out-Null
  if ($pids -notcontains $wpid) { continue }
  $r = New-Object Win32Cap+RECT; [Win32Cap]::GetWindowRect($h, [ref]$r) | Out-Null
  $area = ($r.Right - $r.Left) * ($r.Bottom - $r.Top)
  if ($area -gt $bestArea) {
    $bestArea = $area; $best = $r; $bestPid = $wpid
    $len = [Win32Cap]::GetWindowTextLength($h); $sb = New-Object System.Text.StringBuilder ($len + 1)
    [Win32Cap]::GetWindowText($h, $sb, $sb.Capacity) | Out-Null; $bestTitle = $sb.ToString()
    $bestHandle = $h
  }
}
if (-not $best) { throw "No visible top-level window for $ProcessName" }
$w = $best.Right - $best.Left; $hgt = $best.Bottom - $best.Top
$bmp = New-Object System.Drawing.Bitmap $w, $hgt
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($best.Left, $best.Top, 0, 0, (New-Object System.Drawing.Size $w, $hgt))
$g.Dispose()
New-Item -ItemType Directory -Force (Split-Path $OutPng) | Out-Null
$bmp.Save($OutPng, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()

$children = @()
foreach ($p in $procs) {
  $c = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.Id)"
  $type = "browser(main)"
  if ($c.CommandLine -match "--type=(\S+)") { $type = $Matches[1] }
  if ($c.CommandLine -match "--utility-sub-type=(\S+)") { $type += ":" + $Matches[1] }
  $children += [ordered]@{ pid = $p.Id; type = $type; parentPid = $c.ParentProcessId; sessionId = $p.SessionId; workingSetMB = [math]::Round($p.WorkingSet64 / 1MB, 1); path = $p.Path }
}
$main = $procs | Where-Object { (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)").CommandLine -notmatch "--type=" } | Select-Object -First 1
$chain = @(); $cur = Get-CimInstance Win32_Process -Filter "ProcessId=$($main.Id)"
while ($cur) { $chain += "$($cur.Name)[$($cur.ProcessId)]"; if ($cur.ParentProcessId -eq 0) { break }; $cur = Get-CimInstance Win32_Process -Filter "ProcessId=$($cur.ParentProcessId)" -ErrorAction SilentlyContinue; if ($chain.Count -gt 12) { break } }
$fg = [Win32Cap]::GetForegroundWindow()
$rec = [ordered]@{
  capturedAt = (Get-Date).ToString("o")
  window = [ordered]@{ handle = ("0x{0:X}" -f $bestHandle.ToInt64()); title = $bestTitle; ownerPid = $bestPid; rect = [ordered]@{ left = $best.Left; top = $best.Top; width = $w; height = $hgt }; isForeground = ($fg -eq $bestHandle) }
  mainProcess = [ordered]@{ pid = $main.Id; sessionId = $main.SessionId; path = $main.Path; startTime = $main.StartTime.ToString("o"); ancestry = ($chain -join " <- ") }
  processes = $children
  png = $OutPng
}
$rec | ConvertTo-Json -Depth 6 | Set-Content $OutJson -Encoding UTF8
Write-Output "PNG=$OutPng ${w}x${hgt} title='$bestTitle' pid=$($main.Id) ancestry=$($chain -join ' <- ')"
