# CODEFORGE DAILY-DRIVER R2 — PACKAGED RUNTIME & REAL-AGENT CERTIFICATION

**Continues:** `CODEFORGE_FULL_PRODUCT_AUDIT_R1_FUNCTIONAL_WITH_GAPS`
**Date:** 2026-09-12
**Branch:** `forger-digital-solutions-forgegreen-certified`
**R1 baseline HEAD:** `92df553`
**R2 candidate HEAD:** `2dbeab7` (clean tree)
**Package version:** `0.2.0` → **`0.3.0`**

---

## 1. VERDICT

```
CODEFORGE_DAILY_DRIVER_R2_BLOCKED
```

Every gate that does **not** require live model inference is proven on the **real packaged Windows
application** (`app_is_packaged=true`), including all six R1 gaps. The **one** mandatory gate that
cannot be honestly proven is the **real live-model coding task from the packaged UI**: this
environment has no zero-cash free-model inference route. Per Section 8/27 this is reported as a
legitimate availability failure — **not** faked with a fixture or a paid substitution.

This verdict reflects an **environmental model-availability constraint**, not a product defect and
not a failure of the packaged runtime. The coding **environment and execution system** CodeForge is
built to supply — packaging, startup, repository intelligence, the tool/edit/verify/completion
machinery, durable interrupt/restart recovery, approvals policy, close/tray lifecycle, credential
security, settings — are all proven in the packaged app. What is missing is a live **model** to
supply intelligence, which the zero-cash boundary and this sandbox's configuration do not provide.

---

## 2. EXACT CANDIDATE

| Field | Value |
|---|---|
| Branch | `forger-digital-solutions-forgegreen-certified` |
| Candidate commit | `2dbeab7fff2e881aa0fae9a2ad8624ad995b4542` |
| — gap closure + version bump | `cf7ac08c6a67b06614105f7af8312e611820d892` |
| — packaging native-prebuild fix | `2dbeab7fff2e881aa0fae9a2ad8624ad995b4542` |
| Working tree | **clean** (0 uncommitted; `release/` and `dist/` are gitignored) |
| Package version | `0.3.0` |

The R1 audit tested an uncommitted 46-file working tree (R1 GAP-3). R2 committed the full inherited
R2 implementation plus this session's fixes into a reproducible candidate, then built every artifact
from that exact SHA.

---

## 3. WHAT CHANGED (this session)

### Security — R2 GAP-4: `shell:execCommand` hardened to a read-only git allowlist
`apps/desktop/src/git-exec-allowlist.ts` (new, pure, unit-tested). The renderer→main git bridge now
accepts **only** the two read-only product invocations — `git rev-parse …` (workspace context) and
`git config user.name|user.email` (detected identity, read form only). It rejects `push`, `reset
--hard`, `clean`, `config` writes, `credential`, `-c core.sshCommand=…` / `-C` / `--exec-path`
global-flag injection, and control-character payloads — even though the binary was already pinned to
`git`. Wired into `main.ts`; **25 regression tests** (`git-exec-allowlist.test.ts`).

### Types — R2 GAP-5: `getCloudAccount`/`getCloudUsage` no longer return `any`
New electron-free shared contract `apps/desktop/src/cloud-account.ts` (`CloudAccount`,
`CloudAccountIdentity`, `CloudAccountUser`, `CloudUsage`). `preload.ts` types both IPC methods with
it; the renderer's `CloudAccountView`/`CloudIdentityView` now **alias** the shared type (single
source of truth, no drift). Added the module to the renderer tsconfig include; both TS projects
typecheck clean.

### UX — R2 GAP-6: persistent header activity indicator during Settings
`describeHeaderActivity()` in `close-lifecycle.ts` (+3 tests) plus a transient header indicator in
`WorkspaceShell.tsx` (+ `styles.css`). The header stays mounted while Settings is open, so an
in-flight agent run is never invisible; the indicator renders nothing when idle (no permanent
telemetry) and returns to the workspace on click. This implements the exact mitigation R1 proposed —
the code even documented a "header badge" that had never been wired in — **without** a
state-management rewrite. The SSE-unmount-under-Settings remains the intended safe design (the turn
is server-authoritative; the completion gate is authoritative).

### Packaging — first-class `npm run dist` (Section 4)
`scripts/rebuild-native.mjs` forced `@electron/rebuild --build-from-source`, which needs a full
node-gyp C++ toolchain and fails where a newer Visual Studio is present that node-gyp cannot drive
(VS 2026 / v18 on this machine). Result: the electron-ABI `better_sqlite3.node` was never staged and
the packaged app crashed at startup ("Could not locate the bindings file"). Since better-sqlite3 is
an ABI-stable N-API addon, the fix runs `@electron/rebuild` **without** `--build-from-source` first
(uses the official prebuilt binary — no compiler), falling back to source only if no prebuild
exists. `npm run dist` now completes end-to-end on this machine.

### Version bump 0.2.0 → 0.3.0 (lockstep)
43 `package.json` files + electron-builder `extraMetadata.version`, plus the hardcoded app-version
strings (cloud-api `serverVersion`, CLI `VERSION`, codex `clientInfo.version`) and the desktop About
fixture + assertion.

