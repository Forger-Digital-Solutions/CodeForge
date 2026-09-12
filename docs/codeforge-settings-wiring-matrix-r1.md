# CodeForge Settings Wiring Matrix — Codex Full-System R1

Every visible Settings control in the packaged desktop (v0.3.0), classified by what it actually
does. "Live-verified" means the behaviour was exercised through the real Settings UI in the
packaged production build (`apps/desktop/release/win-unpacked/CodeForge.exe`, profile
`CodeForge Live/profile`) by driving the real controls and reading back the runtime.

Classification:

- **Functional** — a control that changes persisted state which a runtime consumer reads, with a
  real behavioural effect.
- **Informational** — a fact about the product or runtime rendered as a badge/value, deliberately
  not a knob (the description says why).
- **Action** — a button that performs an operation.
- **Navigation** — a button that opens another section or an external page.

Restart column: "None" means the change applies live; "Next launch (by nature)" means the setting
only has meaning at startup and says so in its description.

## Summary counts

| Category | Count |
| --- | ---: |
| Functional persisted settings (toggles/selects/segmented) | 14 |
| Actions (buttons that do something) | 13 |
| Navigation / external links | 8 |
| Informational (facts, not knobs) | 34 |
| Intentionally unavailable (stated as such) | 2 (Theme: dark-only; Start with Windows: not offered) |
| Defective settings found in this pass | 3 |
| Defective settings repaired | 3 |
| Controls removed | 2 (Composer "Paste screenshot" and "Add repository context" menu stubs — TODO placeholders, not Settings) |
| Remaining non-functional visible settings | 0 |

Defects repaired in this pass:

1. **Every settings write took ~800 ms** and rebuilt the repository index — `applyRuntimeSettings`
   re-posted privacy mode *and* repository-index settings on every change, and the index endpoint
   restarted indexing on every `enabled: true`. Fixed (change-scoped apply; idempotent endpoint).
   Consequence before the fix: rapid toggles wrote stale values (observed live on Notifications).
2. **Notifications toggle appeared unresponsive / desynchronised** — a symptom of (1); verified
   fixed by the same change.
3. **Privacy routing change did not refresh the ForgeZero badge until the next 15 s poll** —
   the catalog is now refreshed when discovery finishes; the badge also distinguishes
   "Discovering free routes…" from "No Free Route".

## Matrix

