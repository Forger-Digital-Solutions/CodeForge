# CodeForge R75 Final Report

**Status: `CODEFORGE_R75_PARTIAL`**

R75 delivered the Planner contract repair and shared hourly capacity controls, and the Windows packages passed all three packaging audits at the earlier implementation commit. This continuation fixed a Windows workspace-path bug that made complete Reviewer snapshots appear incomplete. A bounded production task then reached the Coder but stopped on Cohere’s model-scoped 429 before editing or review. Current alternate-route probes did not produce an admissible second Coder. No task completion, completion streak, or organic Coder failover is claimed.

## Repository

- Branch: `codex/r75-reliable-free-autonomous-coding`
- Worktree: `G:\CodeForge\worktrees\r75-reliable-free-autonomous-coding`
- R74 baseline: `230510131f40532ad8a402bdef131c3b8c637436`, aligned with the R74 remote branch at start.
- Implementation commit `8899a028681e5bbf5a57af78c138cfe58dbc4f71` is pushed to the R75 branch; this report and the live evidence are included in the follow-up branch update.
- R74 historical evidence remains intact. The ten-attempt classification is in [R75-R74-ROOT-CAUSE-CLASSIFICATION.json](R75-R74-ROOT-CAUSE-CLASSIFICATION.json).

## Changes delivered

