# R27 Single-User Intelligence Certification

Date: 2026-09-23

Verdict: `R27_INTELLIGENCE_IMPROVED_WITH_BLOCKERS`

Certification: `R27_SINGLE_USER_INTELLIGENCE_CERTIFIED` **not granted**

The direct answer to the R27 question is **not yet proven**. CodeForge changed a real isolated
fixture through its live `AgentRuntime` and passed visible and hidden checks, but that run ended
`blocked` at its four-turn budget and did not enter the workflow completion gate. A current-source
Windows package passed archive audits but its renderer failed before packaged dogfood could begin.
No multi-hour live or packaged session, or measured hardware responsiveness, exists in this record.

## Evidence boundaries

| Area | Deterministic | Live | Packaged | Hardware | R27 finding |
| --- | --- | --- | --- | --- | --- |
| Core agent and tools | Proven | Bounded runtime/tool slice proven | Blocked at startup | Not proven | One edit passed hidden checks; completion gate not reached |
| ForgeGreen | Proven mechanism | Not proven | Not proven | Not proven | No live A/B benefit or crossover measurement |
| 8-Bit and free routes | Proven lifecycle/contracts | Free catalog and one fixed route observed; adaptive routing not proven | Not proven | Not proven | No quota lifecycle or role-routing proof |
| 16-Bit | Paid execution quarantine proven | Blocked by free-only policy | Not proven | Not proven | No paid inference authorized |
| Subagents | Proven scripted comparison | Not proven | Not proven | Not proven | No live single-agent crossover measurement |
| Planner | Proven protocol compatibility | Not proven | Not proven | Not proven | No live planning-quality measurement |
| ForgeVerify | Proven local workflow/process contracts | Not proven | Not proven | Not proven | Live edit was checked by harness, not ForgeVerify workflow |
| Context | Proven bounds/freshness | One edit invalidation and refresh observed | Not proven | Not proven | No long-session efficiency result |
| Mission memory | Proven one-mission stale-summary exclusion | Not proven | Not proven | Not proven | No cross-session benefit measurement |
| Browser and terminal | Proven local contracts | Not proven | Blocked at startup | Not proven | No packaged long-session process hygiene |
| Git and GitHub | Proven local contracts | Not proven | Blocked at startup | Not proven | No safe packaged repository flow or authorized external mutation |
| Permissions | Historical R26 audit only | Not proven | Not proven | Not proven | Current R27 permissions suite not recertified |
| Recovery and endurance | 79/79 deterministic stress checks | Sustained run not proven | Blocked at startup | Not proven | No real interrupted packaged continuation |
| Single-user performance | 24/24 synthetic guards | Not proven | Blocked at startup | Not proven | No cold/warm, CPU, RAM, latency, or second-device profile |
| UX and packaged desktop | Deterministic UX evidence | Not proven | Archive audited; smoke blocked | Blocked | Renderer failed before interactive observation |

The detailed, machine-readable classifications are in [R27-PROOF-LEDGER.json](R27-PROOF-LEDGER.json).
The 79/79 and 24/24 figures are from the previously committed
[endurance](R27-ENDURANCE-REPORT.md) and
[performance](R27-SINGLE-USER-PERFORMANCE-REPORT.md) suites; they were not recast as live hours or
portable hardware benchmarks.

## Bounded live result

The [live preflight](R27-LIVE-PREFLIGHT-EVIDENCE.json) found an OpenRouter catalog-declared
verified-free `nex-agi/nex-n2.5-mini:free` route with paid fallback disabled. Google returned a
suspended-key 403. Groq health responded, but account-specific free allowance was not attested;
no Groq inference was sent. Remaining OpenRouter account capacity is unknown.

Four [redacted run receipts](R27-LIVE-RUNS/) record zero, two, four, and four dispatched inference
requests. Across the ten dispatched requests, nine streams completed and one returned HTTP 400
after a malformed tool-argument continuation. The subsequent `AgentRuntime` normalization fix
was regression-tested and exercised on the same live route. The nine completed streams reported
25,837 input and 1,536 output tokens in total. These are provider-reported counts, not an
independently billed total; the sample is too small to estimate sustained reliability. No 429 or
timeout was observed in these receipts.

The final four-request run reported 11,758 input tokens, 440 output tokens, 8,576 cached input
tokens, four successful tool calls, one changed file, a context refresh after that edit, and a
15.161-second wall clock. Visible and hidden verification passed. The runtime correctly ended
`blocked` with `AGENT_MODEL_TURN_LIMIT`, and `evaluateCompletion` was not invoked. The earlier
four-request run ended the runtime `completed` but its hidden-verifier path was wrong, so it is
not a verified task completion.

Two responses in that earlier run reported 270 and 321 output tokens despite a requested 256.
The harness now records an overrun and prevents any following dispatch; a local regression test
proves that guard. It cannot retroactively limit tokens already generated by a provider.
Provider-side per-response enforcement remains unproven. This is a material reason the harness
was not escalated to a 15–30 minute run, let alone 60–90 minutes or multiple hours. The locked
small-fix fixture also does not establish medium, large, review, failure-recovery, ForgeGreen A/B,
or live subagent economics.

## Current Windows package

