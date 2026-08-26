# Phase 10.6 Report — Persistence Correction (FINAL AUDITED VERSION)

> **Status: PHASE 10.6 PARTIALLY VERIFIED (Model-Selection Boundary COMPLETE)**
>
> This document replaces the earlier "Phase 10.6 Complete" claim after an
> independent evidence-driven audit. Every claim below carries actual evidence
> (source path, command, output). Areas that could not be proven are marked
> **PARTIAL**, **BLOCKED**, or **NOT YET VALIDATED** — not silently claimed done.

---

## 0. Audit Summary

| Area | Status | Evidence | Notes |
|---|---|---|---|
| node:sqlite persistence | DONE | `packages/sessions/src/sqlite.ts`, `persistence.ts`; 13 tests in `packages/sessions/test/persistence.test.ts` | Preferred backend on Node >= 22.5 |
| better-sqlite3 presence/absence | DONE | `npm ls better-sqlite3` → only `@codeforge/sessions` (optionalDependency) | Not a hard runtime dep anywhere |
| restart persistence | DONE | `persistence.test.ts` "survives restart…", `sqlite-driver.test.ts` fresh-instance reads | Real file DB, reopen, assert |
| project persistence | DONE | Same tests; server `persistSession()` writes through `SessionPersistence` | Durable SQLite file + WAL |
| session persistence | DONE | Same tests | Turns/work items/events persist |
| conversation persistence | DONE | Turns/work items/events asserted across restart | |
| file security | DONE | `security.test.ts` (27 tests): traversal + absolute + untouched-target assertions | |
| command security | DONE | cwd validated via shared containment helper before spawn (`agent-runtime.ts`) | |
| workspace-tree security | DONE | `handleWorkspaceTree` uses `resolveWithinWorkspace`; traversal/absolute rejected | |
| symlink/junction protection | DONE (was PARTIAL) | NEW `packages/server/src/path-security.ts` + real junction-escape tests | Old suite documented the hole with placeholder `expect(true)` tests — fixed this pass |
| ProviderModel tier | DONE | `providers/src/index.ts` (`tier?: "free" \| "gems_paid"`), mirrored in forge-zero types | Separate from `isFree`/`freeStatus` — not merged |
| entitlementStatus | DONE | `"included" \| "requires_subscription" \| "trial" \| "not_entitled"` in both type surfaces | User-scoped; separate from provider verification |
| EntitlementProvider | DONE | `packages/forge-zero/src/entitlement.ts` interface + dev implementation | Development scaffold |
| ForgeZero enforcement | DONE | `agent-runtime.ts executeTurn` calls `firewall.checkEntitlement()` for every `gems_paid` model BEFORE any inference | Production call path now exists (was missing) |
| entitlement fail-closed | DONE | `entitlement-enforcement.test.ts`: outage → `[PROVIDER_UNAVAILABLE]`; anonymous → denied; no provider → denied | |
| GEMS model selector | DONE | NEW `packages/ui/src/ModelSelector.tsx`, GET `/api/models`, integrated in desktop `WorkspaceShell.tsx` | Auto / Free / Topaz/Sapphire/Peridot/Garnet |
| Paid/lock UI | DONE | Locked rows render `Paid 🔒`, `aria-disabled="true"`, grayed style | 10 tests in `model-selector.test.tsx` |
| upgrade navigation | DONE | Centralized `getUpgradeUrl()` (`packages/ui/src/upgrade-url.ts`); locked click navigates, never executes inference | Stub URL, overridable via `CODEFORGE_UPGRADE_URL` |
| || HTTP model-selection boundary | DONE | POST `/api/model-selection` → `handleModelSelection` → `runtime.setModelSelection()` → entitlement enforcement | 7 tests in `model-selection-boundary.test.ts` |
|| account identity | DONE (scaffold) | `@codeforge/identity`: Account, UserId, AuthSession, AuthToken, PlanEntitlement | Development scaffold |
| GitHub OAuth scaffold | DONE (scaffold) | `authenticateWithGitHub()` seam; "not configured" in dev; `github_oauth` method + `githubId` on Account | Not production OAuth |
| email auth scaffold | DONE (scaffold) | `authenticateWithEmail()` + deterministic dev test accounts | Dev only |
| credential separation | DONE | Provider keys ONLY in `CredentialStore`/`EnvironmentCredentialStore`; identity types carry no API keys | Boundary documented in both packages |
| packaged Node compatibility | **NOT YET VALIDATED** | Probe of existing packaged exe: `electron_node=20.18.3`, `node_sqlite_FAILED No such built-in module` | Decisive finding — see §2 |
| persistence backend decision | DONE (decided & implemented) | Dual driver in `packages/sessions/src/sqlite.ts` | Fallback binary compiled by CI electron-rebuild — see §2 |
| full tests | DONE | **Test Files 16 passed (16), Tests 231 passed (231), Skipped 0** | Output in §11 |
| typecheck | DONE | `tsc -b --force` → exit 0 | |
| build | DONE | `npm run build` → exit 0 | Was BROKEN pre-audit (`@codeforge/identity` TS error) — see §10 |

