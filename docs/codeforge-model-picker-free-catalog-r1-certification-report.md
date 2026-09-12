# CodeForge Model Picker R1 — Free-Model Product Architecture Certification Report

## Verdict

**`CODEFORGE_MODEL_PICKER_FREE_CATALOG_R1_BLOCKED`**

The architecture, root-cause fix, picker restructuring, and truthfulness fixes described below are implemented, unit-tested, and confirmed working end-to-end against the real, compiled renderer bundle and the real `CodeForgeServer` in a live browser session. Certification is withheld only because two specific proofs the milestone requires could not be produced in this sandboxed environment — not because the implementation is incomplete or unverified within what this environment allows. Both blockers are pre-existing environment limitations, unrelated to this milestone's code. See **Remaining Blockers** for the exact missing proof.

---

## 1. Starting Repository State

- Branch: `forger-digital-solutions-forgegreen-certified`, HEAD `92df553` (`feat(forgegreen): FG-12E expensive-verifier performance & break-even trial`).
- The branch carried substantial **unrelated, uncommitted** work from a prior ForgeGreen sustainability initiative (`packages/forge-green`, `packages/forgegreen-campaign`, `packages/workflow`, `packages/sessions`, `packages/server/src/{autonomous-orchestrator,forge-verify-persistence,workflow-service}.ts`, plus new FG-12F files). None of these files were read for editing purposes beyond confirming they were out of scope, none were touched, and no destructive git operations (`reset`, `checkout --`, `clean`, `stash` that wasn't popped) were run against them. `git status` was checked before and after this session's work; the ForgeGreen changes are present unmodified.
- No commits were created. All changes described below are in the working tree only, scoped to `apps/desktop/src/**`, `apps/desktop/test/**`, `packages/ui/src/**`, and `packages/ui/test/**`.

## 2. Architectural Findings (Audit)

Contrary to the milestone brief's framing, the backend routing/trust/discovery architecture was **already real and correctly designed** — the defect was almost entirely in wiring and UI, not in fabricated backend logic:

| Concept | Real implementation found | Verdict |
|---|---|---|
| **ForgeAuto/Free** | `packages/router/src/index.ts` `ForgeRouter.route()`/`scoreModel()` — live-scores every `ForgeZero.eligibleModels()` on capability match, empirical coding/agent/tool-reliability scores, and health. `"codeforge-auto"`/`"auto"` are routing **sentinels** intercepted server-side (`packages/cloud-gateway/src/gateway-service.ts:134`, `packages/server/src/model-execution-adapter.ts`), never a literal hardcoded model id. | Real, correctly architected. No change needed. |
| **8-Bit** | `packages/eight-bit/src/{eligibility,router,eviction,qualification,health}.ts` — fail-closed eligibility gate, sticky routing with promotion-margin anti-flap, staleness/paid-transition/orphan eviction, qualification-receipt benchmarking. Cleanly separate from `ForgeRouter`'s task-routing role. | Real, correctly separated from ForgeAuto per spec §1. No change needed. |
| **ForgeZero** | `packages/forge-zero/src/verifier.ts` `verifyModelEligibility()` — 7-gate pipeline (access class, deprecation, orphan/provider-active, $0 cost, 7‑day free-status freshness, no paid fallback, live provider health, privacy mode). Metadata-driven, never name-matched. | Real. **The desktop's header trust badge was NOT wired to it — see Finding 3 below.** |
| **Free-model discovery** | `packages/model-registry/src/{discovery,catalog-refresh}.ts` (`discoverAndVerifyFree`, `FreeModelCatalogRefresh`) and `packages/cloud-gateway/src/provider-registry.ts` (`CloudProviderRegistry`, hosted server-owned-key discovery) — both real, both already used by the existing test suite and by `apps/cloud-api`. | Real. **Never invoked by the desktop app for a signed-out user — this is Finding 1, the root cause.** |
| **GEMS** | `packages/gems` is a near-empty stub; `packages/cloud-gateway/src/gateway-service.ts:174-177` explicitly throws `"GEMS models are currently unavailable (offline)"`. Type-level scaffolding (`ModelTierSchema`, `checkEntitlement` fail-closed logic) exists and is complete; no real Topaz/Sapphire/Peridot/Garnet models exist anywhere. | Correctly pre-launch scaffolding, not a bug. UI now says **"Coming soon"** instead of the more alarming, inaccurate "Unavailable" (Finding 5). |

### Finding 1 — Root cause of the fresh-install bug

`apps/desktop/src/main.ts` (pre-fix) only called `registerCloudAdapter()` — the function that lists CodeForge's hosted, server-owned-key-backed free catalog (`HostedProviderAdapter` → `apps/cloud-api`'s `GET /v1/hosted/models`) and registers the results into `ForgeZero` — **when the user already had a stored cloud sign-in token**:

