$uninstall = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
Get-ChildItem $uninstall | ForEach-Object {
  $p = Get-ItemProperty $_.PSPath
  if ($p.DisplayName -like '*CodeForge*' -or $_.PSChildName -like '*codeforge*') {
    [PSCustomObject]@{
      Key = $_.PSChildName
      Name = $p.DisplayName
      Version = $p.DisplayVersion
      Publisher = $p.Publisher
      InstallLocation = $p.InstallLocation
      UninstallString = $p.UninstallString
      QuietUninstall = $p.QuietUninstallString
      InstallDate = $p.InstallDate
    }
  }
} | Format-List
Write-Output '---SHORTCUTS---'
$desktop = [Environment]::GetFolderPath('Desktop')
$startMenu = [Environment]::GetFolderPath('StartMenu') + '\Programs'
Get-ChildItem $desktop -Filter '*CodeForge*' -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName }
Get-ChildItem $startMenu -Recurse -Filter '*CodeForge*' -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName }
Write-Output '---INSTALL-DIR---'
$loc = "$env:LOCALAPPDATA\Programs\CodeForge"
if (Test-Path $loc) {
  $exe = Get-Item "$loc\CodeForge.exe"
  [PSCustomObject]@{
    Exe = $exe.FullName
    ExeBytes = $exe.Length
    ExeWritten = $exe.LastWriteTime
    Asar = (Get-Item "$loc\resources\app.asar").Length
  } | Format-List
}
