# CodeForge R58 final report

## Status: CODEFORGE_R58_BLOCKED

R58 implements a bounded progress-aware coder lease and makes the real R1 subagent path the packaged default. The source, deterministic tests, full regression, source canaries, package build, and package audits passed. Two approved packaged attempts reached the real R1 runtime, but neither free provider produced an eligible route or a model call. Both tasks failed closed with the isolated baseline unchanged. The required real packaged edits, tests, review, and ForgeVerify completion therefore remain unproven.

## Starting state and provenance

The primary checkout began at `cbae062c52f0bbc0723fb3832f316f0cff7a8504` with the documented R34 tracked change and R57 harness/evidence state preserved. The R57 v6 source-state ID was `16d40300ecc8b7c91e998239dcfd932847d13c8bf285a74e71501923ed84cc97` over 65 files; its canaries passed 8/8. The prior packaged executable SHA-256 was `1f3ac03fc8fc66654d3cb0dd9f9a3142166105dea09b746ee4825a216c17c130`. No CodeForge process was present at the start. R57's 600-second base plus two 120-second extensions was the fixed 840-second coder ceiling; the packaged R1 path required `CODEFORGE_SUBAGENTS_R1=true`.

The implementation, recertification, and test-fixture updates were committed separately as `ee0df08`, `7f16ed2`, and `3682da3`. The current certificate is `193a34dc933b27e917b728219c1f004fc86c87a27a0aadd7280dca50b5607830`, surface `r58-progress-aware-autonomy-v1`, with 68 material files. It adds desktop main, protocol subagent schema, and useful-progress classification to the material surface. [Source certificate](source-certificate.json) and [8/8 canary results](source-canaries-vitest.json) record the recertification. The certificate was not relaxed for test results.

## Runtime changes

- The coder keeps a 600-second base and 120-second observation window. Distinct successful tool effects earn extensions; duplicate reads/results, failures, denied calls, and model turns alone do not. Two quiet checks stop a stall. The default coder ceiling is 15 earned extensions, an absolute 2,400-second lease. Other roles retain the two-extension default. The coder's observed model-response latency and 25-turn budget can reduce the earned extension cap; existing anti-loop and tool budgets remain active. [Design record](WATCHDOG-DESIGN.md).
- Durable model-turn and worker records now include response latency, executor kind, useful progress, duplicate checks, extensions, and abort reason. A productive lease that reaches its ceiling creates an immutable checkpoint and permits one sequential continuation in the same isolated worktree. The new worker receives concise prior work and verification context. No continuation is granted for a stall, loop, cancellation, or worker without useful progress. The parent still requires reviewer, verifier, integration, and `evaluateCompletion`.
- The desktop explicitly enables R1; the server defaults to R1. An R1 worker without a real runtime fails closed. The old directory-listing/no-op coder cannot manufacture a coding success. [Packaged source audit](production-wiring.json) checked these properties in the built ASAR. It is a packaged-code audit, not proof of a live coding run.

## Verification results

| Gate | Result | Evidence |
| --- | --- | --- |
| Forced TypeScript and desktop build | Passed | [Package identity](package-build-identity.json) |
| Full canonical Vitest run, limited to two workers for Windows integration stability | 505 files passed, 8 skipped; 4,222 tests passed, 48 skipped; exit 0 | [Regression summary](full-regression.json) |
| Selected watchdog, continuation, production wiring, checkpoint, recovery, and ForgeVerify tests | 60/60 passed | [Test output](deterministic-torture-vitest.json) |
| Source-state and harness canaries | 8/8 passed | [Canary output](source-canaries-vitest.json) |
| Package dependency, auth endpoint, browser security, identity, and R1 wiring audits | Passed | [Package identity](package-build-identity.json), [wiring audit](production-wiring.json) |
| Secret, dependency, public claims, and link scans | Passed; 0 secret findings requiring owner review, 0 blocking dependency advisories | `final-*.json` in this directory |
| Deterministic torture matrix | Partial: controlled continuation, stall, cancellation, review, and verifier cases passed; full restart/migration gaps remain | [Torture matrix](torture-campaign.json) |
| Packaged live R57 failure-corpus task | Two real packaged runs; no eligible route/model call, no edits, failed closed | [OpenRouter receipt](packaged-self-dogfood-approved.json), [Groq receipt](packaged-self-dogfood-groq.json), [combined summary](packaged-live-summary.json) |

