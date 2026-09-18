# R13 deterministic certification matrices

Recorded: 2026-09-18. The focused matrix run passed **19 files / 136 tests / 0 failures** in 3.70 s, followed by the authoritative full suite recorded separately.

## 8-Bit

| Requirement | Evidence |
| --- | --- |
| Free-only identity and admission | `free-cloud-registry.test.ts`: strict $0/free evidence, no promotional/unreviewed/paid admission, quota parsing |
| Health, quota/reset, 429, recovery, saturation | `free-cloud-chaos.test.ts`, `capacity-governor.test.ts`, `openrouter-native-fallback.test.ts` |
| Exact selection / failover | `failover.test.ts`, `eight-bit-active-run-failover.test.ts`, `fg3-eight-bit-failover-context.test.ts`: exact pins never silently replace; no eligible free route fails closed |
| No Paid Auto/BYOK fallback | `failover.test.ts`, `free-cloud-chaos.test.ts`: all-free saturation returns no eligible free model |
| Shadow non-authority | `eight-bit/test/shadow.test.ts`: off/on route identity and throwing observer isolation |

Result: deterministic 8-Bit behavior is certified at the local/mock boundary. Live provider quota remains per-campaign observable, not pre-imputed.

## 16-Bit

| Requirement | Evidence |
| --- | --- |
| Canonical model/route identity and no unsafe fallbacks | `paid-auto.test.ts`: exact four-model registry, same-canonical fallback only, no `openrouter/auto`, no false completion |
| Price cards, output cap, campaign budget, receipts | `evaluation-budget.test.ts`: current exact price, explicit output bound, decimal accounting, served-model check, reconciliation |
| Durable concurrency and tenant boundary | `evaluation-budget.test.ts`: 100 simultaneous reservations remain below cap; session-scoped receipts; credential-shaped identifiers rejected |
| Shadow-only prediction | `paid-auto/test/shadow.test.ts`: advisory recommendation does not mutate the ledger |

Result: local/durable 16-Bit financial controls are certified. No paid inference was run and no paid model is qualified live in R13.

## ForgeGreen

| Requirement | Evidence |
| --- | --- |
| Provider concentration and capacity-aware topology | `topology-advice.test.ts`, `adaptive-topology.test.ts` |
| 1/2/4-agent ablation and diminishing returns | `forgegreen/TOPOLOGY-ABLATION.md`; deterministic modeling, explicitly not production telemetry |
| Advisory-only / no route or completion authority | `forge-green/test/shadow.test.ts`, `fg9-shadow-mode.test.ts`; `adaptive-topology.test.ts` also enforces ForgeVerify for every topology |

Result: deterministic ForgeGreen advice is certified as advisory. It neither chooses a route nor completes a task.

## Shared intelligence / shadow safety

`shadow-intelligence.test.ts` covers taxonomy/provenance, session-isolated telemetry, controlled field persistence, protected-split exclusion from training, schema mismatch failure, and non-fabricated regret. The broader focused run also proves production output identity with shadow off/on and observer failure isolation. All predictors remain `SHADOW_ONLY`; artifact/model-card metadata is recorded in the R13 `shadow/` evidence directory. PostgreSQL-specific persistence certification remains blocked and is not represented as a passing shadow result.
