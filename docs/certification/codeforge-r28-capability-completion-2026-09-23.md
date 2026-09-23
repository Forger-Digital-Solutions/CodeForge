# CodeForge R28 capability completion, packaged reality, and live-proof certification — 2026-09-23

## Overall verdict

`CODEFORGE_R28_CAPABILITY_COMPLETE_LIMITS_DECLARED`

CodeForge is now proven as a functioning packaged Windows autonomous engineering platform
whose major capabilities work together under real conditions: the exact shipped executable
launches, renders, connects its runtime, and survives interrupt/recovery; real free-provider
tasks complete through the canonical completion gate with independent hidden verification;
and every declared subsystem carries live evidence on this host. Residual limits are honest
and enumerated below — none is hidden behind a fabricated pass.

## Evidence base

All receipts live under `docs/evidence/r28-capability-completion/` with the capability
ledger at `R28-CAPABILITY-LEDGER.{json,md}`. Live proofs distinguish real provider evidence
from deterministic evidence; a `blocked` run is never counted as success.

## Canonical live completion and task-class capability

- **Tiny task** — `qual-js-return-sign` on `openrouter/nex-agi/nex-n2.5-mini:free`: workflow
  `complete`, completion-gate `completed`, hidden verifier pass
  (`R28-LIVE-COMPLETION-EVIDENCE.json`).
- **Medium task** — `js-bug-fix-cart-total` on `nvidia/nemotron-3-super-120b-a12b:free`:
  25 requests / 16.6 min, gate-completed, hidden verifier pass (live run receipts under
  `R28-LIVE-RUNS/`).
- **Large task** — `ts-large-context-rename-config-key`: three attempts across two model
  tiers (`nemotron-3-super-120b`, `nemotron-3-ultra-550b`) all terminated `blocked` with
  plan-steps-unfinished (the models rewrote identical content, +0/−0 diffs). Recorded as a
  capability ceiling of current verified-free routes, not a runtime defect. No pass was
  manufactured.

## Intelligence systems — live matched-pair and lifecycle proofs

- **ForgeGreen** — real A/B on `executeAgentRun` (`R28-FORGEGREEN-AB-LIVE-EVIDENCE.json`):
  control 9 requests / 0 stable-prompt cache hits / 28,518 effective uncached input tokens;
  experiment 8 requests / **7 provider-reported cache hits** / 23,744 cached + 25,264
  effective uncached input tokens; −2,679 model-context bytes, −750 output tokens. Both arms
  completed with hidden verification and persisted R0 telemetry. The arm difference is
  causally attributable to the advisor's stable-prefix mechanism.
- **Subagents / adaptive topology** — real A/B (`R28-SUBAGENT-AB-LIVE-EVIDENCE.json`):
  `fixed_r1` spawned 6 children, spent 79 requests / 12.6 min and still blocked; `adaptive`
  classified the same task tiny, spent 9 requests / 1.15 min and completed with hidden
  verification. Adaptive routing showed live net value on this pairing.
- **Planner** — 8/8 live: a real nemotron planner turn produced a valid 6-task acyclic
  authorized plan through the production validator (`R28-PLANNER-LIVE-EVIDENCE.json`).
- **8-Bit + ForgeAuto** — 17/17 live: a real qualification cycle (real probe cases →
  PROBATION receipt → eligibility flip) plus routing-fabric checks; honest limitation
  recorded that single-provider connectivity cannot demonstrate same-model cross-provider
  failover (`R28-FORGEAUTO-LIVE-EVIDENCE.json`).
- **16-Bit** — completeness audit: statically complete routing-intelligence surface;
  quality/latency/role-suitability dimensions are empirically absent by policy (no
  authorized paid probes). Recorded as policy-bounded, not a defect
  (`R28-16BIT-COMPLETENESS-AUDIT.json`).

## Capability surfaces — all live-proven on this host

| Surface | Evidence | Result |
| --- | --- | --- |
| Browser | `R28-BROWSER-LIVE-EVIDENCE.json` | Governed runtime against real localhost pages + policy denials |
| Computer Use | `R28-COMPUTER-USE-LIVE-EVIDENCE.json` | 9/9 — new `packages/computer-use`: 3600×1080 bounds, 6.6 MB capture, OS-readback cursor moves, SendInput, policy gates |
| Terminal | `R28-TERMINAL-LIVE-EVIDENCE.json` | 10/10 on real ConPTY — lifecycle, streaming, timeout tree-kill with zero orphans, abort |
| WSL | `R28-WSL-LIVE-EVIDENCE.json` | Host-verified |
| Git | `R28-GIT-LIVE-EVIDENCE.json` | 15/15 — stash snapshots, divergence clobber-protection, byte-exact force-restore incl. untracked, honest drift |
| GitHub | `R28-GITHUB-LIVE-EVIDENCE.json` | 10/10 real authorized mutation — disposable repo, branch push, PR create+find via production client, `REMOTE_AUTH_FAILED` on bad token; repo deletion needed `delete_repo` scope (cleanup gap noted) |
| MCP | `R28-MCP-LIVE-EVIDENCE.json` | 16/16 — real SDK stdio server: handshake, enumeration, namespaced bridging, deny-effect exclusion, dead-server transition |
| Extensions | `R28-EXTENSIONS-LIVE-EVIDENCE.json` | 21/21 — dev-load, vm-sandbox isolation, permission gates, delegates, disable/enable, persistence, uninstall+secret purge |
| Settings | `R28-SETTINGS-LIVE-EVIDENCE.json` | 13/13 — control-plane 401s, privacy-mode eligibility transitions (STRICT→0, MAXIMUM_FREE→1), invalid rejection, paid refusal |
| Updater | `R28-UPDATER-LIVE-EVIDENCE.json` | 5/5 real electron-updater: sha512-verified download, tampered manifest refused, dead feed honest `unavailable` |
| Auth | `R28-AUTH-LIVE-EVIDENCE.json` | 26/26 — S256 PKCE, JWT round-trip, all hostile variants rejected (tamper, alg=none, RS256 confusion, expired, forged, wrong issuer) |
| Memory | `R28-MEMORY-LIVE-EVIDENCE.json` | 18/18 — 200-turn/500-event accumulation, isolation, idempotency, restart durability |
| Recovery | `R28-RECOVERY-LIVE-EVIDENCE.json` | 23/23 — continuation state machine, dedup, binding enforcement, crash-window repair, lease contention |
| Permissions | `R28-PERMISSIONS-LIVE-EVIDENCE.json` | 32/32 ToolBroker penetration — role ceilings beat granted flags; dotdot/absolute/UNC/junction escapes all `TOOL_PATH_ESCAPE` |
| Diagnostics | `R28-DIAGNOSTICS-LIVE-EVIDENCE.json` | 30/30 — real Electron main drives built module; 8 planted credential shapes redacted in sanitizer, on-disk bundle, persistent log |