**Honest remaining gaps (not hidden):**

1. **Packaged-app persistence round trip: NOT YET VALIDATED.** The fallback is
   implemented and tested under system Node, but no Electron-ABI binary of
   `better-sqlite3@13.0.3` exists yet (prebuild-install → HTTP 404 for
   electron-v130) and this sandbox has no MSVC toolchain.
   `.github/workflows/windows-desktop.yml` now builds it on a
   `windows-latest` runner and runs an in-binary smoke check
   (`scripts/verify-packaged-persistence.cjs`). Until that workflow runs green,
   the packaged persistence path is unproven. Phase 11 must not start before.
2. Identity, GitHub/email auth, and the upgrade URL are explicit development
   scaffolds. No billing/payment processing exists (by design).
---

## 1. End-User Guarantee (locked)

The shipped application must never require Python, MSVC, Visual Studio Build
Tools, node-gyp, Docker, or WSL from the end user. The build/CI pipeline may
use a full toolchain because it never touches the user's machine.

## 2. Persistence Architecture Decision (Audit 10 outcome)

**Finding:** the previously shipped Windows package (`apps/desktop/release`,
Electron `33.4.11`) bundles **Node 20.18.3**. Hard evidence:

```
$env:ELECTRON_RUN_AS_NODE='1'; CodeForge.exe scripts/electron-node-probe.cjs
electron_node=20.18.3
node_sqlite_FAILED No such built-in module: node:sqlite
```

(`scripts/electron-node-probe.cjs` retained as evidence tooling.)
`node:sqlite` requires Node >= 22.5, so **the old packaged app could not have
persisted anything**. The prior report's "Works in packaged builds ✅" claim
was false.

**Decision (per the locked architecture):** implement the approved fallback —

- `packages/sessions/src/sqlite.ts` selects a driver at open time:
  - prefer `node:sqlite` (zero native deps) wherever available;
  - otherwise require `better-sqlite3` (optionalDependency of
    `@codeforge/sessions` only);
  - explicit override for tests via option or `CODEFORGE_SQLITE_DRIVER`.
- Named-parameter normalization: node:sqlite binds `$name` keys, better-sqlite3
  bare names — handled inside the driver wrapper.
- The Electron-ABI binary is produced **only on CI**:
  `.github/workflows/windows-desktop.yml` runs
  `npm run rebuild:native --workspace @codeforge/desktop` (`@electron/rebuild`)
  on `windows-latest`, which ships with Python/MSVC preinstalled specifically
  so end users never need them. It then packages and runs an in-binary
  persistence smoke check (`scripts/verify-packaged-persistence.cjs`).

**Why node:sqlite was not silently kept:** keeping it would ship a desktop app
where every persistence write crashes. **Why the fallback is not a regression:**
compilation happens on the build machine only; `better-sqlite3` is an optional
dependency, so dev machines without a toolchain still work (they use
`node:sqlite`).

## 3. Symlink/Junction Protection (Audit 3 — closed)

Previously the code used lexical `path.resolve().startsWith()` checks and the
test suite *documented the vulnerability* with `expect(true).toBe(true)`
placeholders. An attacker could create `workspace/escape -> C:\outside` and
read/write/list through it.

**Fix:** `packages/server/src/path-security.ts`

- `realpathDeepestExisting()` — resolves links as far along the path as they exist;
- `resolveWithinWorkspace()` — double check (lexical, then realpath) against
  the workspace root's realpath; also closes the sibling-prefix hole
  (`\ws` vs `\ws-evil`). Used by `agent-runtime.validatePath`,
  `filesystem-service.resolvePath`, and `handleWorkspaceTree`.

**Real attack tests now exist** (junctions need no admin rights on Windows):

- `security.test.ts > Symlink/Junction Protection`: read/write/create through
  `escape -> outside` all rejected; outside file byte-for-byte untouched; an
  inward-pointing junction still allowed.
- `path-security.test.ts`: 11 unit cases incl. absolute-via-junction escape.

## 4. Entitlement Enforcement in the Production Path (Audits 4–5)

The interface existed but nothing called it during inference. Now:

