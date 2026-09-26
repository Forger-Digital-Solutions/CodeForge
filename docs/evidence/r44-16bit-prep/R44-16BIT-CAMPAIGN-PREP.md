# R44 — 16-Bit Campaign Preparation (schema + harness readiness, zero paid calls)

**Boundary.** This document prepares the upcoming 16-Bit (Paid Auto) campaign. R44 itself
ran zero paid inference: no paid credential was read for routing, no paid provider request was
made, and no paid route was admitted into any 8-Bit run. `paidInferenceUsed: false`.

## What already exists

| Component | Location | State |
|---|---|---|
| Paid route registry (4 canonical identities, direct + same-model fallback only) | `packages/paid-auto/src/registry.ts` | shipped |
| Exact-current-price assertion + usage→USD pricing | `packages/paid-auto/src/expected-cost.ts` (`assertExactCurrentPrice`, `estimateUsageUsd`) | shipped |
| Durable spend ceiling with reservations | `packages/paid-auto/src/evaluation-budget.ts` (`DurablePaidEvaluationBudgetLedger`) | shipped |
| Paid-eval runner against OpenRouter | `PaidAutoOpenRouterEvaluationRunner` (same file) | shipped |
| 16-Bit shadow ledger, MOCK-default provenance | `packages/paid-auto/src/shadow.ts` (`observeSixteenBitShadow`) | shipped |
| Free-only boundary: manual Paid Auto selection rejected | `PAID_AUTO_BLOCKED_BY_FREE_ONLY_POLICY` (R27 evidence) | shipped |

## What R44 added for 16-Bit readiness

- `R44-16BIT-EVIDENCE-SCHEMA.json` — the per-run evidence contract. It mirrors the R44 8-Bit
  corpus receipt (`roles[]` harvested from `agent_run_journal.telemetry`, `forgeGreen`,
  `forgeVerify`, `calls[]`, `failovers`) and adds the paid-only fields: `route.priceCard`
  (exact current price + provenance), `budgetAuthorization` (durable ledger reservation +
  ceiling + human authorizer), and `spend` (estimated vs actual, per-call micros).
- The R44 corpus harness (`scripts/r44-multifile-corpus.mjs`) is the reuse template: task
  families, arm structure, journal/receipt harvesting all carry over. The 16-Bit harness
  differs only at the provider adapter (paid route via `PaidAutoOpenRouterEvaluationRunner`
  instead of the free catalog) plus the budget gate below.

## Authorization gate for the real campaign

A 16-Bit run is only legal when all of these hold — enforced in the harness before the first
provider call:

1. `CODEFORGE_16BIT_CAMPAIGN=1` is set explicitly in the environment.
2. A `DurablePaidEvaluationBudgetLedger` reservation exists for the campaign ID with an
   exact-current-price card (`assertExactCurrentPrice`) — not a cached or assumed price.
3. The campaign ceiling is declared in USD micros and every `estimateRequestUsd` admission
   passes before dispatch; per-call actual spend is reconciled into `spend.perCallUsdMicros`.
4. `servedModelId` from every response must equal the requested `modelId` or a declared
   same-model fallback identity — a mismatch releases the reservation and fails the run
   (existing `safeServedModelId` / reservation-release path).
5. Provenance is recorded per record; framework-dry-run outputs are `MOCK` and are never
   quality evidence.

## Shadow validation path (no spend)

The harness can be exercised end-to-end today with the shadow ledger:

```
node scripts/<r45>-16bit-corpus.mjs --shadow   # MOCK provenance, no provider calls
```

A shadow run produces schema-valid records with `provenance: "MOCK"` and
`calls: []` — sufficient to validate artifact shape, harvest plumbing, and the spend-receipt
reconciler before any authorized paid run exists.

## Evidence the campaign must collect (per §23)

- role qualification per role (explorer/planner/coder/reviewer receipts)
- intelligence quality: task family outcomes comparable to the R44 8-Bit corpus
- cost: estimated vs actual USD per run, per role, per family
- latency: per-call `ms`, run `wallMs`
- context efficiency: `contextMetrics` (contextBytes, ForgeGreen compression receipts)
- tool use: `editAttempts`, tool failures, loop blocks
- multi-file success: the seven §3 families under both arms
- subagents: per-role journals and turn/tool counts
- ForgeGreen / ForgeVerify: suppression, denials, verification results, repair cycles
- provider health + failover: failover events, parked routes, recovery
- hard spend controls: ceiling enforcement, reservation release on mismatch, per-call reconciliation

## Explicitly not done in R44

- No paid model was contacted, listed, or priced.
- No 16-Bit route was admitted to any R44 run; the corpus adapters register free providers only.
- No quality claim about any paid model is made anywhere in R44 evidence.
