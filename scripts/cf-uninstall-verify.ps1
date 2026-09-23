$ErrorActionPreference = 'SilentlyContinue'
Write-Output '=== REGISTRY ==='
$found = $false
Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' | ForEach-Object {
  $p = Get-ItemProperty $_.PSPath
  if ($p.DisplayName -like '*CodeForge*' -or $_.PSChildName -like '*codeforge*') { $found = $true; $_.PSChildName }
}
if (-not $found) { Write-Output 'no CodeForge uninstall entry' }
Write-Output '=== SHORTCUTS ==='
"Desktop: $(Test-Path \"$env:USERPROFILE\Desktop\CodeForge.lnk\")"
"StartMenu: $(Test-Path \"$env:APPDATA\Microsoft\Windows\Start Menu\Programs\CodeForge.lnk\")"
Write-Output '=== DIRS BEFORE CLEANUP ==='
"Programs\CodeForge: $(Test-Path \"$env:LOCALAPPDATA\Programs\CodeForge\")"
"AppData\codeforge-desktop: $(Test-Path \"$env:APPDATA\codeforge-desktop\")"
"Local\codeforge-desktop-updater: $(Test-Path \"$env:LOCALAPPDATA\codeforge-desktop-updater\")"
"Local\CodeForge: $(Test-Path \"$env:LOCALAPPDATA\CodeForge\")"
Write-Output '=== REMOVING CODEFORGE-CREATED DATA (per installer.nsh macro paths) ==='
Remove-Item "$env:APPDATA\codeforge-desktop" -Recurse -Force
Remove-Item "$env:LOCALAPPDATA\codeforge-desktop-updater" -Recurse -Force
Remove-Item "$env:LOCALAPPDATA\CodeForge\repository-indexes" -Recurse -Force
Remove-Item "$env:LOCALAPPDATA\CodeForge" -Force  # non-recursive: only succeeds if empty (worktrees preserved)
Write-Output '=== DIRS AFTER ==='
"Programs\CodeForge: $(Test-Path \"$env:LOCALAPPDATA\Programs\CodeForge\")"
"AppData\codeforge-desktop: $(Test-Path \"$env:APPDATA\codeforge-desktop\")"
"Local\codeforge-desktop-updater: $(Test-Path \"$env:LOCALAPPDATA\codeforge-desktop-updater\")"
"Local\CodeForge: $(Test-Path \"$env:LOCALAPPDATA\CodeForge\")"
if (Test-Path "$env:LOCALAPPDATA\CodeForge") {
  Write-Output 'Remaining under Local\CodeForge (intentionally preserved):'
  Get-ChildItem "$env:LOCALAPPDATA\CodeForge" | ForEach-Object { "  $($_.Name)" }
}
