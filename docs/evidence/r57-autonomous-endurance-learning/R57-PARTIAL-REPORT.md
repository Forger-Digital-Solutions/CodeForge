CODEFORGE_R57_BLOCKED

# R57 partial report — experience foundation and bounded torture

R57 is **not closed**. The foundation and selected deterministic/live/packaged probes below are real, but the required multi-class autonomous endurance, repeated kill/resume campaign, accounting fault campaign, and isolated CodeForge self-dogfood have not been proven. The guarded certificate is named `r57-experience-foundation-v4` deliberately; it is not an R57 closure certificate.

## Repository and certification

- Start: `codex/r29-release-closure` at `09779a41eb82820eb2d9318cbfc9156fc6ec8e08`; the only pre-existing dirty file was the unrelated R34 `context-efficiency-benchmark.json`, left untouched.
- R56 handoff independently recomputed: 60 material files, hash `934a07bc2c0bcd506d8307817be5daf23185afcbb679e5896ba5493b06b41b9e`; focused baseline 41/41 tests, including the 8 source-state canaries.
- R57 foundation HEAD at this report: `65a43517616b6c490537bfff94cd6219bcf43aee`. Eight logical implementation/certificate commits follow R56. Current guarded source-state: 62 material files, `r57-experience-foundation-v4`, hash `5b139a060e743b2866a232e6e57dd7bc7ee380a8870c6c15c72affc87ef90bb0`. Its predecessor chain explicitly reaches R56. Post-certificate canaries: 8/8.
- The certificate covers `autonomous-orchestrator.ts`, `experience-learning.ts`, and `strategy-novelty.ts` plus subsequent reviewed corrections. It makes no endurance or release claim.

## Experience-learning substrate and privacy

- Terminal autonomous runs emit idempotent owner-local `autonomous_experience_receipt` work items and separate `generalized_experience_signal` work items. The local assembler reads only the owner session and matches worker kind, parent run, and session. Its route reference is a digest; generalized signals contain only enum, bucket, count, and role-class fields. They contain no prompt, source path, transcript, endpoint, credential, or raw model identity.
- `VERIFIED_SUCCESS` requires the ForgeVerify completion decision **and** integrated outcome. An unverified completion claim receives no positive label. The deterministic privacy/label proof is [foundation-proof.json](foundation-proof.json); a real live run persisted one local receipt and one generalized `VERIFIED_SUCCESS` signal in [live-experience.json](live-experience.json). The post-run projection reflects the production role-title fixes as explorer/coder/reviewer; it is marked separately from the originally persisted receipt.
- Recovery advice uses the last 100 comparable abstract signals, requires at least two strategy-exhaustion samples, and has bounded confidence. It only changes revision advice. `CODEFORGE_EXPERIENCE_ADVICE=off` disables this adaptive advice; the records remain inspectable/reconstructable. No runtime weight mutation or global source-content capture was added.
- A later-task orchestrator test seeds two prior abstract exhaustion signals under a different session and confirms the next revision receives independent-diagnosis advice while the completion gate still decides success. This is deterministic proof, not live learned-routing proof.

## Anti-loop and ForgeGreen

- Reviewer revision attempts now compare hashed target-file and failure-code signatures plus the worktree diff digest. The repeated-defect runtime test observes `LOW_NOVELTY_RETRY` on the second similar failure, sends causal reinspection advice, records the intervention, and ends the third repeat as `STRATEGY_EXHAUSTED` rather than claiming completion. A transient retry is classified separately and remains allowed within existing bounds. [foundation-proof.json](foundation-proof.json) contains the machine-readable classification trace.
- This gate covers the bounded autonomous reviewer-revision path. It does not yet cover all multi-run software hypotheses or prove that a new approach succeeds after escalation. Loop-break success rate and saved tokens remain unmeasured.

## Live autonomous task and Free Capacity Fabric

- One real managed-free autonomous coding task completed in **355.217 seconds**. Explorer: Groq 20b, 2 requests; Coder: OpenRouter `nvidia/nemotron-3-super-120b-a12b:free`, 19 requests; Reviewer: OpenRouter `nvidia/nemotron-3-ultra-550b-a55b:free`, 7 requests. The reviewer followed a real RATE_LIMITED chain across three Groq models before cross-provider failover. ForgeVerify ran the focused tests (2 pass, exit 0), an independent rerun passed, the completion gate returned `completed`, and the final fixture commit was `8802b92e709bd13af962c67a40238c53bacf3132` ([live-run.json](live-run.json)). This is one completed live task, not a multi-class endurance campaign.
- All 28 recorded Shilling entries in this run retained `UNKNOWN` source/confidence; no monetary amount was invented. A successful paid-accounting settlement or settle-once crash window was not exercised. Managed-free failover stayed within the offered free roster.
- Provider chaos/contract regressions: 267/267 tests across provider adapters, R56 model-scoped health, failover, and failure classification. These are deterministic fault cases; they do not establish live provider-concurrency scale.

