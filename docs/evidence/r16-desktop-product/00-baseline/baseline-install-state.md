# baseline-install-state

Installer: `G:\CodeForge\apps\desktop\release\CodeForge-Setup-0.4.0.exe`

SHA-256: `5181B8B5888B9B513F36C139390ABD83A2C95F3E61D7473DA1CC9B8369739B3D`

| Check | Status | Detail |
|---|---|---|
| installerHash | PASS | Installer SHA-256 matches the expected release hash. |
| installerArchitecture | PASS | NSIS stub is x86; it installs the x64 payload. |
| installerSignature | WARN | Installer is not code-signed (status: NotSigned). Windows SmartScreen will warn on first run. |
| installerIdentity | PASS | Installer identifies as CodeForge 0.4.0. |
| installed | PASS | Installed at C:\Users\Daddy_FDS\AppData\Local\Programs\codeforge-desktop (142 files, 449 MB). |
| installedArchitecture | PASS | Installed executable is x64. |
| installedVersionMatchesInstaller | PASS | Installed executable version 0.4.0.0 matches installer 0.4.0. |
| installedCompanyName | FAIL | Executable CompanyName is 'GitHub, Inc.' (Electron's default, not CodeForge's publisher). |
| installedSignature | WARN | Installed executable is not code-signed (NotSigned). |
| installedFileHygiene | WARN | 30 suspicious file(s) in the program directory. |
| asarUnpackedPresent | PASS | app.asar.unpacked (native modules) is present. |
| releaseArchiveMatch | PASS | Installed app.asar matches the release archive. |
| registryUninstall | PASS | Registered as 'CodeForge 0.3.0' with quiet uninstall '"C:\Users\Daddy_FDS\AppData\Local\Programs\codeforge-desktop\Uninstall CodeForge.exe" /currentuser /S'. |
| registryVersion | FAIL | Apps & Features shows version 0.3.0 but the installed executable is 0.4.0. |
| registryPublisher | FAIL | Publisher is blank in Apps & Features. |
| registryIcon | PASS | DisplayIcon points at an existing file. |
| registryUninstallCommand | PASS | Uninstall command targets an existing uninstaller. |
| registryPerMachine | PASS | No per-machine (HKLM) registration; install is per-user as intended. |
| startMenuShortcut | PASS | Start Menu shortcut → C:\Users\Daddy_FDS\AppData\Local\Programs\codeforge-desktop\CodeForge.exe. |
| desktopShortcut | PASS | Desktop shortcut → C:\Users\Daddy_FDS\AppData\Local\Programs\codeforge-desktop\CodeForge.exe. |
| shortcutHygiene | PASS | Shortcuts point at the installed executable with no stale arguments. |
| userDataSecrets | PASS | No plaintext credential values in settings.json (sealed keys: codeforge:cloud-access-token, codeforge:cloud-refresh-token, provider:opencode. |
| updaterCache | INFO | Installer cache exists at C:\Users\Daddy_FDS\AppData\Local\codeforge-desktop-updater (82 MB). |

Verdict: **FAIL** (3 FAIL, 3 WARN)
