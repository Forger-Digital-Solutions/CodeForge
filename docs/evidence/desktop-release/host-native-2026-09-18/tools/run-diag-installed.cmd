@echo off
rem Host-native diagnostic launch of the INSTALLED CodeForge 0.4.0: started by Explorer's
rem ShellExecute (cmd.exe <- explorer.exe), no smoke mode, only main-process marker stamping and
rem Chromium logging enabled. Profile and cloud endpoint are whatever the app resolves itself.
set CODEFORGE_SMOKE_OUT=G:\CodeForge\docs\evidence\desktop-release\host-native-2026-09-18\07-diag-launch.markers.log
set ELECTRON_ENABLE_LOGGING=1
"%LOCALAPPDATA%\Programs\codeforge-desktop\CodeForge.exe" > "G:\CodeForge\docs\evidence\desktop-release\host-native-2026-09-18\07-diag-launch.stdout.log" 2>&1
echo EXIT=%ERRORLEVEL% > "G:\CodeForge\docs\evidence\desktop-release\host-native-2026-09-18\07-diag-launch.exit"
