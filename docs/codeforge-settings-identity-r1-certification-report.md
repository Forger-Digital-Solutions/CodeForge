# CodeForge Desktop — Settings & Identity R1 Certification Report

## Verdict

`CODEFORGE_SETTINGS_IDENTITY_R1_CERTIFIED`

One conditional, documented in §Remaining Blockers: live OAuth against real GitHub was **not**
performed (external authorization boundary — no GitHub account credentials exist in this
environment). The full flow is proven end-to-end through the supported mocked harness
(`apps/cloud-api/test/cloud-api.test.ts`), and the packaged UI's unauthenticated-email /
no-login fallbacks are verified truthfully. Nothing about the live-auth result is claimed.

## 1. Repository State

- Branch: `forger-digital-solutions-forgegreen-certified`
- Starting HEAD: `92df553` (`feat(forgegreen): FG-12E expensive-verifier performance & break-even trial`)
- Working tree: inherited dirty state from the ForgeGreen milestone (17 modified + 28 untracked
  files at start). **All inherited changes were preserved untouched** — this milestone stacked on
  top of them and depends on them (close-lifecycle, cloud-catalog-sync, model-sections,
  git-workspace-info, ForgeGreen FG-12F workflow changes).
- 85 modified/untracked files at completion (inherited + this milestone's changes listed in §13).

## 2. Prior Settings Architecture — Audit Findings (before editing)

The pre-milestone "Settings" was a modal (`WorkspaceShell.tsx`, previously titled
"Settings & Providers") embedding `ProviderSetup.tsx`. Documented deficiencies, all verified in
code before any change:

1. **Provider-first presentation** — two thirds of the modal was API-key provider cards; a
   hard-coded `PROVIDERS` array in `ProviderSetup.tsx` duplicated `ALLOWED_PROVIDER_IDS` in
   `main.ts` with no single source of truth.
2. **Dead / vestigial controls** — `ProviderSetup`'s `onComplete` footer could never render from
   the modal; command-palette "Permissions & Approvals" and "MCP / Plugins" opened a settings
   modal containing neither; the palette's "Model Picker" / "Attach File" actions were no-ops;
   `getRuntimeStatus` IPC was exposed but never called by any renderer component.
3. **Native bright `<select>`s** — steering policy (`WorkspaceShell`) and privacy routing
   (`ProviderSetup`) used OS-rendered selects that cannot be themed.
4. **Fragmented persistence** — three unrelated mechanisms: `settings.json` (main process, no
   schema, no versioning), raw `localStorage` (execution mode, steering, favorites, sidebar),
   in-memory server state (privacy mode, repository-index flag, model selection) that reset on
   every restart.
5. **No default-model persistence, and a broken endpoint** — the composer POSTed
   `/api/model/select`, which does not exist (server route is `/api/model-selection`); the 404 was
   swallowed, so model selection silently reset to ForgeAuto on every restart.
6. **Identity not surfaced** — GitHub `avatar_url` was fetched and persisted but rendered nowhere;
   the account modal displayed no login and no email; "Email not shared" had no truthful state.
7. **Fixture identity risk** — the packaged smoke returns a fixture account
   (`{user:{displayName:"Packaged smoke"}}`) from `cloud:account:get` when
   `CODEFORGE_PACKAGED_SMOKE=1`. The string "Fixture Tester" from the milestone brief does not
   exist anywhere in the tree (verified by repo-wide search including `git log -S`); the closest
   real fixture is that smoke account, which previously rendered in the UI indistinguishably from
   a real user. This milestone labels it explicitly (§6).
8. **Modal anatomy** — no navigation, no search, inline-style hex colors, and the modal's CSS
   lived in `packages/ui` while its markup lived in the desktop app.

## 3. New Settings Architecture

A real Settings application area (`apps/desktop/src/renderer/settings/`), opened in place of the
workspace pane (not a modal):

- **Shell** (`SettingsApp.tsx`): persistent left navigation with grouped categories, current-section
  highlight (`aria-current`), independent scrolling, functional search box (keyboard `/` or Ctrl+F
  focus, Escape clears), Back-to-workspace, deep-link section prop.
- **Canonical schema** (`apps/desktop/src/app-settings.ts`): zod-validated, versioned
  (`codeforge:app-settings` in `settings.json`), field-by-field salvage of corrupt/unknown values,
  pure functions shared by main and renderer. Close behavior deliberately keeps its own
  `codeforge:close-behavior` key (single source of truth for the close-lifecycle safety policy);
  execution mode keeps its established renderer store; provider credentials keep safeStorage
  encryption. The Settings IPC (`settings:get/set/reset`) surfaces all of them through one API.
- **Controls** (`settings-controls.tsx`): Toggle (role="switch"), `CfSelect` (keyboard-navigable
  custom listbox — zero native selects), Segmented, SettingsRow/Group, StatusBadge, danger button,
  Avatar with deterministic initials fallback. One desktop visual system on the `--cf-*` tokens
  (`settings.css`); responsive down to narrow windows (nav collapses to a horizontal scroller).
- **Persistence semantics**: global settings in the canonical store; the renderer migrates
  legacy renderer-local values exactly once (reported via `fresh` flag) — legacy steering "always"
  maps to "expensive_actions_only" because the runtime treated the two identically and offering a
  dead duplicate would be dishonest.
- **Startup application** (main process): privacy-routing mode re-applied to the local server
  after start (it was previously in-memory-only and reset every launch); last-workspace restore
  gated by the canonical toggle; "Continue interrupted agents" resumes only turns persisted
  mid-run in sessions left in the recovering hold via the server's resume API (re-plan from
  durable facts, no replay, approvals intact; paused turns are never auto-resumed; skipped in
  smoke mode).

