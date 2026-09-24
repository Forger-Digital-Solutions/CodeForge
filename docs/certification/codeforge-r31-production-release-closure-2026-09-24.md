# CodeForge R31 production release closure certification — 2026-09-24

**Verdict: `CODEFORGE_R31_RELEASE_BLOCKED`.** R31 closed both inherited
reliability defects — provider 429 recovery and post-edit loop stalls — and
added an independent goal-conformance review that provably blocks work the
visible checks missed. The complete agent platform was audited end to end:
Browser, Computer Use, the built-in tool registry, permissions, plugins,
extensions, MCP/tool servers, capability inventory, integration security,
and persistence. A fresh production-endpoint package was built, hashed,
and passed all three packaged smoke modes on the final binary.

The campaign is nevertheless **blocked**: the live large-task acceptance
batch reached 4/12 fully autonomous verified passes against a target of
≥9/10, one residual false-success path remains when the tail review is
starved by budget exhaustion, the remote marketplace catalog is not
implemented, vision does not feed back into the model loop, and Computer
Use lacks semantic grounding. Signing, second hardware, and the install
lifecycle are external/environmental blockers.

## Source and inheritance

R31 continued from the interrupted campaign on `codex/r29-release-closure`,
recovered the previous agent's four-file diff intact, verified it, and
committed it in logical phases. Final product code is committed; evidence
and this certification are committed separately. No remote push was
authorized or performed.

Test host: Windows NT 10.0.26200.0, x64, 12 logical processors,
34,060,460,032 bytes RAM, Node v24.19.0.

## Major fixes delivered and verified

1. **Provider 429 cooldown on thrown streaming errors** —
   `GovernedProviderAdapter.streamChat` released the governor reservation
   but never recorded the cooldown, so a streamed 429 left the route
   looking healthy. Fixed: record `retryAfter` cooldown on thrown
   `ProviderError` status 429, rethrow, release in `finally`. 18/18
   focused + 206/206 provider tests.
2. **Post-edit loop recovery** — a turn that made a real file change and
   then died to `AGENT_NO_PROGRESS_DETECTED`/`AGENT_TOOL_LOOP_DETECTED`
   receives exactly one bounded continuation funded by remaining working
   budget; no-edit loops are not retried; a second loop ends the run.
   3/3 focused tests.
3. **Independent goal-conformance review** — after verification, a bounded
   reviewer turn inspects the workspace against the stated goals and emits
   structured verdicts. `goal_not_satisfied` is blocking and feeds the
   completion gate via `review_rejected`; an unparseable verdict is
   advisory-only. Completion-blocker evidence now flows through the
   `workflow.completion_decided` event and persisted inspection. 3/3
   focused tests; 199/199 workflow package; 19/19 server workflow suites.
4. **Harness hardening** — verifier lock extended to `python <script>`
   with resolved interpreter; request ceiling 24→32 for review headroom;
   secret-scan allowlist rebound to exact line hashes.

## Live acceptance — 12 real free-provider attempts

Route: OpenRouter `nvidia/nemotron-3-super-120b-a12b:free` (FREE_API, no
paid spillover). Every attempt preserved under
`docs/evidence/r31-production-release-closure/10-live-acceptance/`.

