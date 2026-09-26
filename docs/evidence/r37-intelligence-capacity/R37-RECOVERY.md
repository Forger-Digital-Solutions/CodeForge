# R37 — Recovery & baseline verification

Date: 2026-09-26
Campaign: R37 intelligence & capacity offensive (8-bit, ForgeGreen, ForgeVerify, free-route
expansion, near-zero-wait inference)
Executor: SWE-2 (Devin)

## Repository state (verified)

| Fact | Expected | Observed |
|---|---|---|
| Branch | `codex/r29-release-closure` | `codex/r29-release-closure` ✓ |
| HEAD | post-R36 | `b1c0fac` — R36 UI slice commit ✓ |
| Working tree | n/a | ONE pre-existing uncommitted change: `scripts/r11-codeforge-bench-r2-executor.mjs` (seeded fixture `a - b` → `a + b`). Not authored by this executor; preserved untouched. |
| Stash | — | `stash@{0}` "preserve task-fix forgegreen work" (pre-existing, left untouched) |
| R35 evidence | present | `docs/evidence/r35-backend-finalization/` incl. final report, contract freeze ✓ |
| R36 evidence | present | `docs/evidence/r36-major-ui/` — 16 docs + screenshots ✓ |
| Canonical baseline | 3730/0/48 | recorded in R35 final report |

## Prior campaigns' intelligence/capacity state (read)

- **R33 free-capacity fabric**: provider quota-domain inventory (`provider-quota-inventory.md/.json`),
  capacity model, load simulation, credit-opportunity ledger. Key open items: hosted OpenRouter
  shared-key terms classified restricted (register) vs catalog `CLEARED` contradiction; only ONE
  account pool measured (OpenRouter 282/1000 remaining at 2026-09-24); Groq/Mistral/Groq-per-model
  domains identified as candidates, unverified.
- **R34 capacity-efficiency**: measured per-dispatch demand (~2.0–2.9k tokens/call vs assumed 16k),
  tool-surface gating, history compaction, learned per-provider `tokenizerRatio`. Launch bar (§T):
  ≥2 independent admissible managed pools, live cross-pool `MIGRATION_PROVEN`, honest
  `WAITING_FOR_FREE_CAPACITY`, billing red-team, launch blockers doc.
- **R35 backend-finalization**: completion-gate authority, task state machine, tool authority,
  security lifecycle, UI contract freeze (frozen — additive-only from frontend).
- **R36 UI slice** (`b1c0fac`): streamed command/subagent/capacity timeline, grouping v2,
  resizable Inspector panes — preserved, must not be reverted.

## Subsystem map (audited)

- `packages/eight-bit/` — routing, capacity intelligence, qualification suite (`qualification/`),
  dataset builder (`dataset/`), route-health authority/ledger, free-fabric, failover, shadow,
  eviction, drift, handoff, persistence. The "8-bit" inference-economics core.
- `packages/forge-green/` — efficiency: canonical cache, energy estimator, coverage authority,
  optimization candidates/policy/decision/persistence, sustainability receipts, waste taxonomy.
- `packages/intelligence/` — baselines, predictors, outcome taxonomy, telemetry, reports, splits.
- `packages/router/`, `packages/providers/` (capacity-governor, provider integrations incl.
  openrouter, hosted, opencode, cloudflare-neuron-budget).
- `packages/workflow/` — completion gate (`evaluateCompletion` sole authority), verification.
- `packages/model-registry/` — provider definitions/terms registry.
- `packages/paid-auto/` — shadow-mode paid comparison harness.
- ForgeVerify events (`forgeverify.plan_created/attempt_started`) consumed by UI; verification
  subsystem lives under workflow/paid-auto qualification paths.

## "16-bit" status

No `16-bit`/`16bit` package or module exists. If R37 intends a second-tier capacity/intelligence
plane (e.g. heavier qualification, dual-pool scheduling, or a next-gen routing layer), it is
net-new work — flagged for scope confirmation.

## Constraints reaffirmed

- Free cloud models only; ForgeZero fail-closed; no paid inference consumption without
  authorization; completion gate is sole success authority; strict TS/ESM; Vitest.
- No push, no deploy, no destructive ops.

## Baseline verification (quick)

- Repo `typecheck` + `build` verified clean at R36 close (see R36-CERTIFICATION.md).
- Full-suite re-baseline deferred to first change cycle to save wall-clock; targeted package
  suites will gate each change.
