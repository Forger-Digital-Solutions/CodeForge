# cloud-blackhole

Cloud traffic mode: **blackhole** (latency 2500 ms) via fault proxy on 127.0.0.1:54243

| Check | Status | Detail |
|---|---|---|
| startsWhileCloudDead | PASS | App started with Cloud traffic blackhole; DevTools at 676 ms. |
| noEndlessSpinner | PASS | Bootstrap screen left within 3439 ms while the Cloud was blackhole. |
| keepsSignedInIdentityOffline | PASS | A previously signed-in user is not thrown to the sign-in screen by an unreachable Cloud. |
| offlineIsCommunicated | PASS | The UI names the Cloud outage: 'Cloud offline'. |
| responsiveWhileOffline | PASS | Idle CPU 0.41% while the Cloud is blackhole (no retry storm). |
| recoversWithoutRestart | PASS | After the network healed, the same process re-established the Cloud account (Forger Digital Solutions, CodeForge Free) — no restart. |
| catalogRecovers | PASS | Catalog refresh after recovery: 65 free models. |
| headerReflectsRecovery | PASS | The header dropped the 'Cloud offline' state on its own after the network healed. |
| cleanExitAfterFault | PASS | Process tree exited in 2080 ms after the fault run. |

Verdict: **PASS**