```ts
const cloudTokens = getStoredCloudTokens();
if (cloudTokens.accessToken) {
  await registerCloudAdapter();
}
```

But `GET /v1/hosted/models` (confirmed by reading `apps/cloud-api/src/server.ts:729`) requires **no authentication** — only `POST /v1/hosted/inference` (actually running a model) calls `authenticateRequest()`. So a genuinely fresh, signed-out install never populated its free catalog beyond the single bundled placeholder, `packages/forge-zero/src/catalog.ts`'s `GENERIC_FREE_MODEL` (`displayName: "CodeForge Free Model"`) — this is exactly the "one vague CodeForge Free Model" the milestone brief describes, and it is real, traceable code, not a hypothesis.

### Finding 2 — CodeForge Free / BYOK conflation (violates milestone §3)

The renderer's section-building logic (`apps/desktop/src/renderer/WorkspaceShell.tsx`, pre-fix) put **any** free model from **any** provider — including one only visible because the user had connected their own OpenRouter key — into a generic, hard-capped-at-5 "FREE" bucket, indistinguishable from CodeForge's own no-credential catalog. A model that requires the user's own credential must never appear in the credential-free "CodeForge Free" section per the milestone brief; this was a genuine architecture bug, not just a display issue.

### Finding 3 — ForgeZero header badge always said "Verified Free"

`WorkspaceShell.tsx`'s header rendered the literal string `"ForgeZero · Verified Free"` unconditionally, regardless of what was actually selected — even though the component already computed real per-model status (`getCurrentProviderStatus()`) for a *different* on-screen label. Selecting a GEMS or BYOK-paid model would still show the green "Verified Free" badge. This is precisely the failure mode milestone §16 warns against ("must not stay green merely because the UI is in 'free mode'").

### Finding 4 — Native `<select>` styling bug

`apps/desktop/src/renderer/WorkspaceShell.tsx`'s "Pause Agent while typing" `<select>` had no CSS class at all, so it rendered as an OS-default bright-white dropdown inside the dark UI. (The Settings modal's *other* `<select>` — Privacy routing, in `ProviderSetup.tsx` — was already styled via `.privacy-mode-control select`; only this one was missed.)

### Finding 5 — GEMS "Unavailable" and Settings/Account copy

GEMS has never had a working model, so "Unavailable" (implying a broken feature) was replaced with "Coming soon." Settings led with "Configure Providers" as a first-class heading before any mention that CodeForge Free/ForgeAuto need no configuration at all — matching the milestone's "Install → Settings → OpenRouter → OAuth" complaint. The account dialog showed a bare "0 Available Credits" with no indication that free/ForgeZero execution doesn't consume credits at all.

## 3. Root-Cause Fix