## Packaged reality

Fresh `release/win-unpacked` build (Electron 44.4.1 / Node 24.21.0). All three smoke modes
pass on current bytes (`R28-PACKAGED-SMOKE-EVIDENCE.json`, canonical-regression re-run):

- **full** — `PACKAGED_FULL_SMOKE_OK`: startup, ForgeGreen/8-Bit/cloud-DB runtimes, auth
  restore, control-plane trust boundary (bearer withheld, forged approval/origin rejected,
  secondary renderer unauthenticated), repository index READY (258 files) + known-answer
  query, workspace restore + escape block, zero-prompt workflow, failure-repair, renderer
  reload ×5, settings round-trip + invalid rejection, extension lifecycle, updater
  status/check/install-guard, credential encryption round-trip.
- **interrupt** — expected exit 73, `electron_restart_interruption_ready`.
- **recover** — `PACKAGED_RECOVERY_SMOKE_OK`: corrupt credential fails closed, legacy
  plaintext rejected + migrated, restart decrypt, no approval replay, fresh task.
- Internal dependency audit: `PACKAGED_INTERNAL_DEPENDENCY_GRAPH_PASS` (a real catch —
  `computer-use` was missing from the asar and was added).

## Dogfood and technical demo

- **Dogfood** (`R28-DOGFOOD-EVIDENCE.json`) — genuine session through the production
  `createServer` wired identically to Electron main (`createProviderAdapterFromDefinition`
  + `discoverAndVerifyFree` → ForgeZero). Real API flow: workspace/set → model-selection →
  workflow/run → supervised polling (approvals/questions resolved through the real
  endpoints) → terminal. `js-bug-fix-cart-total`: workflow `complete`, gate `completed`,
  hidden verifier pass, 35 API calls / 285 events / real plan+8-Bit+verification work items.
  Boundary recorded honestly: `forge serve` intentionally ships no provider connections
  (the desktop owns provider wiring); interactive OAuth + packaged-UI dogfood remains open.
- **Technical demo** (`R28-TECHNICAL-DEMO-TRANSCRIPT.{md,json}`) — narrated six-scene
  replayable run: 456 live OpenRouter models → 24 verified-free → ForgeZero; 401
  unauthenticated; repository index READY; real task to gate-completion; unverified route
  refused `MODEL_NOT_FOUND` (fail-closed live).

## Endurance, hardware, and canonical regression

- Live soak: 8/10 `executeAgentRun` iterations completed across 10 distinct tasks over 20
  min; healthy linear resource growth (`R28-ENDURANCE-LIVE-EVIDENCE.json`).
- Packaged soak: 39 samples / 20 min, alive throughout; 39/39 endpoint probes → 401 (auth
  boundary held under soak); zero working-set slope; zero leftover processes after forced
  shutdown at graceful-timeout (`R28-ENDURANCE-PACKAGED-EVIDENCE.json`).
- Hardware profile measured on this host: i7-9850H / 32 GB / Windows 11 + real cold-start
  timings (`R28-HARDWARE-PROFILE-EVIDENCE.json`).
- Canonical regression (`R28-CANONICAL-REGRESSION-EVIDENCE.json`): R27 golden battery
  identical to baseline (13 PASS + 2 python-absent env blocks, same two tasks); server
  suite 115 files / 732 tests; computer-use 22/22; all three packaged smoke modes green on
  current bytes.

## Declared residual limits (honest, not hidden)

1. Large-context task completion exceeds current verified-free model capability (3 blocked
   attempts, preserved receipts).
2. Interactive OAuth + packaged-UI dogfood: a fresh profile requires real GitHub sign-in;
   the API-level dogfood covers the production path honestly.
3. Packaged-interactive gaps: IPC spoof penetration, packaged MCP/extension lifecycle,
   interactive diagnostics-export UX.
4. Endurance at 60–90 min / multi-hour levels and a second hardware profile are unproven.
5. Cross-provider same-model failover undemonstrated (single connected provider).
6. GEMS and multi-user/DAU work remain frozen by campaign rule; signing identity for the
   installer remains unavailable on this host.

## Final engineering gate

| Gate | Result |
| --- | --- |
| Server unit suite | PASS — 115 files, 732 tests, 3 conditional skips |
| Computer-use suite | PASS — 22/22 |
| R27 golden battery | IDENTICAL — 13 PASS + 2 env-blocked (python absent) |
| Packaged smoke (full/interrupt/recover) | PASS on current bytes |
| Live provider evidence | PRESENT and distinguished from deterministic evidence |
| Fabricated passes | NONE — blocked/failed states preserved as evidence |