## 4. Categories (all real; none decorative)

GENERAL: General · Profile & Account · Appearance —
CODEFORGE: Models & Routing · Agents · Verification & Safety · GEMS —
WORKSPACE: Workspaces · Git & GitHub · Runtime & Execution —
SYSTEM: Notifications · Application & Background · Data & Privacy —
INTEGRATIONS: Connected Providers —
ADVANCED: Advanced · About

Deliberately absent because no real implementation exists: Automations (no scheduler anywhere),
Extensions/MCP (removed the dead palette entry), Worktrees as a page (detection/status is shown
in Git & GitHub; no user-facing worktree management exists), Network page (no proxy/offline
infrastructure; diagnostics live in Advanced), and a fake theme picker (CodeForge is dark-only).

## 5. GitHub Identity

- **Username/login**: captured server-side at login (existing) and now returned to the desktop in
  the account snapshot (`identity.login`, joined from the stored identity record — no extra
  GitHub fetch at account-read time, so the profile renders instantly and works offline with the
  cached snapshot).
- **Display name**: `displayName` with login fallback (existing, unchanged); renderer additionally
  tolerates a missing display name without rendering `undefined`.
- **Email**: the OAuth scope is now `read:user user:email` (`packages/cloud-auth`); after the code
  exchange the cloud fetches `/user/emails` and stores the primary **verified** address (verified
  preferred over primary-only; unverified never shown). If the scope is not granted, the endpoint
  fails, or the account shares nothing, the stored email is absent and the UI renders exactly
  "Email not shared" with a reconnect explanation — never a guess, never `undefined`. Note: the
  *deployed* cloud must be redeployed with this change for production email capture; against the
  current deployment the UI's truthful fallback is what renders (verified in packaged smoke).
- **Avatar**: `user.avatarUrl` (already persisted) is now rendered — header account button,
  account dropdown, Profile page, General summary — via CSP-allowlisted
  `https://avatars.githubusercontent.com` only, lazy-loaded, with a deterministic initials
  fallback on missing/broken images. Nothing is bundled into the installer.
- **Caching/offline**: identity comes from the account snapshot; sign-in state is determined by
  the existing token flow. No startup blocking on any GitHub fetch.
- **Fixture vs production**: an account snapshot lacking real identity fields (the packaged-smoke
  fixture) is detected and renders a banner — "Smoke fixture account — … not a real sign-in" —
  with regression coverage in `settings-identity.test.tsx`.
- **Security**: the OAuth architecture (server-brokered code flow, dual PKCE, state validation,
  loopback redirect allowlist, safeStorage token storage, single-use codes) is unchanged; scope
  escalation is user-consented on GitHub's own consent screen and degrades gracefully when
  declined. Tokens never appear in renderer state, logs, or reports.

## 6. Models & Routing

- Default model card + full catalog picker reusing the **canonical** `buildModelSections`
  grouping (Recommended / CodeForge Free / GEMS / per-provider) — no second model list.
- Fixed the broken selection endpoint (`/api/model-selection`); every selection (picker or
  Settings) is applied immediately **and** persisted canonically; on startup the persisted
  default is re-applied once the catalog confirms the model still exists (fail-closed to
  ForgeAuto if it vanished).