| Outcome | Count | Detail |
| --- | ---: | --- |
| Autonomous pass (completed + hidden verifier) | 4 | `qual-js-off-by-one` (pilot), `js-bug-fix-cart-total`, `r25-testfix-js-stale-expected`, `qual-js-missing-export` (with injected 429 + loop recovery exercised live) |
| Correct block — goal review caught unmet goal | 2 | `ts-feature-cli-stats` (never wired the subcommand), `ts-bug-fix-queue-order` (Promise.all left concurrent — the reviewer beat the task's own shallow hidden checks 4/4) |
| Blocked but work correct | 3 | `js-investigation-webhook-retries` (route lost at req 13), `r25-review-js-retry-storm` (32-req ceiling), `py-bug-fix-config-merge` (20-min wall clock) — all failed closed on `verification_not_run`/deadline, never claimed success |
| Provider failure | 1 | `qual-js-off-by-one` first attempt — single response over the 4096-token output cap |
| Honest fail | 1 | `ts-large-context-rename-config-key` — partial rename, ceiling, no false completion |
| False success | 1 | `ts-refactor-extract-validator` — validator shape contract missed; visible checks were `node --check` only and the goal-review turn starved at the request ceiling (inconclusive → advisory) |

Autonomous rate: **4/12 (33%)** vs R30's 1/8 (12.5%) — improved, below the
≥9/10 target. Root-cause taxonomy:
`02-large-task-reliability/r31-acceptance-taxonomy.json`.

## Platform capability certification

Machine-readable inventory: `19-capability-registry/capability-inventory.json`
— 61 capabilities: 51 `IMPLEMENTED_AND_USED`, 9 `IMPLEMENTED_PARTIAL`, 1
`MISSING`.

| Capability | Classification | Evidence |
| --- | --- | --- |
| Built-in tools (19) + ToolBroker | RELEASE_CERTIFIED | registry, schema validation, role/permission filtering, bounded output — 138 capability tests pass |
| Browser (11 tools) | RELEASE_CERTIFIED | real local-page proof: navigate/inspect/screenshot/click/type/close; metadata+file navigation denied; downloads quarantined; cookies never shared |
| Computer Use (6 tools) | IMPLEMENTED_NEEDS_MORE_PROOF | real 1920×1080 screenshot hashed as evidence; out-of-bounds click + empty key list rejected; coordinate-only — no UIA/semantic grounding |
| Permissions | RELEASE_CERTIFIED | tier 0–4, three modes, read-only roles capped, narrow scoped grants, policy receipts; bypass testing via external-tools suite |
| Plugins | RELEASE_CERTIFIED | `node:vm` isolation (no require/process/fs/net), time-bounded lifecycle, per-extension error containment, `plugin__*` namespacing |
| Extensions | RELEASE_CERTIFIED | install/enable/disable/uninstall + secrets + settings persist; packaged lifecycle PASS |
| MCP / tool servers | RELEASE_CERTIFIED | stdio + streamable-HTTP, namespaced tools, fail-closed effects, 9-case adversarial lifecycle (hang/malformed/crash/giant/lying-schema/secret-echo/slow-init) all contained |
| Marketplace/catalog | PARTIAL_RELEASE_BLOCKER | local discover/install/enable/disable/remove + details implemented; **no remote catalog** — the one `MISSING` inventory entry |
| Vision | PARTIAL | screenshots persist as SHA-256 evidence; image bytes do not re-enter the model loop — no visual reasoning on this surface |
| Capability persistence | RELEASE_CERTIFIED | packaged recover smoke: credentials decrypt, approvals not replayed, extension/MCP state restored, corrupt payload fails closed |
| Integration security | RELEASE_CERTIFIED | `26-integration-security` matrix + 54/54 penetration tests + hardened secret scan |

## Canonical regression

Final full suite on a quiet machine: **461 files — 3,584 passed, 48
environment-skipped, 0 failed** in 516 s (`full-regression-final.log`).
The only mid-campaign failures were fg11/fg12e source-state drift,
resolved by the guarded R31 recertification entry
(`benchmarks/r31/recertify-source-state.mjs`); a second run under
concurrent endurance load flaked three wall-clock-bound tests, all of
which pass isolated and in the final clean run.

## Packaged artifact

Built at version 0.4.0, production channel, cloud endpoint
`https://codeforge-cloud-va.onrender.com`:

| Artifact | SHA-256 |
| --- | --- |
| `CodeForge-Setup-0.4.0.exe` | `3ebb9f599cbe82eb4c535317e64abc251f849576ab9dfa5dd70af57da2d565da` |
| `CodeForge-Portable.exe` | `9780135e4e3c8ebd20aef04a4f0efe251992ea933ffdd9a4190b9e3db24cf0ad0` |
| `win-unpacked/CodeForge.exe` | `0079d559221901662452ec0ef04385ba67339ee41b0495c6888ab8e1b2921439` |
| `win-unpacked/resources/app.asar` | `b2cbd913012b021a1cf6af35943a3e4c86c759c59e67bda86878ac3a51155d1d` |

Packaged smoke on the final binary: **3/3 modes PASS** — full (startup,
auth restore, real workflow, control-plane bearer rejection, extension
command+lifecycle, workspace escape blocked, credentials encrypted),
interrupt (clean restart boundary), recover (no approval replay, corrupt
credential fails closed, fresh task). Receipt: `16-final-package/` +
`apps/desktop/release` smoke logs.

## Endurance

`benchmarks/r31/packaged-endurance.mjs` — **4h00m13s** active mode against
the packaged binary (`0079d559…`), isolated profile/workspace. Receipt:
`08-endurance/packaged-2026-09-24T12-45-12.361Z-b732f42f.json`.

- Process alive the entire window; 463 samples, 0 telemetry failures, 0
  leftover PIDs; clean `taskkill` shutdown.
- Memory: workingSet −44.8 MB/h (574→352 MB — renderer settled);
  privateBytes +4.2 MB/h; handles +2/h; process count flat. No leak trend.
- Profile growth after 4h: database 160 KB, logs 57 KB.
- Workload cycles (237) exercised index status/rebuild, search, activity,
  and sessions endpoints (HTTP 200s, index READY, search hits); every
  cycle's git step was policy-rejected (`only 'status --porcelain' is
  allowed`) and unauthenticated health probes correctly returned 401 —
  so `passedActiveCycles` is honestly 0; coverage flags for provider
  requests/autonomous completion are false by design (no provider was
  configured into the endurance profile).

## External / environmental blockers (not product defects)

- **Windows signing** — no Authenticode certificate exists in this
  environment (`availableCodeSigningIdentityCount: 0`, no `WIN_CSC_LINK`);
  all three executables authoritatively `NotSigned`. Evidence:
  `12-signing/`.
- **Second hardware** — only one Windows host accessible; near-single-command
  bundle prepared. Evidence: `13-second-hardware/`.
- **Install/update lifecycle execution** — the harness is complete and its
  disposable-profile guard is proven (it correctly refused a mismatched
  identity); execution needs disposable-account credentials or elevation
  this shell does not have. Evidence: `10-lifecycle/`.

## Remaining CodeForge-controlled gaps (why blocked, not external-ready)

1. Autonomous large-task rate 4/12 < ≥9/10 target.
2. Residual false-success path: weak visible checks + tail review starved
   by budget exhaustion → completed on insufficient evidence
   (`ts-refactor-extract-validator`). Mitigation shipped: review exists and
   blocks when it runs; advisory-on-inconclusive is deliberate (blocking on
   it trades the false success for a false block — measured live).
3. Remote marketplace/catalog not implemented (local capability management
   is implemented and certified).
4. Vision: capture exists; no image-to-model feedback loop.
5. Computer Use: coordinate-based only; no UIA/window grounding.

## Historical evidence integrity

R28 52/52, R29 38/38, and R30's 48 evidence files all re-verify against
their frozen manifests (`verify-inherited-evidence.mjs`). R30's four
release *artifacts* no longer byte-match its receipt because the R31 build
replaced the same output paths — expected behavior for a new build; the
frozen manifest and evidence files are unchanged. The R30 certified-
source-state chain is extended, not rewritten, by the R31 recertification
entry.
