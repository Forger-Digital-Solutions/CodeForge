# CodeForge R4.0 → R4.6 campaign report

## Executive verdict

`CODEFORGE_R4_CAPACITY_LIMITED_EXTERNAL_EVIDENCE_PENDING`

The actual checkout was reconciled before implementation. It is not treated as a completed
R3.9 release: the authoritative evidence says R3.5 is complete, R3.6 hardening is present, and
R3.7–R3.9 are not evidenced as a completed chain. Deterministic production routing remains the
authority; 8-Bit remains experimental. No push, paid inference, key disclosure, quota evasion, or
completion-gate relaxation occurred.

## Reconciliation and baseline lock

The locked baseline is [r3.9-reconciliation.json](../tests/evidence/r4/r3.9-reconciliation.json).
Historical R3 files were hashed and preserved, not rewritten. The R4 work added a separate failure
registry and dated provider research.

## OpenRouter account result

Read-only live checks returned HTTP 200 for both account endpoints. `/credits` reported 10 credits
and 0 usage. `/key` reported `is_free_tier=false`, a `-1` per-10-second key rate-limit field, and
no daily free counter. OpenRouter's [official FAQ](https://openrouter.ai/docs/faq) documents 1,000
daily `:free` requests for accounts with at least $10 in purchased credits, so the account is
qualified for that documented tier. The exact remaining daily counter is not observable and must be
learned from runtime headers. The $10 balance does not permit paid fallback.

## What was implemented

- ForgeZero now owns deterministic capacity classes, economic sources, scopes, explicit-zero-price
  policy, privacy-aware route metadata, capacity windows, event expiry, forecasts, reservations,
  first-run protection, per-user concurrency, lease recovery, concentration alerts, and a scale
  simulator.
- 8-Bit exposes an advisory capacity intelligence boundary. Its recommendation path filters through
  ForgeZero and cannot select paid, unhealthy, disabled, unknown-scope, or non-zero routes.
- The simulator covers registered-user bands 1/10/25/50/100/200/373/500/1000; 373-user DAU bands
  75/150/373; 25 new users during peak; provider and gateway outage; promotion end; and 50 huge
  tasks versus 50 normal tasks. It writes [scale-report.json](../tests/evidence/r4-scale/scale-report.json).
- The R3 oracle wrapper now owns the `vitest run` verb, finds or receives the correct Vitest entry,
  creates raw-report directories, and cleans disposable worktrees after evidence persistence.
- Autonomous planner output is strictly revalidated, can only recover from a valid JSON summary,
  and must contain both coder and reviewer work before execution.

## Scale evidence

The deterministic fleet counts 520 normal task units per reset window in the baseline scenario. It
passes the modeled 373 registered/373 DAU-free scenario only when demand is the 373 registered-user
one-task case; the 373-DAU, 1,000 registered, 500 registered, and huge-user stress cases block.
This is an honest capacity limitation, not a false completion. Outage scenarios retain capacity in
the modeled fleet and no scenario routes to paid capacity. No real users were fabricated.

## 8-Bit and privacy decision

The R3.5 neural artifact remains experimental because its temporal route-outcome holdout F1 was 0.0
against the deterministic baseline's 1.0. R4 capacity intelligence is therefore advisory and
deterministic accounting is authoritative. Private repository content, secrets, and third-party
model output remain outside the training-rights path.

## Provider research

The dated matrix is [r4-provider-research-2026-09-15.md](research/r4-provider-research-2026-09-15.md).
Models.dev is discovery-only. Groq, Cloudflare, Cerebras, Kilo, Gemini, Mistral, Hugging Face,
Z.AI, and OpenRouter are not treated as interchangeable: scope, reset, privacy, pricing, and
eligibility evidence remain route-specific.

## R4 failure registry

[tests/evidence/r4/failure-registry.json](../tests/evidence/r4/failure-registry.json) records two
closed remediations inherited from R3 and two open R4 limits: current scale capacity and the
unobservable OpenRouter daily counter. Historical R3 FR-007/FR-008 entries remain unchanged.

## Required report matrix

The following is the required R4.0–R4.6 gate matrix. `PASS` means locally evidenced in this
campaign; `PENDING` means it was not fabricated or inferred from the simulator; `BLOCKED` means a
hard gate is withheld.

| Sections | Area | Status | Evidence or reason |
|---|---|---|---|
| 1–8 | Reconcile R3 truth, preserve spine, free-first policy, zero-cost firewall | PASS | Baseline lock; ForgeZero policy; historical hashes |
| 9–16 | Capacity classes, OpenRouter account audit, provider breadth, Models.dev boundary | PASS/PENDING | Dated research; live account endpoints; remaining counter pending |
| 17–24 | Model identity, privacy, context, caching, ForgeKnowledge, concentration | PASS/PENDING | Canonical identity and policy preserved; broader campaigns pending |
| 25–32 | Reservations, role reservations, reset/wait semantics, first-run reserve | PASS | Capacity ledger tests and deterministic lease recovery |
| 33–40 | Quota auto-restore, failover, fairness, abuse protection, sponsored/credit rules | PASS/PENDING | R3 quota fix preserved; R4 simulator; external sponsorship pending |
| 41–48 | Promo events, expiry, availability UX, user-facing model choice | PASS/PENDING | Event contract and simulator; browser/UI lock pending |
| 49–56 | 373-user load profiles, concurrency, recovery, quality floor, Reviewer independence | PASS/PENDING | 17 deterministic scenarios; real early-access run pending |
| 57–62 | 8-Bit portfolio, forecasting advisory boundary, alerts, failure registry, telemetry privacy | PASS | Advisory boundary, registry, no fabricated telemetry |
| 63–67 | Rollback, no-8-Bit/provider/gateway/promo fallback, economics, packaged proofs | PENDING/BLOCKED | Scale and browser/provider packaged gates not yet evidenced |

## Phase status

- R4.0 baseline and policy foundation: complete locally.
- R4.1 capacity accounting, reservations, events, and deterministic simulation: complete locally.
- R4.2 provider qualification and live route reconciliation: partial; OpenRouter account verified,
  daily counter and several providers remain runtime/header qualified only.
- R4.3 8-Bit capacity advisory path: complete locally; no promotion decision changed.
- R4.4 browser, UI, private-repository, and first-run campaign proofs: pending.
- R4.5 373-user early-access proof: pending; simulator is not real-user evidence.
- R4.6 scale certification: blocked by honest capacity blocks in the 373-DAU and heavy-user cases.

## Next authorized continuation

Reproduce the real FR-007/FR-008 evidence against the hardened runner, qualify additional zero-cash
routes and current OpenRouter headers, run an authorized early-access cohort if available, then
re-run the scale gate. Do not promote 8-Bit, enable paid spillover, claim unlimited capacity, or
call R4.6 certified until the withheld evidence exists.
