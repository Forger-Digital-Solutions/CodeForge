# CodeForge R9 capability and competitive certification — 2026-09-17

## Verdict

`CODEFORGE_R9_CAPABILITY_CAMPAIGN_BLOCKED`

This is a truthful R9 campaign checkpoint, not a claim of autonomous-agent parity. R9
reconciliation succeeded and CodeForgeBench R2 measurement infrastructure is frozen, but no
independently verified R9 model executions or authorized external-agent comparisons are recorded.
Consequently, capability deltas, Free Auto superiority, Paid Auto economics, live ForgeGreen
savings, learned 8-Bit improvement, and competitive classifications remain unproven.

## Scope and starting state

- Repository: `G:\CodeForge`
- Branch: `forger-digital-solutions-forgegreen-certified`
- HEAD: `2f646ad1054e703b2d99921acc99c6740c3fb175`
- Worktree: clean at reconciliation
- Node: `v24.19.0`
- Electron: `44.4.1`
- R8 authoritative report: [R8 certification](../certification/codeforge-r8-intelligence-and-routing-certification-2026-09-17.md)
- Reconciliation evidence: [r9-reconciliation-2026-09-17.json](../evidence/r9-capability-campaign/r9-reconciliation-2026-09-17.json)

GEMS is explicitly out of scope. No GEMS model, prompt, route, or production behavior was
modified. Existing simulation-only exclusion remains the only permitted GEMS state.

## CodeForgeBench R2

R2 preserves all 24 R1 case IDs and adds 24 cases across complex debugging, test creation,
architecture understanding, long-horizon work, ambiguous tasks, provider failures, adversarial
verification, Git safety, security-sensitive work, subagent cooperation, planning, and reviewer
quality. The 48-case manifest has explicit TRAIN, DEVELOPMENT, VALIDATION, and PROTECTED_TEST
partitions and requires run/commit/config/timestamp/independent-verification traceability.

The R2 scorer counts only completed, independently verified, non-rejected attempts. It reports
pass@1 and false completions separately. The no-execution R9 PRE baseline is recorded at:

[CodeForgeBench R2 PRE](../evidence/r9-capability-campaign/results/codeforge-bench-r2-pre.json)

Its success rate is `null` because no model executions are present; this is not a 0% capability
claim.

The R9 milestone engineering gate passed with 343 test files passed, 7 skipped, 2,556 tests
passed, and 36 skipped; there were 0 failures. The added benchmark package build and full
typecheck passed, changed-file lint passed with 0 warnings, and `git diff --check` passed. The
repository's npm launcher is unavailable because its global npm CLI module is missing, so the
equivalent local TypeScript, Vitest, and Oxlint binaries were invoked directly. No dependency
was added or changed.

## Evidence status

| Area | R9 status | Evidence-based conclusion |
| --- | --- | --- |
| R9 PRE model benchmark | BLOCKED | No independently verified model attempts recorded |
| R9 POST protected benchmark | NOT TESTED | No protected run performed |
| Failure corpus | IMPROVED | Sanitized, bounded corpus contract and seed conversion added |
| OpenRouter roster | PARTIAL | R8 compact-qualified `cohere/north-mini-code:free`; deeper R9 qualification not run |
| Groq | BLOCKED | R8 empty completions remain unexplained and unqualified |
| ForgeAuto / Free | NOT TESTED | No fixed-route versus adaptive verified comparison |
| Paid Auto | BLOCKED | No paid inference or economics authorized/executed |
| ForgeGreen | PARTIAL | R8 fixture result remains 12.9% fewer calls; live generalization unmeasured |
| Learned 8-Bit | EXPERIMENTAL | R8 evidence says it did not beat deterministic policy; no R9 retraining justified |
| Deterministic 8-Bit | PASS | Existing policy authority and fail-closed boundary preserved |
| Subagent topology | PARTIAL | Deterministic contracts exist; live topology value unmeasured |
| External comparison | NOT TESTED | No authorized OpenCode, ZCode, Codex, or Claude Code evidence |

## Competitor matrix

| Capability | CodeForge Pre | CodeForge Post | OpenCode | ZCode | Codex | Claude Code | Gap |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Repository understanding | PARTIAL, deterministic coverage only | NOT RUN | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | INCONCLUSIVE |
| Planning | NOT TESTED live | NOT RUN | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | INCONCLUSIVE |
| Multi-file coding | NOT TESTED live | NOT RUN | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | INCONCLUSIVE |
| Debugging and recovery | PARTIAL deterministic coverage | NOT RUN | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | INCONCLUSIVE |
| Verification reliability | PASS for completion-gate contract | NOT RUN | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | INCONCLUSIVE |
| Routing/provider independence | PARTIAL; one compact-qualified free route | NOT RUN | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | INCONCLUSIVE |