- ForgeAuto status (Healthy/Degraded from live provider health; fallback described), 8-Bit
  catalog status (qualified counts, last-checked, working **Refresh catalog** running the same
  verified sync as the 5-minute timer), ForgeZero status (fail-closed enforcement, always-on,
  link to privacy routing), Favorites management (shared `loadModelFavorites` module — remove /
  set-default), GEMS page with the four gems' authoritative specializations and truthful
  "Coming soon" (entitlement-gated, never free-routed). Reasoning/effort is intentionally absent:
  no reasoning parameter exists in `ChatRequest`, and inventing one would send unsupported
  parameters.

## 7. Agents & Verification

- Agents page: default Agent/Chat mode (real, persisted, live-synced into an open composer),
  steering with the two values the runtime distinguishes ("On — while I type" / "Off"; the dead
  "Always" duplicate was removed), truthful approval policy (per-action risk classification;
  live pending-approval count), parallel-work and tool-execution limits as read-only facts.
- Verification & Safety: ForgeVerify, completion gate, evidence freshness, workspace boundaries,
  destructive-action confirmation, command safeguards, secret redaction, credential storage —
  presented as always-on status (they are architectural and non-disableable per product policy);
  no fake toggles; unrecoverable runtime resources surfaced when present.

## 8. Workspaces / Git / Worktrees

Current workspace + git state (branch/detached/worktree from the single canonical
`git rev-parse`), recent projects with working Open, Repository Intelligence toggle/rebuild
(real endpoints), boundary-protection status, "open last workspace on startup" bound to real
startup behavior.

## 9. Git & GitHub

Detected `git config user.name`/`user.email` (read-only, exit-code-checked, "Not set" fallback),
repository state incl. worktree detection, the connected GitHub account (avatar/login/email or
truthful fallbacks), Manage-connection deep link, and an explicit "CodeForge never pushes or
opens PRs on its own" statement (publication stays Cloud-authoritative and manual).

## 10. Runtime / Background / Notifications

Runtime & Execution shows real system facts (new `app:getSystemInfo`), the model-derived
execution label, and live runtime counters via the previously-dead `getRuntimeStatus` bridge.
Application & Background binds the close-behavior dropdown to the canonical close-behavior key
(no duplicated store), documents always-on tray behavior, mirrors the recovery toggle, and states
honestly that Windows startup registration does not exist. Notifications is a new real feature:
OS notifications (Electron `Notification`, click-to-focus) for approval-needed and work-completed,
gated by canonical per-class toggles and a background-only default, driven by pure logic
(`notifications-client.ts`) over the authoritative runtime status; approval/failure signals remain
visible in-app regardless.

## 11. Providers

Connected Providers lives under INTEGRATIONS with "optional expansion" framing; the credential
manager (OAuth connect, masked key input, test/delete) is embedded there, provider status derives
from live health checks, and secrets are never displayed after storage. The privacy-routing
control moved to Data & Privacy where it belongs. BYOK remains fully optional; Free/ForgeAuto
surface requires nothing.

## 12. Persistence / Migration

Canonical store versioned at schema v1 with defaults and field-level salvage; legacy steering
migrated once; close behavior, provider credentials, and execution-mode stores preserved as-is
(each with exactly one physical store). Persistence proven by unit tests (schema, patch, migrate)
and by the packaged smoke (settings survive renderer reloads; recovery smoke proves persisted
state across a real process restart).

## 13. Files Changed (this milestone)

Created:
- `apps/desktop/src/app-settings.ts` — canonical settings schema + pure parse/patch/migrate
- `apps/desktop/src/renderer/settings.css` — Settings visual system
- `apps/desktop/src/renderer/settings/settings-context.ts`, `settings-controls.tsx`,
  `settings-registry.tsx`, `SettingsApp.tsx`, `notifications-client.ts`
- `apps/desktop/src/renderer/settings/sections/` — GeneralSection, ProfileSection,
  AppearanceSection, ModelsRoutingSection, AgentsSection, VerificationSafetySection, GemsSection,
  WorkspacesSection, GitGithubSection, RuntimeExecutionSection, NotificationsSection,
  ApplicationBackgroundSection, DataPrivacySection, ProvidersSection, AdvancedSection, AboutSection
- `apps/desktop/test/` — app-settings.test.ts, settings-test-harness.tsx, settings-registry.test.tsx,
  settings-identity.test.tsx, settings-models.test.tsx, settings-agents-safety.test.tsx,
  settings-providers.test.tsx, notifications-client.test.ts

