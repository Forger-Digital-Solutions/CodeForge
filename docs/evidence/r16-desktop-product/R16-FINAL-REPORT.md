# CodeForge R16 Desktop Product — Final Certification Report

Date: 2026-09-19
Branch: `forger-digital-solutions-forgegreen-certified`
HEAD at certification: `895359291097c337cbf81745e23adf9b2ac67253`
Scope: certify the **installed** Windows desktop product — installer, registry, process tree,
live renderer, real Cloud session — not source compilation or renderer mocks.

## Executive verdict

`CODEFORGE_R16_DESKTOP_PRODUCT_CERTIFIED = YES`

The certified artifact is `CodeForge-Setup-0.4.0.exe` built from commit `8953592`
(`dirty=true` only because evidence/harness files were uncommitted at build time — the packaged
code was byte-verified against committed `dist` output by the internal-dependency audit).

| Artifact | SHA-256 | Bytes |
|---|---|---|
| `apps/desktop/release/CodeForge-Setup-0.4.0.exe` | `E118C8E267C7FA730610F7B7DB772B1FFF2AC9788B8AE4CFDF459B013DB76D48` | 117,288,277 |
| `apps/desktop/release/CodeForge-Portable.exe` | `64687A9228693841FDD0D9B4A3478AFCEA9DA9852B261D88C5D6761D03288AC1` | 116,952,864 |

Production Cloud gate passed at build time: `codeforge-cloud-va.onrender.com` HTTP 200,
`ready` with hosted inference, 37 models / 33 verified-free, OpenRouter + Groq capacity healthy.

## What "the app stopped lying" means, proven

1. **One canonical lifecycle state.** `packages/ui/src/run-lifecycle.ts` derives a single
   `RunState` from durable events; every surface (Header, Composer, Navigation, WorkspaceApp,
   WorkflowProgress, Inspector, timeline, restored sessions) reads the projection — no surface
   interprets raw event fields independently. Paused can no longer render as "Working"; failed
   can no longer render as "Idle". 18 lifecycle invariant tests green.
2. **Terminal outcomes are honest.** `evaluateCompletion` in `packages/workflow` is the only path
   to `completed`. The live installed-app task (`05-chat-agent/e118c8e`) ended `failed` with the
   real reason shown — even though the agent's diff actually fixed the fixture, the plan did not
   finish, so the product refused to claim completion.
3. **Failures are attributed to their owner.** `describeRunFailure` classifies
   `managed_free`/`byok`/`paid`/`runtime`/`user`. Managed free failures never mention "your API
   key". CodeForge-authored `[CODE]` envelopes (entitlement denials, ForgeZero refusals, loop
   guards, tool-safety refusals, provider capacity) map to curated copy with the machine code
   preserved in `detail`. Verified **live** on the installed build: a real
   `[AGENT_NO_PROGRESS_DETECTED]` stop now reads "The agent kept repeating actions without making
   progress, so CodeForge stopped the run (AGENT_NO_PROGRESS_DETECTED)" — previously the same
   error displayed "route returned an error CodeForge could not classify" under `byok`.
4. **Task identity survives.** `title`/`taskTitle` preserved across resume/repair/reroute; the
   hosted-resume path no longer overwrites identity with the injected continuation prompt.
5. **Commands are headless.** All agent `run_command`, verification, ForgeVerify and command
   service paths share the ConPTY executor. Installed-build probe: 15 executions across
   prepared/shell/electron modes, **0 console windows** at 40 ms sampling.
6. **The package ships current code.** `npm run build` now runs `tsc -b` over workspace packages
   before bundling, and `audit-packaged-internal-dependencies.mjs` fails if shipped `dist` is
   older than `src` (via the `tsconfig.tsbuildinfo` marker) or if packaged bytes differ from repo
   `dist`. The stale-`dist` defect — where the installer shipped pre-change classifier code — is
   closed and gate-kept.
7. **Installer correctness.** Publisher `CodeForge Team`, display name `CodeForge`, registry
   targets the real install dir, `--delete-app-data` silently removes the profile + updater cache
   + repository indexes (verified natively), upgrades preserve user data, normal uninstall keeps
   it, node-pty payload 62.6 MB → 3.7 MB.

## Native evidence against the final artifact (E118C8E2)