No capability classification is assigned where a matched external run is unavailable.

## Required R9 questions

### Is learned 8-Bit measurably better than the R8 artifact?

No R9 training or protected evaluation was run. R8's learned artifact remains experimental and
deterministic policy remains authoritative. No decision category graduates.

### Does the 12.9% ForgeGreen fixture reduction generalize?

Unknown. R8 measured 4 fewer tool calls out of 31 (12.9%) with unchanged fixture verification.
There are no R9 live-agent measurements for tools, tokens, requests, latency, cost, or free quota.

### Is ForgeAuto/Free better than a fixed free route?

Unknown. A matched verified comparison was not run.

### Does Paid Auto justify itself?

Unknown and blocked. No paid inference, cost-per-success, or authorized four-model roster run was
performed.

### Which topology is best for which task class?

Unknown from live evidence. Existing deterministic topology and subagent contract tests do not
establish task-level value.

## Release blockers

| Issue | Classification | Current state |
| --- | --- | --- |
| PostgreSQL target and 36 real-DB tests | infrastructure | BLOCKED; endpoint unset |
| Groq usable completion | provider | BLOCKED; authenticated empty completions |
| Hosted OAuth endpoint | authorization/infrastructure | BLOCKED; endpoint unavailable in R8 and no R9 endpoint configured |
| Electron legacy upgrade proof | product/infrastructure | BLOCKED; disposable Electron-33 installation and upgrade matrix unavailable |
| Windows production signing | certificate/signing | BLOCKED; signing identity unavailable |
| Deterministic engineering baseline | resolved | R8 full gate passed: 348 files, 2,585 tests, 0 failures/errors, 36 PostgreSQL skips |

## Scorecard

| Area | Status |
| --- | --- |
| Core engineering | PASS (R8 baseline) |
| Autonomous coding | BLOCKED |
| Repository understanding | PARTIAL |
| Planning | NOT TESTED |
| Coding | NOT TESTED |
| Debugging | PARTIAL |
| Reviewing | NOT TESTED |
| ForgeVerify | PASS |
| Context management | NOT TESTED |
| Tool efficiency | IMPROVED (measurement contract only) |
| Subagents | PARTIAL |
| Adaptive topology | NOT TESTED |
| ForgeGreen | PARTIAL |
| 8-Bit deterministic | PASS |
| 8-Bit learned | EXPERIMENTAL |
| OpenRouter free roster | PARTIAL |
| Groq | BLOCKED |
| ForgeAuto / Free | NOT TESTED |
| Paid Auto | BLOCKED |
| BYOK isolation | PASS (R8 evidence) |
| PostgreSQL | BLOCKED |
| OAuth | BLOCKED |
| Installer | BLOCKED |
| Windows signing | BLOCKED |
| OpenCode comparison | NOT TESTED |
| ZCode comparison | NOT TESTED |
| Codex comparison | NOT TESTED |
| Claude Code comparison | NOT TESTED |
| Release readiness | BLOCKED |

The next authorized step is to run isolated R2 public cases against the already qualified free
route, then populate the failure corpus and run the protected split only at a milestone boundary.

## R9.1X FULL-SYSTEM GREEN CAMPAIGN

**Verdict: `CODEFORGE_R9_MATERIAL_CAPABILITY_GAPS_REMAIN`.** R9.1X fixed durable final-response persistence for direct and completion-gated workflow runs, added safe model-selection readback, and made packaged smoke create its configured output root. A real verified-free OpenRouter dogfood task repaired and verified a disposable project through HTTP/SSE, approval, steering, ForgeVerify, the completion gate, reconnect, and durable final-response reconstruction.

No 40-case LIVE PRE/POST or protected score is claimed: the current R2 runner aggregates supplied attempts and the historical PRE has zero executions. The fresh Electron 44 Windows package fails its sandboxed renderer launch; real PostgreSQL, OAuth/browser, signing, and competitive gates remain open. Full evidence and the required scorecard are in `docs/evidence/r9-capability-campaign/live/r9.1x-full-system-green-campaign-2026-09-17.md`.