```
startTurn → executeTurn → resolveTurnModel()
  ├─ manual selection (setModelSelection) wins; auto-routing can never pick
  │  gems_paid models (freeStatus:"paid" fails free eligibility)
  └─ if model.tier === "gems_paid":
        await firewall.checkEntitlement(userId, providerId, modelId)
        ├─ ok("included") / ok("trial") → proceed
        └─ err(...) → throw → turn failed BEFORE any provider call
```

Also hardened `ForgeZero.checkEntitlement` ordering: free-tier models never
require an entitlement provider; GEMS models without one fail closed.

Evidence — `packages/server/test/entitlement-enforcement.test.ts` (8 tests):
free+GEMS → `REQUIRES_SUBSCRIPTION` fail; paid+GEMS → completed; trial+GEMS →
completed; failing provider → `[PROVIDER_UNAVAILABLE]` fail-closed; anonymous
user → denied; auto-routing ignores registered GEMS models; free turns work
with no provider configured.

## 5. Model Selector UI (Audit 6) and Upgrade Flow (Audit 7)

Implemented this pass (previously backend-only):

- `packages/ui/src/ModelSelector.tsx` — Auto ("Best Free Model"), Free badge,
  GEMS entries; unentitled rows show **Paid 🔒**, `aria-disabled`, locked
  styling; clicking them calls ONLY the upgrade navigation callback and never
  `onSelect` (enforced by pure `resolveModelSelection()`, unit-tested).
- `GET /api/models` (`server/src/index.ts`) lists the free + GEMS catalog; the
  desktop shell renders it in the workspace header.
- `POST /api/model-selection` forwards UI selections to `AgentRuntime.setModelSelection()`
  with full server-side validation and entitlement enforcement (7 new tests).
- Upgrade target centralized in `getUpgradeUrl()` — default
  `https://codeforge.dev/pricing`, configurable via `CODEFORGE_UPGRADE_URL`;
  no component hardcodes a URL; no billing logic exists.
---

## 6. Identity & Credentials (Audits 8–9)

- `@codeforge/identity` represents Account / UserId / AuthSessionId /
  AuthSession / AuthToken / PlanEntitlement and explicitly supports
  `github_oauth` and `email_password` methods plus `githubId` on Account.
  **Development scaffold** — `DevelopmentAuthProvider` uses deterministic test
  accounts; GitHub auth returns "not configured". Not production OAuth.
- Separation: provider API keys exist only in `CredentialStore` /
  `EnvironmentCredentialStore` (`@codeforge/providers`). No identity type
  contains or resolves a provider credential; no credential doubles as
  account identity. Documented in both modules' comments.

## 7. Dependency Check (Audit 12)

- `better-sqlite3`: present ONLY as `optionalDependencies` of
  `@codeforge/sessions`. Stale copies removed from the install tree and
  lockfile (`packages/server/node_modules/better-sqlite3` gone).
- `node-gyp`: only a dev/CI-transitive entry in the lockfile; not a runtime
  dependency of any workspace.
- `sqlite3`: absent.
- The shipped runtime requires no native compilation tools on user machines:
  the fallback binary is CI-produced, and root `allowScripts` gates local
  install scripts.

## 8. WAL / Durability

Both drivers run `PRAGMA journal_mode = WAL`; the database is a real file
(`dbPath`) that survives process restart (proven by reopening in tests).
`SessionPersistence.deleteDatabase()` removes `-wal`/`-shm` sidecars.

## 9. Node Runtime Requirement

- CLI/server under system Node: **Node >= 22.5** enables `node:sqlite`
  (preferred); older or Electron-bundled Node uses the better-sqlite3 fallback.
- Packaged desktop: Electron's bundled Node (currently 20.x) → better-sqlite3
  driver, ABI-compiled by CI. Runtime pinned via `electron@33.4.11` in
  `apps/desktop/package.json`.

## 10. Build Fix Found by This Audit

`npm run build` was **failing** in `@codeforge/identity` before this audit
(despite the earlier report claiming success):
`types.ts(62): 'UserId' only refers to a type, but is being used as a value`.
Fixed (`userId: UserIdSchema` in `AuthSessionSchema`). Build now exits 0.

## 11. Final Validation (actual output)

Command: `npm test`