The rebuilt Windows executable is `apps/desktop/release/win-unpacked/CodeForge.exe`, SHA-256 `397fc1c2b602d12f8819b325f571ddfce5dd5982689c9274402bae2671651a01`, build commit `3682da3529a52969557f4f630031fdb244b300e9`. The build identity is marked dirty because the primary checkout contained preserved R34/R57 changes outside the R58 certified material surface. Material source matched the certificate and package audits passed, but a byte-for-byte clean-HEAD package build has not been established. The executable is unsigned.

## Packaged attempt and cleanup

The harness used a clean isolated worktree inside `G:\CodeForge` at unfixed baseline `3b8ffd3d9cb369fbff36897fe22d199de52403ba`, with the same R57 goal and acceptance probe. The real package ran with `CODEFORGE_SUBAGENTS_R1` unset. Both attempts created genuine `agent_runtime` subagent records. The OpenRouter run recorded 31 catalog entries but 8-Bit had no healthy role route; three observed free routes returned HTTP 429. The Groq catalog listed 11 models but its eligible sample was empty. Both runs ended with zero model turns, zero tool calls, no edits, and no completion receipt. The Groq run reached terminal status 148 seconds after the Builder's nominal 600-second wall budget. This is a watchdog/termination latency gap under route-unavailable conditions and remains for follow-up.

Both workspaces stayed clean at the unfixed baseline. The independent Vitest command could not resolve `node_modules` in the clean baseline worktree; the R58 harness now creates a temporary ignored junction for future runs and removes it afterward. The separate R57 acceptance probe failed on the known nested-metadata mutation defect, as expected for the unmodified baseline. Both managed worker worktrees were removed. The partial browser profile left after each process exit was removed manually from the R58 temp directory. No CodeForge process, R58 temporary directory, or baseline worktree remains. Pre-existing R57 prunable worktree metadata and unrelated worktrees were preserved. [Cleanup audit](cleanup-audit.json).

Automatic approval review initially rejected the OpenRouter transfer. The user then explicitly approved the isolated task context going to OpenRouter and, after its no-supply result, separately approved the same context going to Groq. These provider attempts ran within that approved scope. The remaining blocker is free-route availability and the observed runtime termination latency, not pending user approval.

## Remaining limits

- Useful progress is a bounded distinct tool-effect signal, not a full semantic proof. Distinct but irrelevant observations can consume a finite allowance. A sustained edit/revert loop has no dedicated R58 torture run.
- One sequential productive coder continuation is proven in process. Automatic resumption of a budget-expired parent across a process crash is unproven. Existing restart and checkpoint tests cover related recovery, not that exact path.
- The packaged runs produced real subagent lifecycle records but no model turns, edits, verification output, review, or completion receipt. Live latency, p50/p95, productive/stalled time, route transitions, token accounting, and success-path worktree metrics for the R58 task are unavailable. The receipts include package process samples and route/no-supply outcomes.
- Short 429 recovery on a pinned free route is tested. Mid-agent free-route migration is not established and should not be claimed.
- The package was built from a checkout with preserved non-material dirty files and is unsigned. A clean certified build is a release-readiness gap.

## Component gaps after R58

| Component | Next evidence gap |
| --- | --- |
| 8-Bit | Prove free route selection and role-quality adaptation in a completed packaged task. |
| 16-Bit | Prove its contribution to the same end-to-end autonomous task; no new R58 proof. |
| ForgeGreen | Correlate route latency and health with live watchdog decisions across several free routes. |
| ForgeVerify | Obtain a real packaged completion receipt; deterministic integrity and gate tests passed. |
| Subagents | Prove live default R1 execution and exact crash-time continuation ownership. |
| Context | Measure continuation-context sufficiency without re-reading or duplicate edits. |
| Memory | Measure whether durable experience improves a later comparable task without leaking repository details. |
| Browser/tool use | Torture repeated/no-op tool activity and permission boundaries in the packaged app. |
| GitHub integration | Establish live task, review, and integration evidence against a controlled repository. |
| Packaged autonomy | Complete the R57 failure-corpus task with real edits, tests, review, and gate receipt. |
| Free-capacity scalability | Measure 429/502 churn, route latency distributions, and bounded recovery under concurrent tasks. |
| Release readiness | Rebuild from a clean certified checkout, sign the artifact, and rerun package audits and live acceptance. |

The next engineering milestone is a clean certified package and an approved packaged self-dogfood campaign, followed by crash-time continuation and capacity-churn torture using that same task. Completion status remains `CODEFORGE_R58_BLOCKED` until the real packaged task crosses ForgeVerify successfully.