---

## 4. PACKAGED ARTIFACTS

Built from `2dbeab7` via the designed `npm run dist` flow (build + native prebuild staging +
electron-builder 25.1.8, electron 33.4.11, targets: nsis + portable).

| Artifact | Path | SHA-256 |
|---|---|---|
| Installer (NSIS) | `apps/desktop/release/CodeForge-Setup-0.3.0.exe` | `ee022692191662e6524aaa89d562e78b01d45593f0f46f34d212cd9991632687` |
| Portable | `apps/desktop/release/CodeForge-Portable.exe` | `b90353a2a617e23ff7ef33260da3ae44218ceb097d0f62a8887d96a21ea08554` |
| Unpacked exe | `apps/desktop/release/win-unpacked/CodeForge.exe` | `ff557e2ea7c7ac24cae4bb984cf2b6fb7a1ac12776f07d0c289e88753b3cfa84` |

Code signing skipped (no signing certificate configured for a local build).

---

## 5. VALIDATION

| Check | Result |
|---|---|
| `npm run build` (all workspaces) | **PASS** — 0 errors |
| `npm run dist` (packaging, end-to-end) | **PASS** — exit 0 |
| Desktop typecheck (main + renderer) | **PASS** — exit 0 both projects |
| Desktop test suite | **225 pass** |
| New this phase | **28 pass** (git-exec-allowlist 25 + describeHeaderActivity 3) |
| Full suite (logical) | **2243 pass / 36 skip / 0 genuine fail** (R1: 2215 + 28 new) |

**Full-suite flake note (honest):** one fully-parallel run reported 8 "failures", all in
`packages/server/test` (delivery-certification, parallel-recovery, parallel-security) as test
**timeouts** and a Windows **EBUSY** rmdir lock on temp git worktrees under heavy parallel load. All
three files were re-run **in isolation: 20/20 pass**. Zero logic failures; the 8 are
environment/resource-contention flakes, not regressions.

---

## 6. REAL AGENT EXECUTION (packaged)

The packaged smoke harness runs the **real packaged `CodeForge.exe`** (asserts `app_is_packaged=true`)
against a disposable workspace seeded with a deliberately-buggy `src/calc.ts` (`return a - b`) among
256 deterministic noise modules.

| Aspect | Result |
|---|---|
| Provider | **Scripted mock**, gated strictly to `CODEFORGE_PACKAGED_SMOKE` (never production boot; consistent with ForgeZero isolation) |
| Model | none (no live model — see §10) |
| Task | inspect repo → read `src/calc.ts` → edit (`a - b` → `a + b`) → run workflow → verify → complete |
| Edits | `src/calc.ts` corrected and confirmed by the harness (`a + b`) |
| Repository intelligence | `state:READY`, **258 files / 259 symbols** indexed; known-answer query + search **PASS**; workspace-escape **blocked** |
| Failure repair | `packaged_failure_repair_pass=PASS` (an induced failure must be repaired before completion) |
| ForgeVerify / completion gate | Workflow completes only after verification (`PACKAGED_FULL_SMOKE_OK`) |
| Renderer reload | `packaged_renderer_reload_count=5`, `packaged_renderer_reload=PASS` |
| Result | `Mode full SUCCESS (exit 0)` |

**This proves the packaged agent _machinery_ — tool calls, file edits, verification, completion
authority — end-to-end in the real application. It does NOT prove live-model intelligence** (the
provider is a scripted mock). That distinction is preserved deliberately; see §10.

---

## 7. LIFECYCLE PROOF (packaged)

| Scenario | Result |
|---|---|
| Startup / first paint / app icon / title / workspace shell | **PASS** (screenshots; `PACKAGED_STARTUP=PASS`) |
| Empty-chat workspace (clean, coherent) | **PASS** (screenshot `01-authenticated-zero-state`) |
| Settings navigation (open / search / deeplink / back) | **PASS** (`settings_open`, `settings_search`, `settings_back_to_workspace`, `account_menu_profile_deeplink`) |
| Persisted preferences / restore | **PASS** (`packaged_auth_restore`, `packaged_workspace_restore`) |
| Interrupt while active | **PASS** — deterministic exit **73** (`electron_restart_interruption_ready=PASS`) |
| Restart / rehydration (no replay) | **PASS** — `electron_restart_failed_safely=PASS`, **`electron_restart_no_approval_replay=PASS`** |
| Close policy | **PASS** — `resolveCloseAction` never silently discards unrecoverable work; packaged Settings shows "When tasks are active and I close CodeForge: Ask me" |
| Tray / minimize-to-background | Implementation real (`ensureTray`/`hideToTray`/`restoreMainWindow`, honest tooltip via `summarizeActiveWork`); Settings shows tray "✓ Always on". **The literal minimize while a _live model_ task runs is BLOCKED** (needs a live task). |

Durable continuation is surfaced honestly in the packaged Settings: *"Continue eligible interrupted
agents — Turns are re-planned from saved facts; nothing is replayed, and paused turns always wait
for you."*

