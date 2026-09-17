# CodeForge R8 intelligence and routing certification — 2026-09-17

## Overall verdict

`CODEFORGE_R8_INTELLIGENCE_CAMPAIGN_PARTIALLY_BLOCKED`

CodeForge's deterministic engineering baseline is healthy and it now has a frozen, executable CodeForgeBench R1 manifest plus a simulation-only GEMS Auto framework. One real OpenRouter free coding route is compact-qualified. The campaign cannot yet certify autonomous coding success rates, Free Auto against fixed selection, Paid Auto economics, live topology quality, or a new 8-Bit training improvement because the necessary verified task-run evidence or paid-credit authority is absent.

## Starting state and reconciliation

R8 began at `41e0102d1a860107a6741026944b369ea4eeaa42` on `forger-digital-solutions-forgegreen-certified`, with the R7 verdict `CODEFORGE_R7_ENGINEERING_READY_EXTERNAL_GATES_REMAIN`. The inherited R6/R6.1/R7 worktree was preserved; its recorded state was 210 tracked changes, six untracked paths, and two removals. R8 reconciliation and ownership are in [r8-reconciliation-2026-09-17.json](../evidence/r8-intelligence-benchmark/r8-reconciliation-2026-09-17.json).

## CodeForgeBench R1 and pre-optimization baseline

CodeForgeBench R1 freezes 24 solution-neutral cases: two each for repository understanding, small fixes, multi-file engineering, debugging, test repair, regression prevention, large repositories, context pressure, verification resistance, recovery, tool efficiency, and routing difficulty. It spans trivial through very-hard work, requires independent verification, and records tokens, context, provider/tool calls, retries, timing, cost, topology, and routing.

The machine-readable [pre-optimization manifest](../evidence/r8-intelligence-benchmark/results/codeforge-bench-r1-pre-optimization.json) contains zero claimed model-task successes. That is intentional: R7's Groq live topology was blocked and R8 did not manufacture runs with paid models. The success rate is therefore `null`, not 0% or a pass. `node scripts/r8-codeforge-bench.mjs --attempts=<sanitised-json>` is the durable scorer for future verified attempts.

## Model, Free Auto, Paid Auto, and GEMS Auto

- OpenRouter discovery found 24 verified zero-unit candidates, 20 tool-capable. `cohere/north-mini-code:free` passed all compact tool-call, edit, and structured-output checks in three requests / 6,415 ms, qualifying it for `CODER`, `TOOL_AGENT`, and `ANALYST` in that compact suite.
- Groq authenticated and returned transport success for `openai/gpt-oss-20b` and `openai/gpt-oss-120b`, but both yielded empty completion text. They remain unqualified; no paid/BYOK fallback occurred.
- Cloudflare Workers AI withheld inference because the neuron guard could not obtain trustworthy daily usage. This correct fail-closed result is not a model failure score.
- OpenAI's non-billing models endpoint was available. No Paid Auto request was made, so the mandated four-model Paid Auto roster has no R8 capability, cost, or router-performance claim.
- The new GEMS Auto framework selects synthetic/frozen-nonproduction capability profiles by role but is hard-coded to `simulation_only`; unfinished profiles are excluded and no provider adapter exists. Its synthetic topology tests pass. It certifies decision machinery only, not any GEMS model.

Raw provider evidence is in [provider-probe-summary-2026-09-17.json](../evidence/r8-intelligence-benchmark/provider-probe-summary-2026-09-17.json).

## 8-Bit

The existing R3.5 dataset is versioned, split-frozen, provenance-controlled, and GPU-trained; it contains 469 structured rows with a protected holdout. Its learned artifact remains `8BIT_EXPERIMENTAL`: on the temporal route-outcome holdout, deterministic accuracy was 1.0, learned accuracy 0.0, hybrid accuracy 0.857, and learned Brier score 1.335. Critical false-free classifications were 0, but the learned artifact did not add measurable value.

No R8 retraining was justified: there is no new, sufficiently broad verified execution corpus, and repeating training would not answer the evidence deficit. The current answer is **no** — 8-Bit is not yet intelligent enough to manage the managed-free ecosystem reliably by learned inference. The deterministic ForgeZero/8-Bit policy stack remains the authority; the learned model is experimental. See [8bit-r35-specialist-model-report.md](../8bit-r35-specialist-model-report.md) and its protected [shadow report](../../tests/evidence/r3.5-8bit-model-v1/shadow-report.json).

## ForgeGreen