| Scenario | Evidence | Result |
|---|---|---|
| Install audit (artifact identity, registry, files, endpoints) | `00-baseline/install-e118c8e/` | **20 PASS / 2 WARN** (unsigned binaries — no production cert) |
| Fresh first launch | `02-first-launch/fresh-e118c8e/` | **11 PASS** |
| Retained-profile launch | `02-first-launch/retained-e118c8e/` | **11 PASS** |
| Full lifecycle: install → upgrade 0.3.0→0.4.0 → relaunch → uninstall → reinstall (retained) → silent `--delete-app-data` → clean reinstall | `12-upgrade/lifecycle-audit.{json,md}` | **24 PASS / 0 WARN / 0 FAIL** |
| UI walkthrough (31 steps: picker, account, composer, tab order, contrast, all Settings sections) | `07-ui/e118c8e/` | **31/31, zero console errors** (ERR_UNSAFE_PORT eliminated) |
| Window behavior (maximize/restore/minimize, 1280×720, persistence across relaunch) | `07-ui/window-behavior-e118c8e/` | **8 PASS / 1 WARN** (second-monitor placement, environment-dependent) |
| Headless command probe on installed binary | `06-terminal-headless/headless-command-probe.json` | **PASS — 15 execs, 0 console windows** |
| Real agent task through the live UI | `05-chat-agent/e118c8e/task-e118c8e.json` | Truthful terminal `failed`; failover, verification, gate block, correct failure attribution all observed |
| Cloud blackhole → live recovery | `10-failure-recovery/blackhole-e118c8e/` | **9/0/0** — keeps signed-in identity, names "Cloud offline", recovers without restart |
| Cloud refused (TCP RST) → recovery | `10-failure-recovery/refuse-e118c8e/` | **9/0/0** |
| Cloud slow (2.5 s latency) → recovery | `10-failure-recovery/slow-e118c8e/` | **9/0/0** |
| Resilience: second launch, close-during-task dialog, Stop, renderer crash, force-kill | `11-close-relaunch/resilience-e118c8e/` | **14/0/0** |

Total native checks on the final artifact: **128 PASS / 3 WARN / 0 FAIL**.

## Test totals (source suite)

`npx vitest run` at `8953592`: **2880 passed / 2 failed / 36 skipped (2918)**.

The two failures are `packages/forgegreen-campaign` source-state **provenance canaries**
(`fg11-source-state`, `fg12e-harness-provenance`): they assert the working tree is byte-identical
to the certified FG-12E snapshot and fail by design on any post-certification change. They are
the drift alarm doing its job, not product regressions — the R16 changeset is exactly the drift
they exist to flag.

Subset counts: desktop 317, server 591 (+3 postgres skips), ui 275, terminal included in suite.

## Defects found and fixed during R16

| Defect | Fix | Verified |
|---|---|---|
| Canonical lifecycle reducer orphaned (nothing imported it) | Wired through `useWorkspaceSSE`; projected onto all surfaces | 18 invariant tests + native runs |
| `turn.failed`/`state.error` lost machine codes and misattributed entitlement/capability errors | `FORGE_CODE_FAILURES` table + curated passthrough; `failure.detail` retains raw reason | 16 run-failure tests + live run |
| Resume path overwrote `title`/`taskTitle` with continuation prompt | Preserve existing identity | `task-identity.test.ts` |
| `--delete-app-data` silent uninstall left the whole profile | `installer.nsh` honors `${isDeleteAppData}` and removes profile, updater cache, repo indexes | lifecycle `fullRemovalDeletesUserData` PASS |
| `humanizeError` could emit "your API key" for managed routes; WorkspaceApp re-humanized owned messages | Neutralized credential wording for unknown-ownership errors; timeline/composer prefer `failure.message` | UI suite + live run |
| `ERR_UNSAFE_PORT` console spam at startup | Guarded `refreshIndex` and `sseUrl` on unresolved endpoint (was fetching `127.0.0.1:0`) | walkthrough: 0 console errors |
| **Stale `packages/*/dist` shipped in installer** (desktop build never rebuilt workspace packages) | `build` runs `tsc -b ../../tsconfig.json` first; packaged-dist audit byte-compares asar vs repo dist and checks tsbuildinfo freshness | audit PASS on final artifact; classifier confirmed inside app.asar |
| node-pty shipped all platforms + PDBs (62.6 MB) | electron-builder `files` filter → 3.7 MB | measured in win-unpacked |

## Harness bugs fixed (the auditor, not the product)

- `Invoke-LifecycleAudit.ps1`: relative `-NewInstaller` made `Substring`-based path stripping
  mangle every expected key → 98 false "stale" files. Normalized to absolute once.
- `Invoke-NetworkFaultProbe.ps1`: `Substring` on whitespace-collapsed text threw mid-probe;
  recovery check sampled `getCloudAccount` during the designed 2.5 s fast-path window and read
  `offline+pending` as a failed recovery — now polls until settled (bounded).
- `Invoke-ResilienceProbe.ps1`: `encodeURIComponent(JSON.stringify(id))` sent literal quotes →
  `/api/sessions/<id>` never matched → "task never reached running".
- `Invoke-WindowBehaviorProbe.ps1`: `\"` isn't a PowerShell escape (parse error); restore check
  compared against a maximized baseline; sizes used raw `dpr` in a logical coordinate space → the
  probe was asking for a window larger than the work area and the app correctly clamped.

## Honest caveats

- Binaries are **not code-signed** — SmartScreen warns on first run (2 WARN, expected absent a cert).
- The live agent run hit the no-progress loop guard on a repeated read; the fix landed and tests
  pass, but the plan ended `failed` because a step didn't finish. Truthfully reported — the guard
  may warrant tuning for legitimate re-reads during verification, which is a scheduling concern,
  not a truth defect.
- `secondMonitor` placement check is environment-dependent (mixed-DPI monitor geometry); WARN.
- `dirty=true` in the artifact's build identity reflects uncommitted evidence/harness files at
  build time; shipped code is byte-identical to committed `dist`.
