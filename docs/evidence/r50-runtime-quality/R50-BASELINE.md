# R50 Baseline — Verified Starting State

Verified at R50 start (not assumed from prompt).

## Repository

- Branch: `codex/r29-release-closure`
- HEAD: `be583f8e` — `R49 closure: final report + source-state recertification r49-free-supply-closure-v1`
- R49 commit range: `d0923a8` … `be583f8` (7 commits: baseline, capacity semantics, federation, quality feedback seam, scale proof, live certification, closure)
- Dirty files: **only** `docs/evidence/r34-capacity-efficiency/context-efficiency-benchmark.json` (intentional — rewritten by its own benchmark test; stays uncommitted)

## Certification

- Surface: `r49-free-supply-closure-v1`
- Source-state: `029807c8b24637554f788eceaf45db13edfc7e9052b0731f75eb2ae63560f30e`
- Document: `docs/codeforge-forgegreen-certified-source-state.json` (recertification entry for R49 present, `priorSourceStateId = 9012e79e…`)
- R48 predecessor: `r48-role-aware-runtime-v1` / `9012e79e…`

## R49 live evidence (verified from artifacts)

Four live 8-Bit missions on managed zero-cost routes, `$0` spend, `evaluateCompletion` the only
`completed` authority:

| Run | Explorer | Coder | Reviewer | Gate | Integration |
|---|---|---|---|---|---|
| 1 (transcript-captured) | openrouter/nemotron → groq/gpt-oss-120b (TEMPORARY_CAPACITY failover) | groq/gpt-oss-120b | openrouter/nemotron — **independent pool** | completed | integrated, trees equal |
| 2 (`RUN2.json`) | openrouter/nemotron `converged_failed` after groq→OR failover on RATE_LIMITED (5 turns) | openrouter/nemotron | openrouter/nemotron (SAME_POOL_FALLBACK) | completed | integrated, trees equal |
| 3 (`RUN3.json`) | openrouter/nemotron `converged_failed` (2 turns) | openrouter/nemotron — mid-run groq→OR failover on RATE_LIMITED | openrouter/nemotron | completed | integrated, trees equal |
| 4 (`RUN4.json` = canonical) | groq/gpt-oss-20b | groq/gpt-oss-20b | openrouter/nemotron `converged_failed` — **`TOOL_WORKSPACE_ESCAPE` (`path: "/"`)** | none (blocked honestly) | refused |

Nemotron-super per-role record across runs 1–4:

| Role | Attempts | Completed | Failures |
|---|---|---|---|
| EXPLORER | 3 (incl. 1 infra failover out) | 0 | 2 non-converged, 1 TEMPORARY_CAPACITY abort |
| CODER | 2 | 2 | — |
| REVIEWER | 3 | 2 | 1 workspace-escape security failure |
| **Total** | 8 | 4 | 3 |

gpt-oss-20b: EXPLORER 1/1, CODER 1/1 (both completed, Groq pool).
gpt-oss-120b: EXPLORER 1/1 (post-failover), CODER 1/1.

## Managed free supply (R49 live inventory)

- Providers with admissible qualified routes: **Groq** + **OpenRouter** (2 independent account domains)
- Mistral: catalog reachable (44 models) but all routes excluded `DATA_POLICY_USER_CONSENT_REQUIRED`
- `owner:*` pools excluded `OWNER_DEV_FREE_NOT_PRODUCT_FREE`
- Production-qualified routes: 5 across 4 physical pools
- OpenRouter authoritative quota: `/api/v1/key` `free_model_daily_requests` (939 remaining at R49 start)

## Known baseline failures (unchanged since `d4769e8`)

- `agent-certification-r` — million-symbol bound
- `fg3-model-aware-budget` — tiny-context pin
- `parallel-orchestrator-integration` — ~31.6s vs 30s limit on this host (passes at raised timeout; wall-clock margin, not semantic)

## R49-architected invariants to preserve

- Zero-window capacity routes deny (fail-closed); an observed requests window counts as metering.
- `probeAccountQuota()` is the OpenRouter authority; no inference probes just for quota.
- `journalActiveRoute` tracks `activeSelection` on failover (journal names final served route).
- `recordRoleOutcome` seam exists: `verification_failed` on ForgeVerify reject, `verified_complete` only after gate + integration accept.
- Reviewer independence: `preferIndependentFromPoolId` sort + `SAME_POOL_FALLBACK` honesty.

## R50 target gaps (confirmed by pipeline trace — see R50-QUALITY-SIGNAL-CALLGRAPH.md)

1. `role_outcome` kinds `security_blocked` + `budget_exhausted` are declared in the observation
   union but **silently ignored** by the authority switch.
2. The workspace-escape/permission-denied boundary block (`agent-runtime.ts:3170`) emits **no
   observation at all** — the model that violated the boundary produces zero routing evidence.
3. The subagent role-run loop emits **no `tool_outcome`** for locally-detected invalid calls
   (malformed args, unknown tool, boundary violations) — only provider-side
   `INVALID_TOOL_OUTPUT` and the interactive path feed the reliability tracker.
4. `recordRoleOutcome`'s public signature only accepts 3 of the 5 declared outcomes.
5. `roleQualityAdvice`/`roleQualityAdjustmentFor` read **qualification receipts only** —
   runtime evidence reaches ranking only as binary CAPABILITY_LIMITED/TOOL_UNRELIABLE
   conditions; there is no graded per-role evidence profile (no positive accumulation,
   no severity grading, no sample counts per role).
6. Reviewer `revision_required` verdicts produce no reviewer-scoped quality evidence.
7. Failover does not grant the replacement route any bounded productive-turn headroom —
   budget spent on a failed route's turns is fully charged against the replacement.