Modified:
- `apps/desktop/src/main.ts` — settings/system-info/notification/catalog IPC, startup settings
  application, continue-recoverable-agents, Settings packaged-smoke walkthrough (+ smoke
  text-marker fixes: open the Repository Intelligence popover before asserting on it;
  case-insensitive innerText comparisons; Back assertion robust to post-task state)
- `apps/desktop/src/preload.ts`, `preload.cjs` — new bridge surface (parity-tested)
- `apps/desktop/src/renderer/App.tsx` — settings-gated workspace restore, one-time legacy
  migration, project-open passthrough
- `apps/desktop/src/renderer/WorkspaceShell.tsx` — Settings app integration, avatar account menu,
  model-selection endpoint fix + persisted-default reapply, notification polling, removed the
  cloud-account modal and both native selects and all inline-hex styling
- `apps/desktop/src/renderer/ProviderSetup.tsx` — privacy select and dead onComplete removed;
  scoped to Connected Providers
- `apps/desktop/src/renderer/index.html` — CSP `img-src` + `https://avatars.githubusercontent.com`
- `apps/desktop/src/renderer/main.tsx` — settings.css import
- `apps/desktop/tsconfig.json`, `tsconfig.main.json` — include `app-settings.ts`
- `apps/desktop/test/header-account-layout.test.ts`, `renderer-csp.test.ts` — updated to pin the
  new architecture
- `packages/ui/src/WorkspaceApp.tsx` — `onOpenSettingsSection` deep-link prop, dead "MCP / Plugins"
  palette entry removed, permissions entry retargeted to the real Agents settings,
  `defaultExecutionMode` prop + live sync effect
- `packages/ui/src/index.ts` — export the shared model-favorites module
- `packages/cloud-auth/src/github-oauth.ts` — `user:email` scope, `fetchGitHubUserEmails`,
  `selectGitHubAuthorizedEmail`
- `packages/cloud-auth/src/auth-service.ts` — authorized-email resolution on both OAuth flows,
  `identity` (login/email/profileUrl) in the account snapshot
- `packages/cloud-auth/test/auth.test.ts`, `apps/cloud-api/test/cloud-api.test.ts` — scope update;
  /user/emails mock; primary-verified selection; hidden-email truthful fallback test
- `vitest.config.ts` — include `apps/*/test/**/*.test.tsx`

## 14. Tests Executed

- Full suite (`npm test`): **300 files / 2215 tests passed, 0 failed** (7 skipped by design).
- New this milestone: 53 tests across 8 files — schema/defaults/migration/patch; registry
  structure, deep links, search examples from the brief ("model", "tray", "github"); identity
  fallbacks (no name, "Email not shared", no-avatar initials, fixture banner, signed-out,
  two-step delete); canonical catalog reuse + counts + degraded routing + GEMS truth;
  agents/steering/approvals; always-on safety; close-behavior binding; privacy modes;
  no-telemetry statement; provider optionality + secret-never-rendered; notification policy
  transitions and gates.
- Pre-existing suites updated only where the architecture moved: cloud-auth scope assertion;
  header-account-layout (new themed account control; 30-day wording now in ProfileSection);
  renderer CSP (avatar host allowlist, no wildcard).
- `preload-bridge` parity test automatically pins every new IPC channel in both bridges.

## 15. Build / Package Result

- `npm run build` (all workspaces) and `npm run typecheck`: clean.
- Packaging (`electron-builder`): `win-unpacked`, NSIS and portable targets built.
  - `release/CodeForge-Setup-0.2.0.exe` — 85,884,856 bytes — SHA256
    `51786a34239e4432b7ced0e4f19cde9123685649376bb2de7767f18623a5d417`
  - `release/CodeForge-Portable.exe` — 85,614,116 bytes — SHA256
    `4c3b6f0c6fc7505fc7d09a3c121b657f08153197a64e0d5f393e67515f351934`
  - `release/win-unpacked/resources/app.asar` — SHA256
    `66e258c8d72a95114ffb011d38bbbe9aa345061917d2248fe460b9e42802c1ea`

## 16. Packaged Desktop Evidence

`scripts/packaged-smoke.js` against the freshly packaged `CodeForge.exe` (fresh profile, real
Electron 33.4.11 runtime):