```
 ✓ packages/providers/test/providers.test.ts (16 tests)
 ✓ packages/forge-zero/test/forge-zero.test.ts (27 tests)
 ✓ packages/director/test/security.test.ts (11 tests)
 ✓ packages/director/test/tier-isolation.test.ts (25 tests)
 ✓ packages/sessions/test/transitions.test.ts (6 tests)
 ✓ packages/director/test/e2e-integration.test.ts (11 tests)
 ✓ packages/server/test/entitlement-enforcement.test.ts (8 tests)
 ✓ packages/protocol/test/schema.test.ts (17 tests)
 ✓ packages/server/test/model-selection-boundary.test.ts (7 tests)
 ✓ apps/desktop/test/application.test.ts (16 tests)
 ✓ packages/server/test/security.test.ts (27 tests)
 ✓ packages/sessions/test/event-store.test.ts (13 tests)
 ✓ packages/sessions/test/persistence.test.ts (13 tests)
 ✓ packages/server/test/path-security.test.ts (11 tests)
 ✓ packages/server/test/runtime.test.ts (17 tests)
 ✓ packages/ui/test/model-selector.test.tsx (10 tests)
 ✓ packages/sessions/test/sqlite-driver.test.ts (3 tests)

 Test Files  17 passed (17)
      Tests  238 passed (238)
```

Skipped: **0**.

- `npm run typecheck` → exit 0
- `npm run build` → exit 0 (all workspaces incl. desktop renderer + web)

## 12. Files Changed in This Audit Pass

| Action | File |
|--------|------|
| Rewritten | `packages/sessions/src/sqlite.ts` (dual-driver abstraction) |
| Modified | `packages/sessions/src/persistence.ts`, `index.ts`, `package.json` |
| Created | `packages/sessions/test/sqlite-driver.test.ts` |
| Created | `packages/server/src/path-security.ts` |
| Modified | `packages/server/src/agent-runtime.ts` (containment helper, userId, model selection, entitlement gate) |
| Modified | `packages/server/src/filesystem-service.ts`, `index.ts` |
| Modified | `packages/forge-zero/src/firewall.ts` (fail-closed ordering) |
| Created | `packages/server/test/path-security.test.ts`, `entitlement-enforcement.test.ts` |
| Modified | `packages/server/test/security.test.ts` (placeholder symlink tests → real junction attacks) |
| Created | `packages/ui/src/ModelSelector.tsx`, `src/upgrade-url.ts`, `test/model-selector.test.tsx` |
| Modified | `apps/desktop/src/renderer/WorkspaceShell.tsx` (+styles), `package.json` |
| Created | `.github/workflows/windows-desktop.yml`, `scripts/verify-packaged-persistence.cjs`, `scripts/electron-node-probe.cjs` |
| Fixed | `packages/identity/src/types.ts` (broken schema broke `npm run build`) |
| Updated | `AGENTS.md`, `vitest.config.ts`, root `package.json` |

---

## 13. Final Status: PHASE 10.6 PARTIALLY VERIFIED (Model-Selection Boundary COMPLETE)

Verified with real evidence: durable dual-driver persistence, restart survival,
file/command/tree/junction security, tier + entitlement architecture,
production entitlement enforcement (fail-closed), GEMS selector UI with paid/
lock states, HTTP model-selection boundary (full implementation + tests),
centralized upgrade navigation, identity/auth/credential separation scaffolds,
238 passing tests, clean typecheck and build.

Not yet verified: a persistence round trip inside a freshly packaged Electron
binary with the CI-compiled better-sqlite3 binding (**NOT YET VALIDATED** —
requires one green run of the `windows-desktop` workflow). Phase 11 packaging
may not begin until that workflow validates the fallback end-to-end.

## 14. Model-Selection Boundary Completion (This Session)

**Implementation Path Confirmed:**
```
ModelSelector (UI) 
  → POST /api/model-selection 
  → handleModelSelection (server)
  → firewall.getModel() validation
  → runtime.setModelSelection()
  → resolveTurnModel() uses selection
  → executeTurn() checks entitlements
```

**Security Requirements Met:**
- Client cannot bypass entitlement enforcement
- Server/runtime remains authoritative
- `gems_paid` models pass `firewall.checkEntitlement()` before execution
- Invalid model IDs fail closed at HTTP boundary (400 response)
- Unknown providers/models fail closed
- Locked paid models don't become executable
- No duplicated model-selection logic
- Reuses existing runtime and catalog abstractions

**Test Coverage Added:**
- Valid free model selection
- Valid paid model selection for entitled user
- Paid model selection for non-entitled user (fails closed)
- Invalid model ID (fails closed)
- Missing model selection (auto-routes)
- Malformed payload (fails closed)
- Auto selection clears previous manual selection

**Updated Test Results:**
- Test Files: 17/17 passed (was 16/16)
- Tests: 238/238 passed (was 231/231)
- Added: `packages/server/test/model-selection-boundary.test.ts` (7 tests)


