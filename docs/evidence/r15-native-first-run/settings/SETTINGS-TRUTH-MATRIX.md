# CodeForge Settings Truth Matrix — R15

`CODEFORGE_SETTINGS_REALITY_NOT_CERTIFIED`

This matrix is complete for the Settings registry as it exists in the current source tree. “Native
tested” is intentionally `PENDING` until the production-stamped installer is installed in a fresh
profile; source/unit evidence is not substituted for that gate.

| Setting / control family | UI exists | Backing implementation | Persistence | Runtime effect proven | Native tested | Action |
| --- | ---: | --- | --- | --- | --- | --- |
| GitHub account actions | YES | Cloud auth IPC + encrypted token store | YES | Unit/source traced; live OAuth start previously and currently service-ready | PENDING | RETEST NATIVE |
| Startup workspace | YES | Main-process server initialization | YES | Source + canonical settings tests | PENDING | KEEP |
| Interrupted-agent recovery | YES | Durable recovery coordinator | YES | Source + packaged smoke coverage | PENDING | KEEP |
| Repository indexing / rebuild | YES | Trusted control-plane index endpoints | YES | Server API tests; settings IPC now fail-closed | PENDING | KEEP |
| Dark theme | YES, read-only | Deliberately single-theme product | N/A | Source traced | PENDING | KEEP AS FACT |
| Interface scale / reduced motion | YES | Workspace shell | YES | Source + renderer tests | PENDING | KEEP |
| Default model / ForgeAuto | YES | Model-selection endpoint + settings IPC | YES | Source + model tests | PENDING | KEEP |
| Model favorites | YES | Shared model selector helper | YES, non-sensitive renderer preference | Shared UI source traced | PENDING | KEEP |
| Catalog refresh / route diagnostics | YES | Catalog refresh IPC / session state | N/A | Source + free-cloud tests | PENDING | KEEP |
| Privacy routing | YES | Trusted privacy endpoint | YES | Runtime apply must succeed before persistence | PENDING | KEEP |
| Default task mode | YES | Canonical app settings (R15 fix) | YES | App-settings regression test | PENDING | FIXED |
| Agent steering | YES | Workspace task hold policy | YES | Source + settings tests | PENDING | KEEP |
| Approval, verification, safety facts | YES, read-only | Permissions, ForgeVerify, completion gate | N/A | Security/workflow source and tests | PENDING | KEEP AS FACT |
| GEMS availability | YES, read-only | Catalog entitlement state | N/A | Explicit Coming soon quarantine | PENDING | KEEP AS UNAVAILABLE |
| Recent projects | YES | Trusted project IPC | YES | Source traced; clear now returns persistence failure | PENDING | KEEP |
| Notifications | YES | Renderer notification client + Electron Notification | YES | Source + settings tests | PENDING | KEEP |
| Close behavior / tray | YES | Close lifecycle and Electron Tray | YES | Source + lifecycle coverage | PENDING | KEEP |
| Windows autostart | YES, read-only | Explicitly not configured | N/A | Source traced | PENDING | KEEP AS FACT |
| Telemetry | YES, read-only | No analytics pipeline | N/A | Desktop/server search | PENDING | KEEP AS FACT |
| Diagnostic bundle | YES | Main-process redacted export | Local file | Dedicated diagnostics tests | PENDING | KEEP |
| Environment credential policy and enablement | YES | Trusted provider-connections service | YES | Registry/provider tests; write failures now propagate | PENDING | KEEP |
| Gemini acknowledgement / plan attestation | YES, conditional | Legal policy + provider reconciling | YES | Policy/provider source and test coverage | PENDING | KEEP |
| OAuth/BYOK/import/disconnect | YES | Provider IPC + safeStorage codec | YES, encrypted | Credential codec/provider tests | PENDING | KEEP |
| Provider search/show-all | YES | Renderer-only filtering | Session only | Source traced | PENDING | KEEP |
| Open data folder / reset | YES | Trusted app IPC | Reset is persistent | Reset preserves credentials/history by design | PENDING | KEEP |
| About/version/channel/manual updates | YES, read-only | Main-process system information | N/A | Source traced | PENDING | KEEP AS FACT |
| Browser, MCP, billing, paid-auto, local-model settings | NO | No product setting surface | N/A | Registry/source search | N/A | DO NOT ADD |

## R15 findings addressed

1. **Default new task mode was outside Reset Preferences.** It used renderer local storage, despite
   being displayed in Settings. It now belongs to validated `AppSettings.agents`, is migrated once
   from the legacy key, and resets to `agent` with the other application preferences.
2. **Runtime-backed settings could claim success on failure.** Privacy/indexing writes previously
   ignored control-plane errors after persisting the preference. The main process now requires a
   successful response before persisting and the renderer exposes a truthful alert on failure.
3. **Provider-policy persistence failures could be hidden.** The provider-connections host now
   propagates a failed trusted settings write for policy, attestation, connection metadata, and
   enabled-model state.

## Certification blocker

The only Settings certification blocker is missing installed-native evidence for this exact source
and fresh profile. The next required smoke must navigate every registered section, exercise the
representative mutations above, restart, and confirm their runtime/persistence effects without
using fixture authentication.