## Concurrency and fairness

- [scale-campaign.json](scale-campaign.json) runs deterministic R20 scheduler simulations at 1/2/5/10/25 virtual users plus heavy-user and 429-failover cases. All 86 tasks across the five tiers completed; 0 simulated starvation events. The heavy-user case completed 74 tasks with 0 starvation events. The 429 case completed 50 tasks and recorded 15 route failovers. At 25 users, p95 simulated queue wait was 5,353 ms. These are virtual scheduler results only; no 25-user live-provider claim is made.

## Recovery, verification, and security

- Focused recovery/capacity suites: 37/37. ForgeVerify adversarial/integrity/stale-evidence suites: 74 passed, 1 skipped. The controlled revision-loop test and repeat packaged run both blocked false completion. The full adversarial attack expansion and a repeated phase-by-phase process kill/resume campaign remain open.
- The final secret scan reported 0 owner-review-required findings across 1,806 scanned files; dependency audit reported 0 blocking among 674 dependencies; public-claims and link gates passed ([security-gates.json](security-gates.json)); security tests 136/136. The final targeted privacy test and source-state canaries passed after the role-title precedence edit.
- Full TypeScript project build passed using `tsc -b --force`. Desktop renderer and Electron package rebuilt from the current source. The host's `npm` launcher pointed at a missing global CLI, so equivalent direct Node entry points were used for build/test/package steps.

## Packaged Windows

- Canonical unpacked Windows artifact: [CodeForge.exe](../../../apps/desktop/release/win-unpacked/CodeForge.exe), version 0.4.0, SHA-256 `70bbe4fd634f80f148f62254522675ed02a47bb360377026d9834eaefd2b414e`, build commit `65a43517616b6c490537bfff94cd6219bcf43aee`, `NotSigned`. Dependency graph, build identity, auth endpoint, and browser-security audits passed ([package-proof.json](package-proof.json)). The build identity reports dirty because evidence and the preserved R34 artifact were present.
- Full startup/workflow, interrupt (expected exit 73), and recover smoke passed. The packaged live free-model task passed once (20 free models discovered, file correct, workflow `completed`). An immediate second fresh packaged task changed the file correctly but **blocked**: the exact selected OpenRouter free model returned upstream 503 capacity, then became ineligible; independent goal review could not finish. Its verifier ultimately passed, but the completion gate correctly refused success. There was no paid-route selection ([packaged-repeat-diagnostic.json](packaged-repeat-diagnostic.json)). This is capacity/review failure under repeated use, not a successful repeated-task proof.
- Inside the tool process sandbox the same binary twice failed renderer child launch with exit 49; outside it, full/interrupt/recover/live smokes ran normally. The paired result isolates a test-environment process restriction. No production renderer security setting was weakened.

## Soak and resource telemetry

- The first soak attempt was invalid because its harness read a stale `runtime.json`; the harness now removes stale metadata, requires the PID to match the launched process, and fails if 401 liveness probes or process samples are absent. A corrected one-minute validation produced 6/6 expected 401 probes ([packaged-soak-1min.json](packaged-soak-1min.json)).
- The corrected packaged soak ran for 328.015 seconds including shutdown, with 10/10 expected 401 liveness probes, the main process alive throughout the five-minute budget, and 0 leftover processes after forced cleanup ([packaged-soak-5min.json](packaged-soak-5min.json)). Windows denied process-tree inspection, so the measured scope is **main process only**: sampled working set fell from 336.6 MB to 240.7 MB and handles from 1,142 to 1,126. This does not establish renderer memory behavior or task-level endurance.

## Open release gates

R57 remains blocked on the specified success standard: multiple distinct nontrivial live autonomous task classes; sustained task-level endurance; repeated process kill/resume at several durable boundaries; settle-once/unknown-usage accounting fault injection; real multi-user live-provider concurrency; broad failure-injection matrix; topology and correlated-reviewer comparisons; repeated packaged live completion despite provider churn; isolated CodeForge self-dogfood; and final full-round certification. No external blocker is claimed for work that was simply not executed. The OpenRouter 503 and unsigned binary are recorded as external conditions, with the product's fail-closed behavior proved for the observed cases.
