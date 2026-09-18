# R13 starting state

Recorded: 2026-09-18

R13 began from the authoritative R12 closeout commit `935ac48` (`close R12 release qualification gates`). The worktree was clean at handoff. R12 evidence remains read-only historical evidence; this tree contains all R13 observations and changes.

## Carried-forward facts

- Engineering verdict: `ENGINEERING_RC_NOT_READY`.
- Hosted verdict: `HOSTED_RELEASE_BLOCKED`.
- R11 public CodeForgeBench R2: **33/40**.
- R12 public CodeForgeBench R2: **30/40**.
- R12 recorded zero false completions, full tests/lint/typecheck/build/audit/secret scan passing.
- Virginia Render production is live on `0.5c-512mb`; PostgreSQL remains active; three unused web services are suspended. R13 has not changed Render, DNS, certificates, production schema, or remote Git state.

## R13 owner authorization and separation

The owner authorized up to **$15.00 USD aggregate** OpenRouter evaluation spend for the R13 **Paid Auto / 16-Bit** track only. It is not a general account credit authorization and never changes the free-track policy.

| Track | Paid inference budget | Permitted routes | Prohibited use |
| --- | ---: | --- | --- |
| ForgeAuto/Free + 8-Bit | $0.00 | approved verified-free cloud routes only | paid OpenRouter, Paid Auto, BYOK, local inference, hiding a free-route failure |
| Paid Auto + 16-Bit R13 evaluation | up to $15.00 aggregate | exact-pinned approved paid candidates after reserve/receipt/reconciliation | auto-recharge, `openrouter/auto`, unapproved fallback, using spend to improve a Managed Free benchmark |

Before a paid evaluation, R13 must use the `@codeforge/paid-auto` evaluation budget gate: current exact `PriceCard`, conservative positive output/input bound, durable campaign reservation, actual-use reconciliation or release, served-model identity check, and sanitized `PaidRouteReceipt`, `PaidFinancialReceipt`, and `PaidEvaluationReceipt`. The SQLite/PostgreSQL ledger is transaction-locked and its 100-simultaneous-request finite-budget proof is covered by `packages/paid-auto/test/evaluation-budget.test.ts`; no live paid request has been made as of this record.

## Policy implication for local models

The repository's current architecture forbids local LLM inference in CodeForge. R13 therefore does not integrate a local model to mask cloud rate limits. Reproducible provider simulators, capacity reservations, and free-route failover are the permitted test path.