The FG-8 workload suite ran eight deterministic workloads (including a real repository-intelligence-shaped integration workload, but no network calls). Candidate A reduced tool calls from 31 to 27 (4 calls / 12.9%) with the same verification outcome and reduced measured wall time by 60 ms. This is valid mechanism evidence, but it does **not** establish live-provider token, cost, or autonomous-task completion savings. The honest answer is: ForgeGreen has demonstrated bounded fixture savings without verification regression, while meaningful live savings remain unmeasured. See [forgegreen-r8-observation-2026-09-17.json](../evidence/r8-intelligence-benchmark/forgegreen-r8-observation-2026-09-17.json).

## Repository intelligence, topology, verification, and resilience

Repository-intelligence, completion-gate, recovery, routing-boundary, subagent, and ForgeVerify behavior are exercised by the full deterministic suite. The R7 Groq topology run remains `blocked`: two explorers and a planner were cancelled at the 90-second phase boundary with zero tool events and zero verified change. This is retained as a failed/inconclusive live topology result, not counted as a successful autonomous task. A live Free Auto vs fixed-route comparison requires a qualified multi-task route.

The completion gate remains the sole authority for `completed`; benchmark case `CBR1-VR-02` and the existing negative-path suite preserve the requirement that unverified/no-change work is blocked rather than successful.

## Installer, PostgreSQL, OAuth, and signing

- **Installer — BLOCKED.** Current configuration is stable (`appId: app.codeforge.desktop`, `CodeForge`, NSIS one-click, version 0.3.0), but safely reproducing the Electron-33-to-44 upgrade requires a disposable known-old installation and a release version/upgrade policy decision. The old uninstaller was not run against user software.
- **PostgreSQL — BLOCKED.** `CODEFORGE_TEST_POSTGRES_URL` is absent, so the 36 real-DB tests remain skipped. No mocks substituted for them.
- **OAuth — BLOCKED.** R7's development endpoint `http://127.0.0.1:3220` remained unreachable; Chrome was not opened because there was no live authorisation endpoint to exercise.
- **Signing — BLOCKED.** Setup EXE, portable EXE, and unpacked EXE are `NotSigned`; no signing identity was available.

## Final engineering gate

| Gate | Result |
| --- | --- |
| Lint | PASS — 0 errors / 0 warnings |
| Typecheck | PASS |
| Workspace build | PASS |
| Full test suite | PASS — 348 files, 2,585 tests, 0 failures, 0 errors, 36 real-PostgreSQL skips; JUnit duration 1,833.96 s |
| Production dependency audit | PASS — 0 vulnerabilities |
| Package closure | PASS — 22 internal packages, 280 runtime modules, 15 external packages |
| Electron security | PASS |
| Packaged auth-endpoint audit | PASS (development manifest) |
| Secret scan | PASS — filename-only credential-pattern scan found expected code/docs identifiers; no credential-shaped literal was found in scanned production paths |

## Scorecard

| Area | Status | Evidence |
| --- | --- | --- |
| Core engineering | PASS | Full deterministic gate |
| AgentRuntime / ForgeVerify | PASS | Completion/recovery contract coverage |
| Repository intelligence | PARTIAL | Deterministic coverage; no new live large-repo run |
| Subagents | PARTIAL | Deterministic pass; Groq live topology blocked |
| ForgeAuto / Free | PARTIAL | One OpenRouter route qualified; comparative benchmark pending |
| Paid Auto | BLOCKED | No paid inference authority or economics evidence |
| GEMS Auto framework | PASS | Simulation-only role planner; unfinished exclusion test |
| 8-Bit | PARTIAL | Deterministic authority pass; learned artifact experimental |
| ForgeGreen | PARTIAL | Fixture tool savings; live economics unmeasured |
| Provider resilience | PARTIAL | OpenRouter qualified; Groq empty, Cloudflare fail-closed |
| PostgreSQL | BLOCKED | No authorised endpoint |
| OAuth | BLOCKED | Hosted endpoint unavailable |
| Installer | BLOCKED | Upgrade matrix requires disposable legacy installation/policy |
| Windows signing | BLOCKED | No signing identity |
| Release readiness | BLOCKED | External gates and installer proof remain |

## Evidence-driven next work

1. Run CodeForgeBench R1 against the newly qualified OpenRouter route in isolated fixture worktrees, retaining all failures and independent acceptance results.
2. Restore Groq text-completion behavior and trusted Cloudflare daily usage, then compare Free Auto against fixed routes on the same cases.
3. Collect at least hundreds of real, verified, decision-time routing outcomes before creating a new 8-Bit training dataset; retain the current deterministic production authority.
4. Provide a disposable PostgreSQL endpoint, hosted OAuth deployment, signing identity, and disposable Electron-33 installation to close the remaining external/release gates.
