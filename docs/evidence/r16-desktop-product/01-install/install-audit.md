# install-audit

Installer: `G:\CodeForge\apps\desktop\release\CodeForge-Setup-0.4.0.exe`

SHA-256: `6A810522755450826FB8927033AB3CB7FB97252BD0AC8869E10FB6B1456C4925`

| Check | Status | Detail |
|---|---|---|
| installerHash | PASS | Installer SHA-256 matches the expected release hash. |
| installerArchitecture | PASS | NSIS stub is x86; it installs the x64 payload. |
| installerSignature | WARN | Installer is not code-signed (status: NotSigned). Windows SmartScreen will warn on first run. |
| installerIdentity | PASS | Installer identifies as CodeForge 0.4.0. |
| installed | PASS | Installed at C:\Users\Daddy_FDS\AppData\Local\Programs\CodeForge (99 files, 395 MB). |
| installedArchitecture | PASS | Installed executable is x64. |
| installedVersionMatchesInstaller | PASS | Installed executable version 0.4.0.0 matches installer 0.4.0. |
| installedCompanyName | PASS | Executable CompanyName is 'CodeForge Team'. |
| installedSignature | WARN | Installed executable is not code-signed (NotSigned). |
| installedFileHygiene | PASS | No source maps, .env files, PDBs, test artifacts, logs or databases in the program directory. |
| asarUnpackedPresent | PASS | app.asar.unpacked (native modules) is present. |
| releaseArchiveMatch | PASS | Installed app.asar matches the release archive. |
| registryUninstall | PASS | Registered as 'CodeForge' with quiet uninstall '"C:\Users\Daddy_FDS\AppData\Local\Programs\CodeForge\Uninstall CodeForge.exe" /currentuser /S'. |
| registryVersion | PASS | Apps & Features version 0.4.0 matches the installed executable. |
| registryPublisher | PASS | Publisher is 'CodeForge Team'. |
| registryIcon | PASS | DisplayIcon points at an existing file. |
| registryUninstallCommand | PASS | Uninstall command targets an existing uninstaller. |
| registryPerMachine | PASS | No per-machine (HKLM) registration; install is per-user as intended. |
| startMenuShortcut | PASS | Start Menu shortcut → C:\Users\Daddy_FDS\AppData\Local\Programs\CodeForge\CodeForge.exe. |
| desktopShortcut | PASS | Desktop shortcut → C:\Users\Daddy_FDS\AppData\Local\Programs\CodeForge\CodeForge.exe. |
| shortcutHygiene | PASS | Shortcuts point at the installed executable with no stale arguments. |
| userDataSecrets | PASS | No plaintext credential values in settings.json (sealed keys: codeforge:cloud-access-token, codeforge:cloud-refresh-token. |
| updaterCache | INFO | Installer cache exists at C:\Users\Daddy_FDS\AppData\Local\codeforge-desktop-updater (112 MB). |

Verdict: **PASS** (0 FAIL, 2 WARN)