---

## 8. MODEL SYSTEM

- **Live hosted discovery count: 0.** `GET /v1/hosted/models` is unauthenticated but only returns
  models from server-owned provider keys at cloud startup; with no reachable cloud and no provider
  keys, discovery yields 0. (Honest — no hardcoded "N free models" claim.)
- **Packaged picker: 6 models shown**, correctly grouped (verified visually):
  - **RECOMMENDED** → ⚡ **ForgeAuto/Free** — "Automatic free routing" — **Verified $0**
  - **CODEFORGE FREE** → **CodeForge Free Model**
  - **GEMS** → Topaz / Sapphire / Peridot / Garnet — **Paid · Coming soon**
- **Search**: "Filter models or providers" with a live "N shown" count.
- **ForgeAuto/Free** is the free-experience task router (first in the picker, `Verified $0`).
  **8-Bit** maintains free-slot availability (free catalog; `NO_ELIGIBLE_FREE_MODEL` fail path
  exists). The two remain **architecturally distinct** — no conflation on any surface.
- Source coverage: `model-sections.test` (22), `model-selector.test`, `settings-models`.

---

## 9. SECURITY

All checks run against the **packaged** bundle (`app.asar`), not source alone.

| Audit | Result |
|---|---|
| Browser security | **PASS** — sandbox=true, nodeIntegration=false, contextIsolation=true, webSecurity=true; no `--no-sandbox`/bypass |
| Auth endpoint | **PASS** — channel `development` → `http://127.0.0.1:3220` baked correctly; fail-closed for staging/production |
| Runtime dependencies | **PASS** — 231 packaged runtime modules, 15 external packages |
| Internal dependencies | **PASS** — 20 shipped internal packages |
| Credentials | **PASS** — `credential_plaintext_absent`, `credential_encrypted_payload`, `safe_storage_available`, `credential_round_trip`; `renderer_raw_credential_api_absent` |
| `shell:execCommand` (GAP-4) | **PASS** — read-only git allowlist + 25 rejection tests |
| Secret scan | **PASS** — no keys/tokens/.env/fixture accounts/dev paths in the distributable (only the public Supabase CA cert) |

---

## 10. REMAINING BLOCKERS (exact)

All trace to a **single root cause: no zero-cash live-model inference route in this environment.**

1. **Real live-model coding task from the packaged UI (Section 8, mandatory).** No BYOK/OpenRouter
   `$0` key; the configured `opencode` provider has an empty `opencode.jsonc` and no installed CLI;
   CodeForge Cloud hosted inference needs a reachable endpoint with server provider keys, and the
   packaged dev-channel endpoint is a local `127.0.0.1:3220` that is not running and holds no keys.
   The zero-cash boundary forbids paid providers, and using the user's personal saved cloud
   sign-in / credits was not authorized for this run.
2. **Live user steering during a real run (Section 9)** — depends on (1).
3. **Live approval UX in the packaged GUI during a real task (Section 10)** — approval *logic* is
   unit-proven (13 scenarios + completion-gate `approval_pending`); live GUI observation depends on (1).
4. **Minimize-to-tray continuity while a LIVE task executes (Section 11)** — tray/policy/interrupt/
   recover proven; the live-task variant depends on (1).
5. **Live hosted free-model discovery counts (Section 7)** — needs a reachable cloud with provider keys.

**How to close them:** provide any one working `$0` route — a CodeForge Cloud sign-in against a
reachable endpoint with free-tier provider keys, a BYOK key that includes a `:free` model, or an
installed opencode CLI pointed at a free model — then re-run the principal task through the packaged
UI. The live task, steering, live approval, live-minimize continuity, and live discovery count can
all then be exercised and this verdict re-issued as `…_R2_CERTIFIED`.

---

## 11. R1 GAP DISPOSITION

| R1 Gap | Disposition |
|---|---|
| GAP-1 — no packaged binary | **RESOLVED** — installer + portable + unpacked built from `2dbeab7`, hashes recorded, booted and visually inspected |
| GAP-2 — minimize/close + active task | **SUBSTANTIALLY RESOLVED** — tray + policy + interrupt(73) + recover(no-replay) proven; live-task-during-minimize blocked by model availability |
| GAP-3 — uncommitted candidate | **RESOLVED** — clean committed candidate `2dbeab7` |
| GAP-4 — execCommand git args | **RESOLVED** — read-only allowlist + 25 tests |
| GAP-5 — preload `any` | **RESOLVED** — shared typed contract, renderer aliases it |
| GAP-6 — Settings SSE unmount | **MITIGATED** — persistent header activity indicator; no state loss; no rewrite |

---

## 12. DO-NOT-CHEAT ATTESTATION

No fixture identity, simulated live-model output, dev-Electron-as-packaged, hand-edited persistence,
or paid-provider substitution was used to claim any PASS. The packaged smoke's mock provider is
explicitly labeled as **machinery** proof (not live-model proof) and is gated to
`CODEFORGE_PACKAGED_SMOKE` mode. The one gate that could not be honestly proven is stated plainly as
**BLOCKED**, with the exact cause and the exact remedy.