- Added bounded deterministic Planner repair in [planner-contract-repair.ts](../../../packages/server/src/planner-contract-repair.ts). It restores explicit request clauses and runtime verification commands, adds missing mandatory Coder/Reviewer roles when their source requirements are authoritative, and links the Reviewer to all implementation tasks. Duplicate identities, missing dependencies, cycles, and constraint overflow remain fail-closed for the existing single correction attempt.
- Wired repairs into [autonomous-orchestrator.ts](../../../packages/server/src/autonomous-orchestrator.ts) and records each repair as run evidence. A recoverable missing Reviewer now completes the production lifecycle with one Planner call instead of paying for a correction call.
- Corrected BlockRun catalog admission in [blockrun-free.ts](../../../packages/providers/src/blockrun-free.ts): catalog membership is availability evidence, an explicit `available: false` still rejects the model, and explicit zero-cost checks remain required. The official catalog lists currently available models. [BlockRun model catalog](https://blockrun.ai/docs/api-reference/models)
- Extended [capacity-governor.ts](../../../packages/providers/src/capacity-governor.ts) with shared per-provider hourly request accounting, parsing of request limit/remaining/reset headers, model-scoped 429 cooldowns, and a conservative one-minute cooldown when reset information is absent. Kilo is capped at 190/hour and BlockRun at 28/minute and 285/hour, below the published gateway allowances. [R74 capacity evidence](../r74-autonomous-completion-and-free-reliability/R74-FINAL-REPORT.md), [BlockRun rate limits](https://blockrun.ai/docs/rate-limits)

Quota history remains in memory and resets on a full server-process restart. The shared governor remains active across child-worker interruptions within one server process; this change does not add cross-process quota-state persistence.

## R74 failure findings

The 10 attempts ended with 3 completed, 1 failed, and 6 blocked; longest completion streak was 1 and false completions were 0. The largest product defect was avoidable Planner contract rejection: a missing Reviewer caused an authorization failure, and a small feature’s explicit “do not mutate input or modify tests” requirement was absent from structured planning intent. Other blocks came from Planner cancellation with unresolved underlying trigger and real Kilo/Cohere rate limits. A test-creation task correctly stopped when every alternate route was role-ineligible.

The R75 unit regression mirrors the R74 feature plan and shows the original exact constraints and verification commands are retained, while the Reviewer is linked to both Coder tasks. This is fixture evidence, not a live task completion.

## Validation

- The forced workspace typecheck and full workspace `npm run build` passed again after the Reviewer path fix. The desktop main and renderer also rebuilt; the renderer emitted its existing large-chunk advisory.
- Server dependency-graph compile after the final Planner edit passed.
- `npm run security:gate` passed after the new evidence and qualification scripts were added.
- Focused tests passed: Reviewer evidence 14/14, Planner repair 5/5, capacity governor 26/26, BlockRun adapter 12/12, and end-to-end deterministic Planner repair 1/1. Machine-readable Vitest results are in this directory.
- The R75 campaign and new Kilo qualification scripts passed `node --check`; current machine-readable evidence JSON parsed successfully.
- The full autonomous-orchestrator file produced 24 passes and one 30-second timeout with a Windows temporary Git cleanup lock. The timed case passed alone with a 60-second limit. The first run is not counted as 25/25 in one invocation.
- After the pushed R75 commit, the desktop main and renderer rebuilt successfully with the matching commit identity. The Windows package and all three post-package audits passed; details and artifact hashes are in [R75-WINDOWS-PACKAGING.json](R75-WINDOWS-PACKAGING.json).

## Free supply and live reliability

- BlockRun terms, privacy, and rate-limit policy checks passed, and the public catalog returned Poolside Laguna XS 2.1 as explicitly Free and coding-capable during qualification. Availability varied across catalog checks.
- The bounded compact suite dispatched two synthetic requests to `poolside/laguna-xs-2.1`. The read/tool probe returned the requested model and passed. The edit probe response identified itself as `nvidia/nemotron-3-super-120b`; the adapter classified this as `MODEL_SUBSTITUTED`, kept every role `NOT_TESTED`, and did not promote Poolside. The later [live catalog snapshot](R75-LIVE-CATALOG-CHECK.json) found no row for the substitute and no currently available Free coding model. The request receipts are [blockrun-compact-1791638168218.json](blockrun-compact-1791638168218.json) and [its request observations](blockrun-compact-observations-1791638168218.json). A preceding [catalog-only check](blockrun-compact-1791638141240.json) stopped before inference because Poolside was then unavailable.
- The live requests used anonymous public Free endpoints, with no payment credentials; money spent was `$0` and purchased credits consumed were `0`.
- There are 28 exact, instrumented Free provider request attempts across the known R75 probes and the post-fix task: one AI Horde facade request, two earlier BlockRun qualification requests, five native AI Horde requests, four Kilo Ultra requests, and 16 post-fix campaign frames. This is not the total for R75 because the earlier campaign retained 31 model-turn rows without physical request frames. The total physical request count and requests-per-completion metric therefore remain incomplete and undefined.
- The new BlockRun route did not qualify as a Coder. The R75 task campaign therefore used the already-qualified Kilo Coder while separately requiring its qualified Kilo Reviewer route. No additional Coder, three-completion streak, or organic cross-provider failover is demonstrated. Completion acceptance criteria were not relaxed.

## R75 production task campaign

- The campaign used the production autonomous-run orchestrator on public synthetic fixtures and declared the sequence bug fix, feature, refactor. It attempted the first two tasks and stopped under its two-consecutive-noncompletion quota rule.
- Both runs reached the qualified Kilo Coder and changed the fixture workspace, then blocked at `REVIEWER_FAILED`: the Reviewer admission report marked the only qualified route `ROLE_VERDICT_EXCLUDED`. Neither independent review nor ForgeVerify/integration ran. Both runs ended `blocked`; completed tasks: `0/2`. The exact task and route-decision evidence is in [R75-TASK-CAMPAIGN-1791640869690.json](R75-TASK-CAMPAIGN-1791640869690.json).
- A later diagnostic-only run admitted the Kilo Ultra Reviewer route without inference, but did not attach a complete workspace evidence binding and therefore did not exercise the text-review evidence gate. The subsequent path-alias reproduction explains the original task denials; the diagnostic itself remains a role-admission-only check: [R75-TASK-CAMPAIGN-1791641410733.json](R75-TASK-CAMPAIGN-1791641410733.json).
- The original task campaign recorded 31 `agent_model_turn` rows, no inference frames, and zero requests in the provider-level governor report. Production dispatch accounts through quota-domain governors; the original harness read only the parent counter and wrapped tracing outside the governed adapter, which the execution layer unwraps. The harness now traces inside the governor and records quota-domain reports. The old run's request counters cannot be reconstructed from those missing frames, so no empirical capacity total is claimed for it.
- No third task was dispatched after the two blocks. The run supplies no completion streak, independent-review pass, cross-provider recovery, or reliability win.
- Root cause for the Reviewer denial: the original Windows workspace was recorded with an 8.3 short-path alias, but per-file `realpath` returned long paths. The mismatch made the otherwise complete snapshots `complete: false`, so the text-only Reviewer was correctly excluded. Root canonicalization now occurs before snapshot containment and stale-state checks; per-file symbolic-link rejection remains intact. The exact reproduction and regression are in [R75-REVIEWER-PATH-ROOT-CAUSE.json](R75-REVIEWER-PATH-ROOT-CAUSE.json); [the focused suite](../../../packages/server/test/r73-reviewer-evidence.test.ts) passed 14/14 ([test receipt](r75-reviewer-evidence-tests.json)).
- One post-fix production task then ran on public synthetic code after live policy checks passed. It blocked at `PROVIDER_RATE_LIMITED` from `cohere/north-mini-code:free`; the upstream message reported a 15-requests-per-minute model limit. It used 16 recorded provider frames: 10 Explorer turns on Kilo, one Planner turn on BlockRun, and five Coder turns on Kilo; the last request received HTTP 429. No file changed; independent review, ForgeVerify, and integration did not run. The raw evidence is [the campaign](R75-TASK-CAMPAIGN-POST-REVIEWER-FIX-1791642500000.json), with [a hash-bound physical request reconciliation](R75-CAPACITY-RECONCILIATION-1791642500000.json).
- The campaign’s first saved governor report showed zero because its reporter looked for quota-domain IDs in route-health rows instead of the persisted model-turn rows. The reporting code now looks up each quota-domain child governor from `agent_model_turn.quotaDomainId` and records raw-frame request counts. The old process ended before those child governor snapshots were saved, so only the 16 raw frames can be used for that run’s physical request count.

## AI Horde alternate-route attempt

- The first bounded probe used AI Horde's OpenAI-compatible facade and sent one synthetic request for `google/gemma-4-31b`. The facade returned HTTP 500; no qualification role completed and the route was not promoted. The request and response observation are in [the compact result](ai-horde-compact-1791639848993.json) and [its observations](ai-horde-compact-observations-1791639848993.json).
- The adapter now targets AI Horde's documented native asynchronous text API. It exposes only the active `google/gemma-4-31b` row, uses the official Gemma 4 prompt and function-call format, requests trusted workers and validated backends, rejects context overflow, and requires the response's served-model name to match exactly. The provider definition records the native API style and official anonymous route. [AI Horde integration API](https://github.com/Haidra-Org/AI-Horde/blob/main/README_integration.md), [Gemma 4 prompt format](https://ai.google.dev/gemma/docs/core/prompt-formatting-gemma4), [Gemma 4 function calling](https://ai.google.dev/gemma/docs/capabilities/text/function-calling-gemma4)
- Focused adapter tests passed 12/12 and the model-registry community-route tests passed 6/6. TypeScript build references for `model-registry` and `providers` passed. The machine-readable adapter test result is [here](ai-horde-adapter-tests.json).
- Two native qualification preflights stopped before inference because the worktree could not resolve `aihorde.net` (`ENOTFOUND`): [first attempt](ai-horde-compact-1791640441393.json) and [diagnostic retry](ai-horde-compact-1791640483076.json). A later official status request reached HTTP 200 but found only four workers, two active jobs, 1,012 queued jobs, and a 14-minute ETA; the harness stopped with zero inference requests ([live status](ai-horde-compact-1791640571274.json)). The only inference attempt on this candidate remains the earlier facade HTTP 500. Community workers can technically see prompts, so the probes used only the public synthetic fixture; no workspace files, credentials, or purchased kudos were sent.
- The native adapter is implemented but the route remains unqualified. AI Horde has not performed production coding work in R75, and it provides no evidence for an additional qualified Coder, completion streak, or organic failover. No success is inferred from unit fixtures or a catalog/status snapshot.
- A later official queue check found four Gemma 4 workers, zero active jobs, and zero queued jobs. The bounded compact run used five anonymous requests; `google/gemma-4-31b` qualified only as Analyst, while Coder and Tool Agent remained `NOT_QUALIFIED`. The route remains unavailable for coding: [qualification receipt](ai-horde-compact-1791642389524.json).

## Additional Free Coder qualification attempts

- A bounded, exact-model compact run checked Kilo’s already-Reviewer-qualified `nvidia/nemotron-3-ultra-550b-a55b:free` model. The tool-call and edit probes passed, but its structured-output request returned an NVIDIA upstream HTTP 503 (“temporarily overloaded”). The receipt is globally transient (`qualificationState: NOT_QUALIFIED`), so its partial Coder result is not admitted. Four anonymous requests were sent; no credentials or private workspace data were used: [receipt](kilo-ultra-compact-1791642584336.json) and [observations](kilo-ultra-compact-observations-1791642584336.json).
- BlockRun’s current public catalog briefly listed `poolside/laguna-xs-2.1` as explicitly Free and coding-capable. The bounded qualification check immediately afterward found the exact model absent and sent zero inference requests. Its earlier exact-model test had returned a different served model on the edit probe. No Poolside role is promoted: [current check](blockrun-compact-1791642692191.json). The live catalog’s availability varied across these checks.
- The 15-request-per-minute Cohere limit and NVIDIA’s transient overload are different upstream observations, but Kilo’s gateway and source-IP allowances remain shared. No quota multiplication or credential rotation is assumed. Kilo’s official [free-model guidance](https://kilo.ai/docs/getting-started/using-kilo-for-free) states that free models may have upstream rate limits; its [usage and billing page](https://kilo.ai/docs/gateway/usage-and-billing) identifies the shared per-IP free-model limit.

## Windows packaging

- The R75 desktop main and renderer rebuilt at commit `8899a028681e5bbf5a57af78c138cfe58dbc4f71`.
- `electron-builder --win` completed from the R75 worktree and produced the Setup and Portable artifacts under `apps/desktop/release`.
- Internal dependency, runtime dependency, and build identity audits passed. The archive identity matched the R75 commit, and the runtime audit scanned 416 modules and 26 external packages.
- Both generated executables are unsigned (`Authenticode: NotSigned`). Neither was executed or installed. The artifacts are for review only; installed lifecycle certification remains incomplete.

## Primary-checkout artifact incident

The first packaging invocation accidentally used `G:\CodeForge\apps\desktop` instead of the R75 worktree. It refreshed the primary checkout’s ignored `apps/desktop/release` outputs, including its existing Setup and Portable executables. The primary checkout already had unrelated tracked and untracked changes; this run did not intentionally edit its source files. The prior ignored package binaries were not backed up and cannot be restored from this run. The final audited R75 packages were built separately under the R75 worktree. This incident is recorded here so the primary-checkout artifact change is explicit.

The detailed checks and receipts are summarized in [R75-VALIDATION.json](R75-VALIDATION.json). The status remains partial because exact-model Free Coder qualification and the live completion/failover gates remain unmet.
