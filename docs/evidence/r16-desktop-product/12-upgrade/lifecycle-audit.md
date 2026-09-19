# Install / upgrade / uninstall / reinstall lifecycle

New installer: `G:\CodeForge\apps\desktop\release\CodeForge-Setup-0.4.0.exe` — SHA-256 `E118C8E267C7FA730610F7B7DB772B1FFF2AC9788B8AE4CFDF459B013DB76D48`

Old installer: `G:\CodeForge\apps\desktop\release-pre-campaign-20260918\CodeForge-Setup-0.3.0.exe` — version 0.3.0

| Check | Status | Detail |
|---|---|---|
| upgradeRestoresSession | PASS | After installing the new release over the existing one, the real profile restored signed in (no sign-in screen); clean exit: PASS. |
| uninstallRemovesProgram | PASS | Program directory removed (exit 0, 4550 ms). |
| uninstallRemovesRegistry | PASS | Apps & Features registration and install key removed. |
| uninstallRemovesShortcuts | PASS | Start Menu and Desktop shortcuts removed. |
| uninstallKeepsUserData | PASS | User data (settings, sessions, sealed sign-in) is kept by a normal uninstall, as designed. |
| uninstallLeavesNoProcess | PASS | No CodeForge process remains. |
| oldInstall | PASS | Old release 0.3.0 installed silently; Apps & Features shows 0.3.0. |
| downgradeSafety | INFO | Older binary started and exited cleanly against a newer profile copy (schema tolerated). Text: CODEFORGE Build software with AI. A free-first engineering workspace with durable, verifiable execution. ΓùÅ Continue wi |
| upgradeInstall | PASS | New release installed over the existing installation in 12339 ms (exit 0). |
| upgradeRegistryVersion | PASS | Apps & Features now shows 0.4.0. |
| upgradePublisher | PASS | Publisher 'CodeForge Team'; display name 'CodeForge'. |
| upgradeExecutableVersion | PASS | Installed CodeForge.exe is 0.4.0 (CompanyName 'CodeForge Team'). |
| upgradeArchive | PASS | Installed app.asar matches the release archive. |
| upgradeNoStaleFiles | PASS | Installed tree matches the release tree exactly (98 files); nothing from the previous version survives. |
| upgradeShortcuts | PASS | Shortcuts point at the upgraded executable. |
| upgradeKeepsUserData | PASS | User data untouched by the upgrade. |
| upgradeRelaunch | PASS | Upgraded app starts on the retained (token-stripped) profile and exits cleanly. |
| uninstallNewClean | PASS | Uninstall of the new release removed program files, registration and shortcuts; user data kept. |
| reinstallRetainedProfile | PASS | Reinstall with retained data keeps the profile (recent projects, settings, task history) and starts cleanly (case A). |
| noLaunchDuringRemoval | PASS | No CodeForge process started during the full removal. |
| fullRemovalDeletesUserData | PASS | --delete-app-data removed the profile (settings, sessions, sealed sign-in tokens). |
| fullRemovalUpdaterCache | PASS | Installer cache removed. |
| reinstallCleanIsFirstRun | PASS | Clean reinstall behaves as a brand-new user: sign-in screen, no ghost account (case B). |
| noConsoleWindowsDuringLifecycle | PASS | No console window appeared during install, upgrade, launches or uninstall (2076 samples). |
| profileRestored | PASS | Real profile moved back untouched (held aside at C:\Users\Daddy_FDS\AppData\Roaming\codeforge-desktop.lifecycle-hold-20260919-134525 during the audit). |

Verdict: **PASS**