`apps/desktop/src/main.ts`:
- Split `registerCloudAdapter()` into `registerCloudAdapter()` (signed-in: registers the `HostedProviderAdapter` into `providerCatalog`, which is what flips `CodeForgeServer.realRuntimeEnabled()` from the safe scripted demo runtime to attempting real inference) and `registerCloudFreeCatalogOnly()` (signed-out: lists the same hosted catalog and registers the resulting `FreeModelRecord`s into `ForgeZero` for **display only**, without touching `providerCatalog`).
- A fresh, signed-out install now calls `registerCloudFreeCatalogOnly()` at boot (non-blocking, after window paint) and again every 5 minutes (mirrors `CloudProviderRegistry`'s own cloud-side refresh TTL), so the real catalog is visible without requiring sign-in.
- **Why not just always register the full adapter:** doing so would have flipped `realRuntimeEnabled()` to `true` for a signed-out user the moment any adapter was registered, causing the very first send to attempt real (but 401-doomed, since there is no access token yet) hosted inference instead of the existing safe scripted demo runtime. The split preserves that existing safety net exactly while fixing catalog visibility — this was verified by reading `CodeForgeServer.realRuntimeEnabled()` (`packages/server/src/index.ts:1879`: `this.useRealRuntime || this.providerCatalog.all().some((a) => a.isTestProvider !== true)`) and confirming `HostedProviderAdapter.isTestProvider === false`.
- The decision itself (`hasAccessToken ? "register-adapter-and-sync" : "sync-catalog-only"`) is pulled into a tiny pure function, `apps/desktop/src/cloud-catalog-sync.ts`, so it has direct unit-test coverage instead of relying solely on manual verification of Electron main-process code.

## 4. Picker Architecture Fix

New canonical, single-source-of-truth module: `apps/desktop/src/renderer/model-sections.ts` (previously this logic was duplicated inline inside `WorkspaceShell.tsx`'s render body).

- `buildModelSections()` produces exactly: **Recommended** (ForgeAuto, always present) → **CodeForge Free** (only `providerId === "codeforge" | "codeforge-cloud"`, i.e. models requiring no user credential; capped at `MAX_CODEFORGE_FREE_MODELS = 13` per milestone §6, not forced to exactly 13) → **GEMS** (locked, "Coming soon") → one section per connected BYOK provider (unchanged from before, already correctly credential-gated).
- The internal `"codeforge-auto"` hosted-routing sentinel is filtered out so it never appears as a confusing second row beside the pinned ForgeAuto entry.
- `accessBadge()` derives every badge from structured `accessClass`/`costProfile` metadata — never from string-matching a model's name (milestone §18; covered by a dedicated test that a model literally named `"Totally-Not-Free-1"` is not marked free).
- `resolveForgeZeroTrust(selectedModelId, selectedModel)` replaces the hardcoded badge string: ForgeAuto is trusted by construction (it only ever resolves into `ForgeZero`-eligible free models), a concrete model is trusted only if its own record shows `freeStatus === "verified_free" && costProfile.isFree === true`, and everything else — GEMS, BYOK, an unrecognized/stale selection — **fails closed** to a visibly different, non-green state.

`packages/ui/src/ModelSelector.tsx`: ForgeAuto now renders with a `⚡` glyph, bold name, a green left border (`.model-option.auto-route`), and an explicit **"Verified $0"** badge that is always present (previously the description text and the free badge were mutually exclusive, so ForgeAuto's "Automatic free routing" description silently suppressed any distinct badge).

## 5. Files Changed

```
apps/desktop/src/main.ts                      (root-cause fix + periodic refresh)
apps/desktop/src/cloud-catalog-sync.ts        (new — extracted, testable sync-mode policy)
apps/desktop/src/renderer/model-sections.ts   (new — canonical section-building + trust logic)
apps/desktop/src/renderer/WorkspaceShell.tsx  (consumes model-sections.ts; Settings/Account copy;
                                                reactive ForgeZero badge; select styling fix)
apps/desktop/src/renderer/ProviderSetup.tsx   (heading/subtitle: "Connected Providers (Optional)")
apps/desktop/src/renderer/styles.css          (.settings-select dark styling)
packages/ui/src/ModelSelector.tsx             (ForgeAuto badge/row distinction; "Coming soon")
packages/ui/src/workspace.css                 (.model-option-badge.auto, .auto-route, .forgezero-indicator.unverified)
apps/desktop/test/model-sections.test.ts      (new — 18 tests)
apps/desktop/test/cloud-catalog-sync.test.ts  (new — 2 tests)
packages/ui/test/model-selector.test.tsx      (+3 tests, 1 wording assertion updated)
```

## 6. Canonical Catalog Source

`GET /api/models` (`packages/server/src/index.ts` `handleModels()`) reading `ForgeZero.allModels()` — a single source, already fed by real discovery (`FreeModelCatalogRefresh`, `CloudProviderRegistry`/`HostedProviderAdapter`). The renderer derives all four picker sections from this one response via `buildModelSections()`; no second/duplicate catalog was introduced.

## 7. ForgeAuto / 8-Bit / ForgeZero Behavior (confirmed, not just asserted)

- **ForgeAuto** invokes real dynamic routing (`ForgeRouter.route()` over `ForgeZero.eligibleModels()`), confirmed by reading the routing code path; not modified by this milestone since it was already correct.
- **8-Bit** catalog/slot maintenance (`eviction.ts`, `qualification/runner.ts`) remains architecturally separate from task routing; not modified.
- **ForgeZero** cannot let a paid/unverified model enter a verified-free execution path: the 7-gate `verifyModelEligibility()` pipeline is unchanged; what changed is that the **desktop UI's trust badge now actually reflects that pipeline's per-model output** instead of a constant string.

## 8. Tests Executed

```
apps/desktop/test/          15 files, 118 tests — PASS
packages/ui/test/           16 files, 205 tests — PASS
packages/providers/test/    14 files, 121 tests — PASS
                             (444 total across the three suites, 0 failures)
```

New coverage added this milestone (22 tests): CodeForge-Free-vs-BYOK bucketing, 13-model cap, `codeforge-auto` sentinel hiding, GEMS bucketing regardless of provider id, Muse Spark hiding, section ordering, structured (non-name-matched) badge derivation, ForgeAuto unconditional trust, per-model verified-free trust, fail-closed GEMS/BYOK/stale-selection trust, stale-selection-does-not-crash safety, sync-mode policy (signed-in vs signed-out), and the ForgeAuto visual-distinction markup.

One pre-existing assertion (`"Unavailable"` → `"Coming soon"`) was updated to match the intentional, spec-directed wording change — not weakened, the assertion still checks the exact lock/disabled state.

`npx tsc --noEmit` (or `-b --force`) run clean on `packages/ui`, `apps/desktop/tsconfig.main.json`, and `apps/desktop/tsconfig.json` after every edit. Two pre-existing `TS2339` errors on `WorkspaceShell.tsx`'s `execCommand` typing were confirmed (via `git stash`/`tsc`/`git stash pop`) to predate this session and are unrelated to these changes; not touched, per instructions not to "fix" unrelated things while doing this milestone.

## 9. Live UI Verification (real bundle, real server — not `qa.html`)

Per project convention (masking real bugs with `qa.html` is a known anti-pattern here), verification used the **actual production build** and the **actual `CodeForgeServer`**, not a mock page:

1. `npm run build` (real `tsc` + `vite build`) produced the real `apps/desktop/dist/renderer` bundle with no changes to source beyond what's listed above.
2. A disposable Node script instantiated the real `CodeForgeServer`/`ForgeZero` (same classes `main.ts` uses) on `:3210`, seeding `ForgeZero` with a `codeforge-cloud`-shaped fixture (5 models) matching exactly the schema `HostedProviderAdapter.listModels()`/`registerCloudFreeCatalogOnly()` produce, standing in for the real `apps/cloud-api` deployment this sandbox cannot reach over the network.
3. The real `dist/renderer/index.html` assets were served over a plain static HTTP server and driven in the Browser tool, with a temporary verification-only `window.electronAPI` stub (all Electron-only calls; no model/catalog logic touched) so `WorkspaceShell` could mount without a real Electron preload bridge.
4. All scratch scripts/servers/HTML were deleted and both temporary listener processes killed before finishing; nothing was committed.

**Confirmed by direct observation, signed out, zero BYOK configured:**
- Picker shows exactly: `RECOMMENDED → ⚡ ForgeAuto/Free (bold, green border, "Verified $0" badge) → CODEFORGE FREE → 6 real named models ("Nemotron 70B Instruct · Included Free (Cloud)", "Qwen 2.5 Coder 32B...", "DeepSeek R1...", "Mistral Small 3.1 24B...", "Llama 3.3 70B Instruct...", "CodeForge Free Model") → GEMS (Topaz/Sapphire/Peridot/Garnet, each "Paid · Coming soon", locked)`. No `codeforge-auto` duplicate row. No BYOK section (correctly absent — no provider connected).
- Header shows `+ Start Free Cloud` (correct signed-out state) and `ForgeZero · Verified Free` (correct — ForgeAuto is selected by default and is trusted by construction).
- Typing `nemotron` filtered the list to exactly one matching row; selecting it updated the composer's model chip to "Nemotron 70B Instruct · Included Free (Cloud)" and **persisted across picker close/reopen**; the header trust badge stayed "Verified Free" (correct — this concrete model has `freeStatus: "verified_free"` and `costProfile.isFree: true`).
- Keyboard Down/Up moved focus through the flat option list.
- Settings modal now leads with **"Models & Routing"** (live "Default model: Nemotron 70B Instruct…", live "CodeForge Free catalog: 6 models available — no provider configuration required"), the "Pause Agent while typing" `<select>` renders with the dark theme (bug fixed, screenshot-confirmed), and the provider section is headed **"Connected Providers (Optional)"** with copy stating CodeForge Free/ForgeAuto need no setup.
- The signed-out account dialog reads: *"ForgeAuto/Free and the CodeForge Free catalog are visible in the model picker without signing in. Sign in to actually run them on CodeForge's hosted infrastructure."* — this was deliberately verified for accuracy, not just presence: see §10.

**Not re-verified live in this pass** (unchanged by this milestone, or simple JSX with no logic risk, confirmed by code reading + typecheck only): the signed-in "0 Available Credits" panel's new free-vs-paid-credits clarification line, and GEMS's locked-click → upgrade-navigation path (both pre-existing, unmodified control flow around my copy/wording edits).

## 10. An Important Accuracy Correction Made *During* This Milestone

Initial account-dialog copy drafted for this milestone read "ForgeAuto/Free and the CodeForge Free catalog already work without signing in." While auditing `apps/cloud-api/src/server.ts`, this was found to be an overclaim: `POST /v1/hosted/inference` (§729 lists models unauthenticated; §970 running a model calls `authenticateRequest()`) requires a valid cloud session, and `packages/server/src/index.ts`'s `useRealRuntime`/demo-runtime fallback confirms that **without BYOK or cloud sign-in, CodeForge currently runs a scripted demo turn, not real inference** — a pre-existing, intentional boundary (abuse/identity control on CodeForge's own server-owned provider keys), not something this milestone's scope covers or should quietly work around. The copy was corrected to distinguish "visible in the picker" (true, and now fixed) from "runs for real" (still requires BYOK or sign-in, unchanged). This is flagged explicitly because shipping the original, overclaiming copy would have been exactly the kind of "manufactured passing verdict" the milestone instructions warn against.

## 11. Build / Package Result

- `npm run build` (tsc + vite): **PASS**, no errors, renderer bundle produced.
- `npm run build:native` (electron-rebuild of `better-sqlite3` for Electron's ABI): **FAILS** — `node-gyp` cannot locate a supported Visual Studio install (`Visual Studio\18\Community` is unrecognized: `"unknown version 18"`, `"could not find a version of Visual Studio 2017 or newer to use"`). This exactly matches this project's own existing operational memory that VS2026 breaks the node-gyp native rebuild and CI must stay pinned to `windows-2022` — **a pre-existing environment limitation, not caused by this milestone's changes** (confirmed: none of this milestone's edits touch native code or `better-sqlite3`).
- `npx electron-builder --dir` (packaging without a native rebuild, using whatever binary is already present): produced `apps/desktop/release/win-unpacked/CodeForge.exe`.

## 12. Packaged Runtime Result

Ran the existing `apps/desktop/scripts/packaged-smoke.js full` harness against the freshly packaged `CodeForge.exe`:

- `MAIN_TS_LOADED` → `WHEN_READY_*` → `CREATE_WINDOW_START` → `LOAD_FILE …\dist\renderer\index.html` → `WINDOW_CONTENT_LOADED` → `WHEN_READY_WINDOW_CREATED` — **the packaged Electron app launches and paints the real renderer bundle containing this milestone's changes.**
- It then crashes during `initializeServer()`: `Failed to initialize SQLite persistence with node:sqlite (No such built-in module) and better-sqlite3 (Could not locate the bindings file... tried .../node-v130-win32-x64/better_sqlite3.node)`. `node -e "require('better-sqlite3')"` **succeeds** under plain Node on this machine — confirming the installed binary is compiled for plain Node's ABI, not Electron 33's (`v130`), i.e. exactly the artifact `build:native` was supposed to produce and could not, due to the Visual Studio issue above. This is a local persistence-layer (`packages/sessions`) native-module problem, unrelated to the model picker/catalog code this milestone changed.

## 13. Regressions Checked

- Full `apps/desktop`, `packages/ui`, `packages/providers` suites: 444/444 passing (§8).
- `git diff --stat` confirms the change is scoped to the 11 files listed in §5 — no edits to `packages/forge-zero`, `packages/eight-bit`, `packages/model-registry`, `packages/router`, `packages/cloud-gateway`, `packages/server`, `apps/cloud-api`, or any GitHub-auth/session/ForgeVerify code.
- The pre-existing, unrelated ForgeGreen working-tree changes (§1) are untouched (`git status` diffed before/after).
- The `apps/desktop`/`packages/ui` pre-existing test suites (secret redaction, GitHub auth endpoint shape, single-instance guard, onboarding, CSP, header layout, execution-mode desktop e2e, EightBit status, GEMS entitlement/lock behavior, favorites) all still pass unmodified except the one intentional wording assertion in §8.

## 14. Remaining Blockers

1. **Packaged Windows executable cannot complete a full click-through in this environment.** Root cause: this machine's Visual Studio 2026 install is incompatible with `node-gyp`'s Visual Studio detection, so `better-sqlite3` cannot be recompiled for Electron's V8 ABI, and the packaged app crashes during local persistence init before the workspace/model-picker screen can be reached inside real Electron chrome. **Missing proof:** a packaged-exe run producing the `r1`-style harness's `r1.model_picker=PASS` marker (or equivalent) from `apps/desktop/scripts/packaged-smoke.js`/`r1-ui-certification.mjs`, on a machine (or CI runner, per existing memory: pin to `windows-2022`) where the native rebuild succeeds.
2. **Live discovery against the real, deployed CodeForge Cloud API was not exercised.** This sandbox has no network path to a real `apps/cloud-api` deployment or to OpenRouter, so `registerCloudFreeCatalogOnly()`'s actual HTTP round trip, and the true current count/identity of qualified free models, were validated via unit tests and a schema-accurate local fixture — not a real network call. **Missing proof:** the same live verification in §9, run against a real reachable `apps/cloud-api` instance (staging or production), confirming the real free-model count and identities, and that `authenticateRequest()`'s 401 path surfaces a clean, non-crashing message in the UI for a signed-out user who tries to actually send a message.

Neither blocker stems from this milestone's implementation; both are pre-existing environment/connectivity constraints. The architecture, root-cause fix, and UI corrections described in §§2–10 are implemented and verified to the fullest extent this sandboxed environment allows.

## 15. Final Verdict

**`CODEFORGE_MODEL_PICKER_FREE_CATALOG_R1_BLOCKED`** — blocked strictly on the two external proofs in §14 (a Windows toolchain capable of an Electron-ABI native rebuild, and network access to a real CodeForge Cloud API deployment). All in-scope implementation, tests, static verification, and live (non-Electron-shell) UI verification are complete and passing.