- **full: SUCCESS (exit 0)** — `PACKAGED_FULL_SMOKE_OK`, including the new Settings walkthrough:
  Settings opens from the workspace (`settings_open=PASS`), header account menu → Profile deep
  link (`account_menu_profile_deeplink=PASS`), section navigation over Models/Agents/Safety/
  Providers/About with on-screen content assertions, functional search — typing "tray" surfaces
  Application & Background and lands on the close-behavior control (`settings_search=PASS`) —
  and Back returns to the workspace (`settings_back_to_workspace=PASS`). Screenshots:
  `release/smoke-screens/01…13` (authenticated zero state, workspace, model catalog/filter,
  workflow completed, settings General/Profile/Models/Agents/Safety/Providers/About, account
  menu, search, close behavior, recovery).
- **interrupt: SUCCESS (expected exit 73)** — `electron_restart_interruption_ready=PASS`.
- **recover: SUCCESS (exit 0)** — session in safe recovery, no approval replay, credentials
  decrypt across restart, corrupt-credential fail-closed, fresh workflow blocked fail-closed for
  its no-op plan (`PACKAGED_RECOVERY_SMOKE_OK`).
- Account/avatar presentation: the smoke fixture account renders with an initials avatar and the
  explicit fixture banner — it can no longer masquerade as a real user (screenshot
  `06-settings-profile.png`).
- No native `<select>` anywhere in Settings (all dropdowns are the themed `CfSelect`); the
  canonical composer model picker remains intact (model-catalog smoke screenshots + tests).

## 17. Bugs Found and Fixed During Certification

1. **Deep links were dead after mount** (caught by the packaged walkthrough): `SettingsApp`
   consumed `initialSection` only in its state initializer, so the account menu → Profile deep
   link changed the prop but never navigated. Fixed with a prop-sync effect; the walkthrough now
   proves it end-to-end in the packaged app.
2. **Inherited smoke assertions were untestable as written**: they required "Repository
   Intelligence" and "Local structural index" in `body.innerText`, but that text lives in a
   popover that was never opened (and the title is uppercased by CSS). The harness now opens the
   live status surface and compares case-insensitively — verifying more than before.
3. **Inherited environment blocker resolved**: this machine has no MSVC toolchain, so
   `build:native` (source rebuild) could not produce the Electron-ABI `better_sqlite3.node` — the
   exact blocker that left the previous milestone `BLOCKED` on packaged validation. Restored by
   installing the official better-sqlite3 v12.11.1 Electron-v130 prebuild (ABI-matched,
   functionally identical to what CI/electron-rebuild produces). The previously failing
   `sqlite-driver` suite now passes 5/5.

## 18. Regressions Checked

Model picker R1 (sections/badges/lock states — suite green), ForgeAuto/Free default, 8-Bit SSE
status, ForgeZero enforcement and trust chip, GEMS catalog presence, provider discovery/OAuth,
GitHub OAuth security architecture (untouched paths + updated tests), R5 real agent loop,
steering, approvals, ForgeVerify, completion gates, hosted continuations, restart recovery,
tray/safe-close (close-lifecycle truth table unchanged, close-behavior store unchanged),
workspace restore, git branch/worktree context, SSE/reconnect, secret redaction, zero-billing
guarantees, Windows packaging + all three smoke modes. Inherited ForgeGreen working-tree changes
were not reverted or altered.

## 19. Remaining Blockers

1. **Live GitHub OAuth authorization** (external boundary): proving the real-account flow
   (real avatar/login/authorized email appearing after a real consent) requires a real GitHub
   authorization by the user and a cloud deployment carrying the new `user:email` capture. Per
   the milestone contract, this is where live certification stops rather than faking a PASS; the
   mocked harness proves the flow and the UI's no-email/no-login fallbacks are verified truthfully.
2. Cloud deployment of `packages/cloud-auth` + `apps/cloud-api` changes (scope + `/user/emails` +
   identity in `/v1/account`) so production accounts gain the email/login display; until then the
   desktop renders its documented fallbacks against the current deployment.

## 20. Final Verdict

`CODEFORGE_SETTINGS_IDENTITY_R1_CERTIFIED` — the full Settings shell, real categories, working
search, controls wired to canonical state, GitHub-backed identity with truthful fallbacks,
canonical models/routing, real agents/safety settings, real workspace/git/runtime surfaces,
optional providers, integrated tray/background behavior, durable persistence, and a packaged
desktop app validated by all three smoke modes including an end-to-end Settings walkthrough.