The production package was rebuilt from application source commit `ffa2c21` (version `0.4.0`).
The build identity is `dirty=true` because the protected user-owned
`R27-GOLDEN-TASK-VALIDATION.json` modification remains in the worktree. Its main and renderer
identity stamps agree. Production endpoint preflight was read-only and passed. Archive checks
passed for internal dependencies, 346 runtime modules and 17 external packages, the embedded
HTTPS endpoint, and browser security (`sandbox`, context isolation, and web security enabled;
Node integration disabled).

| Artifact | SHA-256 |
| --- | --- |
| `CodeForge-Setup-0.4.0.exe` | `672dfe75c5051905fdebd91bd7183c05f579846f43a1e2aa9da500f462e2eaf` |
| `CodeForge-Portable.exe` | `3b279850cf84404782c8f6ca2c3f22fe9c380867d2392e2ad46a9793471103c4` |
| `win-unpacked/resources/app.asar` | `35a31e67985114215cdb8f06dcb88774fcae3a15a951ed7f556807ec8833442b` |

The full smoke against that exact archive failed in 2.3 seconds. The local control plane bound,
then Electron reported `RENDER_PROCESS_GONE=launch-failed:49` and `ERR_FAILED` for the renderer
document inside `app.asar`. The renderer file is present in the archive. An older R9 packaged
control reproduced the same launch failure on this host. That comparison narrows the fault but
does not establish a source or host root cause. The host inventory is Windows build 26200,
an i7-9850H, 12 logical CPUs, and 32 GB RAM; no packaged performance sample was obtained.
No security setting was weakened. Full smoke,
interrupt/recover, interactive portable and installer flows, multi-task endurance, and real
hardware profiling remain blocked. The full receipt is
[R27-PACKAGED-DOGFOOD-EVIDENCE.json](R27-PACKAGED-DOGFOOD-EVIDENCE.json).

## Regression and source recertification

The first full source run exposed five failures among 3,586 tests: two legitimate ForgeGreen
source-state canaries and three parallel test-provider classifiers that depended on a transient
task-plan JSON fragment. The classifiers now identify a workstream from its stable goal. Their
privacy, steering, cancellation, and recovery assertions and timeouts were unchanged; the four
affected files and both source-state canary files passed together (17/17).

The guarded [R27 recertification script](../../../scripts/r27-recertify-source-state.mjs) required
the R26 predecessor identity, exactly four reviewed, committed material-file changes, and no
uncommitted material source. It computed the new
[certified source-state](../../codeforge-forgegreen-certified-source-state.json) ID
`3c5e635f4981a8e8955bef25e22c851ef13c9a32e9c0507b1569100f69f92e1e` from Git blob
hashes. Those files cover the semantic Planner protocol, runtime context/tool handling,
duplicate suppression, and command exit-status truthfulness. Historical ForgeGreen observations
retain their earlier source identities; the completion gate was not relaxed.

The post-recertification canonical Vitest run passed **447 files / 3,538 tests**, with eight files
and 48 tests skipped, in 1,301.56 seconds using two workers. Workspace build, lint, forced
TypeScript typecheck, the targeted runtime/release/catalog suite (25/25), the source-state and
parallel suite (17/17), and the harness output-cap regression (1/1) also passed. The security
gate passed its secret, dependency, public-claim, and documentation-link checks. These are source
and archive gates; packaged full smoke remains failed. Exact commands and counts are in
[R27-REGRESSION-EVIDENCE.json](R27-REGRESSION-EVIDENCE.json).

## Answers to the R27 intelligence questions

- **Core agent:** It performed a meaningful isolated edit with real inference and tools. Its
  hidden check passed, but this is not completion-gated autonomous task success.
- **ForgeGreen, subagents, Planner:** Deterministic mechanisms exist. Live efficiency, crossover,
  and planning-quality claims have no qualifying measurements.
- **8-Bit:** Current free-route preflight worked. Adaptive health, quota, and role behavior in a
  real multi-task run has not been demonstrated.
- **ForgeVerify:** Deterministic acceptance and process-cleanup paths passed previously. This live
  run used separate visible/hidden checks, so it cannot certify ForgeVerify in production.
- **Context and memory:** One live context invalidation/refresh worked. Long-session growth and
  cross-session memory value are unmeasured.
- **Tools, browser, terminal, Git/GitHub:** Four tool calls succeeded in the last live run. Tool
  selection efficiency and the browser, terminal, and repository flows in the packaged app remain
  unproven.
- **Recovery, endurance, performance, UX:** Local deterministic recovery and synthetic performance
  evidence is strong. Packaged startup failed before interrupted work, sustained use, hardware
  responsiveness, or developer-facing clarity could be observed.

## Required to lift the verdict

1. Demonstrate a truly bounded free route whose per-response output limit is enforced, then pass
   a live workflow through `evaluateCompletion` with independent verification.
2. Run the staged 15–30 minute, 60–90 minute, then multi-hour mixed-workload sessions with
   provider, context, tool, recovery, and resource receipts. Measure ForgeGreen and subagent A/B
   only on matched tasks.
3. Resolve and re-test the renderer launch failure with production security unchanged; build and
   audit final bytes, then run full, interrupt, recover, and realistic multi-task packaged smoke.
4. Capture repeated primary Windows hardware measurements and a second portable profile only if
   another device becomes available. Rerun affected regression and source recertification gates
   after any product fix.

The protected golden-task JSON was not staged, changed, regenerated, or committed during this
continuation. No production push, deployment, paid inference, or local LLM inference was used.
