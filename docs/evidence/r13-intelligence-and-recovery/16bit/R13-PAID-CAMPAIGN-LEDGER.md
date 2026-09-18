# R13 Paid Auto / 16-Bit campaign ledger

| Field | Value |
| --- | --- |
| Authorization source | R13 owner authorization clarification, 2026-09-18 |
| Aggregate hard ceiling | $15.00 USD |
| Auto-recharge / subscription authority | none |
| Free-track allowance | $0.00 paid inference |
| Amount committed | $0.00 |
| Amount reserved | $0.00 |
| Amount available under R13 authorization | $15.00 |
| Live paid requests made by R13 | 0 |
| Current campaign status | durable ledger, compatibility, and policy staging only |

Every eventual paid request must be represented by a `PaidEvaluationReservation`, `PaidRouteReceipt`, `PaidFinancialReceipt`, and `PaidEvaluationReceipt` from `packages/paid-auto/src/evaluation-budget.ts`. The shared SQLite/PostgreSQL session store transaction-locks the campaign ledger; its separate reservation and append-only receipt records contain route identity, monetary evidence, and usage only—never a request prompt, provider response body, or credential.

The gate requires an exact current PriceCard, a conservative pre-send output/input bound, an observed-price-only billing surface, exact served-model identity, and no unapproved-model fallback. The deterministic safety test launches 100 simultaneous reservation attempts against a finite budget and admits only the three that fit; 97 are rejected before dispatch. This is a simulator proof, not a paid provider call.

This evidence file is an R13 accounting record, not proof of an OpenRouter account balance. Account balance must never be mistaken for authority to spend.
