# R47 Baseline — 2026-09-27

## Verified state

- Branch: `codex/r29-release-closure`
- HEAD: `c0f8663` — R46 closure matrix, R47 gate, source-state recertification
- Working tree: clean
- Source-state: `r46-free-supply-resilience-v1` (`92534354261e…`), canary suite green
- R46 evidence: `docs/evidence/r46-free-supply-resilience/` (inventory, live corpus, closure matrix)

## R46 closure facts carried forward

- `r46-feature` completed through the production chain (fabric → reservation → health → admission
  → topology → completion gate), 17 mistral calls, verified 2/2, review passed.
- Durable qualification receipts restored across process restarts (6 on final run).
- Response-observer wiring + managed-pool account stamping fixed **in the corpus harness only**.
- Mistral `USER_CONSENT_REQUIRED` exclusion confirmed correct (do not weaken).

## Phase A targets (shared seams before 16-Bit)

1. Explorer output contract: `Expected non-empty string for summary` on every explorer journal in the
   R46 corpus — models: `gpt-oss-20b`, `codestral-2508`, `codestral-latest`. Diagnose → bounded
   deterministic recovery → role-quality signal (§6-8).
2. Thin Groq REVIEWER/PLANNER coverage — audit + qualify (§9-10).
3. `onResponse` observer not wired in cloud-gateway/provider-registry (§11-12).
4. Managed-pool accountId stamping is corpus-only convention → formalize (§13-14).
5. Data-policy consent contract regression tests (§15).

## Phase A regression gate

All R46 suites must stay green; at least one deterministic free mission must still pass.
