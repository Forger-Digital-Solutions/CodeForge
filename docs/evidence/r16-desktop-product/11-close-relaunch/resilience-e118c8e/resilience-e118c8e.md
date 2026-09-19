# resilience-e118c8e

| Check | Status | Detail |
|---|---|---|
| singleInstance | PASS | A second launch exited in 414 ms (code 0); exactly one CodeForge instance remains. |
| singleInstanceFocus | PASS | Existing window is visible and restored after the second launch (foreground=True). |
| closeProtectsActiveWork | PASS | Closing during a running task shows the safe-close dialog instead of quitting. |
| closeDialogCancel | PASS | Cancel dismisses the dialog and the task keeps running. |
| stopCancelsWork | PASS | Stop settled the run in 291 ms (turn states: cancelled,cancelled); no phantom completion (session cancelled). |
| stopNoPhantomCompletion | PASS | The stopped task is not presented as completed. |
| uiSettlesAfterStop | PASS | Composer is enabled after Stop; the next message can be sent. |
| rendererCrashRecovery | PASS | After the renderer process was killed, the interface came back on its own within 20 s; the main process and runtime stayed up. |
| rendererCrashKeepsConversation | PASS | The conversation (50 events) is intact after the interface reload. |
| forceKillRestart | PASS | App restarted after a force-kill mid-task (stale runtime.json present before relaunch: True). |
| forceKillNoPhantomCompletion | PASS | The interrupted task is not reported as completed after restart (session 'recovering', turns: recovering,recovering). |
| forceKillDatabaseUsable | PASS | Session database opened cleanly after the crash (34 events preserved). |
| forceKillNoStaleLock | PASS | No orphaned CodeForge processes from the killed instance. |
| noConsoleWindows | PASS | No console window appeared during tasks, Stop, crash or restart (583 samples). |

Verdict: **PASS**
