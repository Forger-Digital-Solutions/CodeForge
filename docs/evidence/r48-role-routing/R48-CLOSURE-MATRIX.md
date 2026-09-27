# R48 Closure Matrix — Role-Aware Fleet Routing, Explorer Closure & No-False-Waiting

Baseline: `codex/r29-release-closure` @ `d4769e8`, certified
`r47-16bit-first-light-v1`. Implementation commits: `de8c4ab` through
`b6cc77c`. R48 paid spend: **$0.008722 of $0.25** (3.49%), all calls behind the
campaign gate and durable ledger.

## Role-aware routing

| Requirement | Status | Evidence |
|---|---|---|
| Free per-role qualification floor | DONE | `roleRouteFilter` and per-role qualification tiers reach bare routing and Free Fabric admission; QUALIFIED/PROBATION admitted, missing/current negative evidence rejected |
| Role capability contracts | DONE | CODER requires coding + tools; EXPLORER requires tools; deterministic role/Fabric tests green |
| Paid per-role evidence | DONE | `PaidRoleEvidenceBook` seeded from R47 receipts; canonical selection resolves by requested role |
| Paid sentinel resolution | DONE | `paid-auto/auto` resolves before dispatch; literal `auto` never reaches a provider |
| Paid-only failover | DONE | bounded retries and canonical rotation stay inside paid roster; no free substitution |
| Probation policy | DONE | deterministic paid/free tests plus live free PROBATION-tier selection |
| Reviewer physical-pool independence | DONE | implementer pool propagated through result/journal; live paid coder/reviewer used distinct OpenRouter pools |

## Runtime correctness

| Requirement | Status | Evidence |
|---|---|---|
| Parallel tool-call assembly | DONE | provider fragments keyed by tool-call index and execution fragments keyed by `toolCallId`; regression tests green |
| Served-model provenance | DONE | provider-reported model flows through stream finish and paid receipts; missing upstream identity remains explicit `null` |
| Reasoning-token headroom | DONE | measured starvation retry in qualification probes and route-specific production budgets |
| No false waiting | DONE | Fabric searches all admissible pools before queueing; queued subagent admission gets one bounded wait/re-decision |
| Stale/distant reset behavior | DONE | stale reset re-decides immediately; distant reset fails closed; hard denial never sleeps |
| Partial execution budgets | DONE | request overrides merge over role defaults; context capacity cannot become `NaN` from omitted fields |
| Completion integrity | DONE | every unfinished live E2 attempt remained `blocked`; no unreviewed work promoted |
| Billing boundary | DONE | free missions used no paid/unknown-cost supply; paid mission required `CODEFORGE_16BIT_CAMPAIGN=1` and budget reservation |

## Live missions

| Requirement | Status | Evidence |
|---|---|---|
| E2 real FreeCloudService + Free Fabric | DONE | 170 routes / 136 pools, 10 qualification receipts restored, real managed pool provenance |
| E2 role-aware execution | DONE | Explorer completed on QUALIFIED and PROBATION routes; Coder completed on `groq/qwen/qwen3.8-27b` in a separate run |
| E2 complete Explorer→Coder→Reviewer mission | BLOCKED — SUPPLY | Repeated bounded attempts: shared Groq quota did not survive all sequential roles; Mistral managed supply consent-gated; final attempt ended on provider fetch failure |
| E2 honest terminal semantics | DONE | all incomplete attempts `blocked`, reason-coded, no paid substitution, no main-repo promotion |
| E3 paid Explorer denial | DONE (live) | no paid Explorer qualified; denied before provider/spend, no free substitution |
| E3 paid Coder selection | DONE (live) | `qwen3.8-flash:openrouter`, cheapest qualified route, completed implementation |
| E3 independent Reviewer | DONE (live) | `glm-5.3-flash:openrouter`, distinct from implementer, `INDEPENDENT_POOL_PREFERRED` |
| E3 ForgeVerify + completion gate | DONE | frozen paid artifact verified 1/1 with zero additional provider calls; gate `completed`; integrated tree equals verified tree |
| E3 durable spend/provenance | DONE (live) | $0.008722 committed, 12 receipts, route/canonical/served model/telemetry/journals persisted |

## Regression and certification

| Requirement | Status | Evidence |
|---|---|---|
| Role-routing regression | DONE | `packages/server/test/role-routing.test.ts`: 18/18 |
| Paid role-routing regression | DONE | 9/9 |
| Free Fabric regression | DONE | 36/36 |
| Touched-package sweep | DONE | 596 passed / 2 skipped |
| Server sweep | DONE WITH BASELINE EXCEPTIONS | 876 passed / 3 skipped / 2 failures reproduced at `d4769e8` baseline (`agent-certification-r`, `fg3-model-aware-budget`) |
| Source-state recertification | DONE | `r48-role-aware-runtime-v1`, ID `9012e79edc1ae0dfd626a0eb44ab9c2ba352b739f50fa3758efd5b2e4097a709` |

## Closure verdict

The R48 implementation and paid live mission are closed. The complete free live
mission remains **open on external free-supply availability**, not converted to
success: the runtime proved role-aware admission, bounded re-decision, physical
pool provenance, honest blocking, and individual live completion for Explorer
and Coder, but no single attempt reached Reviewer with sufficient remaining
qualified free capacity.
