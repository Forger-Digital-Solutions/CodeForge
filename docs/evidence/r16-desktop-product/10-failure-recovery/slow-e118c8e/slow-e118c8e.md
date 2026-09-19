# slow-e118c8e

Cloud traffic mode: **slow** (latency 2500 ms) via fault proxy on 127.0.0.1:53339

| Check | Status | Detail |
|---|---|---|
| startsWhileCloudDead | PASS | App started with Cloud traffic slow; DevTools at 1832 ms. |
| noEndlessSpinner | PASS | Bootstrap screen left within 3247 ms while the Cloud was slow. |
| keepsSignedInIdentityOffline | PASS | A previously signed-in user is not thrown to the sign-in screen by an unreachable Cloud. |
| offlineIsCommunicated | PASS | The UI names the Cloud outage: 'Cloud offline'. |
| responsiveWhileOffline | PASS | Idle CPU 0.05% while the Cloud is slow (no retry storm). |
| recoversWithoutRestart | PASS | After the network healed, the same process re-established the Cloud account (Forger Digital Solutions, CodeForge Free) — no restart. |
| catalogRecovers | PASS | Catalog refresh after recovery: 59 free models. |
| headerReflectsRecovery | PASS | The header dropped the 'Cloud offline' state on its own after the network healed. |
| cleanExitAfterFault | PASS | Process tree exited in 2129 ms after the fault run. |

Verdict: **PASS**