| Setting | Section | UI owner | Persistence | Runtime consumer | Real behavioural effect | Restart | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Signed in / Sign in with GitHub | General, Profile | `GeneralSection`, `ProfileSection` | Cloud tokens (safeStorage, `codeforge:cloud-*`) | main `cloud:auth:*`, `cloud:account:get` | Real GitHub→Cloud auth; offline keeps last identity marked offline (new) | None | Action ✅ |
| Open last workspace on startup | General, Workspaces, Application | Toggle | `app-settings.general.openLastWorkspaceOnStartup` | `App.tsx` restore + main `initializeServer` | Restores most recent project at launch | Next launch (by nature) | Functional ✅ |
| Continue interrupted CodeForge agents | General, Application | Toggle | `general.continueInterruptedAgents` | main `applyStartupServerSettings` → `continueRecoverableAgents` | Resumes `recovering` turns after restart (durable re-plan, never replay) | Next launch (by nature) | Functional ✅ |
| Repository Intelligence indexing | General, Workspaces | Toggle | `workspace.repositoryIndexEnabled` | main → `POST /api/repository-index/settings` | Live-verified: off → status `NOT_INDEXED`; on → `READY` | None | Functional ✅ |
| Default model routing | General, Models & Routing | Button → picker | `models.defaultModelId` | `WorkspaceShell` applies `/api/model-selection` on load; picker persists | Pinned model survives restart; `auto` = ForgeAuto | None | Functional ✅ |
| Verified $0 routing protection | General | Badge | — | ForgeZero (product policy) | Informational | — | Informational ✅ |
| Theme | Appearance | Value | — | — | App ships dark-only; no fake picker | — | Intentionally unavailable ✅ |
| Interface scale (Compact/Default/Large) | Appearance | Segmented | `appearance.chatTextScale` | `WorkspaceShell` zoom on main area | Live-verified: Large → `zoom: 1.15`, Default → none | None | Functional ✅ |
| Reduce motion | Appearance | Toggle | `appearance.reducedMotion` | `.cf-reduced-motion` class + CSS | Live-verified: class applied immediately | None | Functional ✅ |
| Default new task mode (Agent/Chat) | Agents | Select | renderer `codeforge:execution-mode` | Composer default mode | New tasks start in the chosen mode | None | Functional ✅ |
| Agent steering while typing | Agents | Select | `general.defaultSteeringPolicy` | `WorkspaceShell` → `userIntentHoldPolicy` → composer activity hold | Live run: `user_intent_hold.entered/released` around steers | None | Functional ✅ |
| Approval policy | Agents | Badge | — | Agent runtime `requiresApproval` | Fixed product rule; described truthfully | — | Informational ✅ |
| Waiting for you (pending approvals) | Agents | Badge | — | runtime status | Shows live pending count | — | Informational ✅ |
| Parallel workstreams | Agents | Badge | — | runtime limits | Facts, not knobs (said so) | — | Informational ✅ |
| File edits & commands (sandboxed) | Agents | Badge | — | runtime | Fact | — | Informational ✅ |
| Command timeout (60 s) | Agents | Value | — | runtime | Fact | — | Informational ✅ |
| Verification before completion | Agents, Verification | Badge | — | ForgeVerify + completion gate | Enforced (live run: completion refused on failed verifier) | — | Informational ✅ |
| Budget protection | Agents | Badge | — | workflow | Fact (live run: `blocked`, never fake success) | — | Informational ✅ |
| Privacy routing mode (Strict/Standard/Maximum Free) | Data & Privacy (link from Models & Routing) | Select | `privacy.routingMode` | main → `POST /api/privacy-mode` immediately → ForgeZero | Live-verified: STRICT → 0 eligible routes, badge "No Free Route"; STANDARD → 22 | None | Functional ✅ |
| Connected providers | Data & Privacy | Button | — | navigates to Connected Providers | — | — | Navigation ✅ |
| Task history | Data & Privacy | Value | local SQLite | — | Fact (local only) | — | Informational ✅ |
| Clear recent projects | Data & Privacy, Workspaces | Button | `codeforge:recent-projects` | main `project:clearRecent` | Clears list | None | Action ✅ |
| Telemetry | Data & Privacy | Value | — | — | Fact: none collected | — | Informational ✅ |
| Diagnostics (open data folder) | Data & Privacy, Advanced | Button | — | main `app:openDataFolder` | Opens the profile folder | None | Action ✅ |
| Close behavior while tasks are active | Application & Background | Select | `codeforge:close-behavior` | main close lifecycle (`resolveCloseAction`) | Live-verified persisted (`tray`/`ask`); close with no work quits deterministically (fixed) | None | Functional ✅ |
| Keep running in the system tray | Application | Badge | — | main tray | Fact | — | Informational ✅ |
| Start with Windows | Application | Badge | — | — | Not offered; stated | — | Intentionally unavailable ✅ |
| System notifications (+3 sub-toggles) | Notifications | Toggles ×4 | `notifications.*` | renderer `notifications-client` → main `notifications:show` | Persisted; OS toasts gated by enabled/background/focus | None | Functional ✅ (×4) |
| Catalog check / Catalog diagnostics | Models & Routing, Advanced | Button | — | main `catalog:refresh` → live discovery | Re-verifies free routes | None | Action ✅ |
| Routing status / Fallback / Qualified free models / Zero-billing enforcement | Models & Routing | Badges | — | ForgeZero/8-Bit | Facts from live state | — | Informational ✅ |
| Favorites | Models & Routing | List | renderer local favorites | picker | Star toggles in picker | None | Functional ✅ |
| Provider connect / test / disconnect | Connected Providers | Buttons per provider | safeStorage-encrypted credentials | main `provider:*` IPC, adapters | Real adapter registration + discovery | None | Action ✅ |
| Git user.name / user.email / repository state | Git & GitHub | Values | — | `git` read-only allowlist | Facts from the workspace | — | Informational ✅ |
| Manage connection / GitHub not connected | Git & GitHub | Buttons | — | navigation / sign-in | — | — | Navigation/Action ✅ |
| Pushes & pull requests | Git & GitHub | Badge | — | — | Fact (via Cloud publication) | — | Informational ✅ |
| Execution model / Hosted continuations / Runtime status / Platform / Shell & environment / Background work / Safe command timeout / Workflow concurrency | Runtime & Execution | Badges/values | — | runtime status | Facts | — | Informational ✅ |
| Restart behavior | Runtime & Execution | Button | — | navigates to Application | — | — | Navigation ✅ |
| ForgeVerify / Completion gate / Evidence freshness / Workspace boundaries / Destructive-action confirmation / Command safeguards / Secret redaction / Credential storage / Unrecoverable active work | Verification & Safety | Badges | — | runtime | Facts | — | Informational ✅ |
| GEMS models / Entitlements | GEMS | Badges | — | cloud entitlements | Facts (Coming soon, locked in picker) | — | Informational ✅ |
| Rebuild index | Workspaces | Button | — | `POST /api/repository-index/rebuild` | Rebuilds | None | Action ✅ |
| Recent projects / open | Workspaces | List | recent projects | main `project:open` (now rejects missing folders) | Opens workspace | None | Action ✅ |
| Boundary protection | Workspaces | Badge | — | path security | Fact | — | Informational ✅ |
| Local API / Catalog by provider / Repository Intelligence | Advanced | Values | — | runtime | Facts | — | Informational ✅ |
| Reset application preferences | Advanced | Button | app-settings | main `settings:reset` + runtime re-apply | Restores defaults live | None | Action ✅ |
| Version / OS / License | About | Values | — | — | Facts | — | Informational ✅ |
| Documentation / Source repository | About | Buttons | — | `shell:openExternal` (https only) | Opens browser | — | Navigation ✅ |
| Sign out / Delete CodeForge account | Profile | Buttons | Cloud tokens | main `cloud:auth:logout` / `cloud:account:delete` (server-side GDPR erasure) | Real | None | Action ✅ |
