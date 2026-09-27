# R47 Phase A — Shared Runtime Closure

Substrate defects R46 exposed, fixed before the 16-Bit campaign. Each item: defect → root
cause → change → proof.

## 1. Explorer output contract (§6–§8)

**Defect.** Mid-tier free models failed explorer runs with `Expected non-empty string for
summary` — the schema existed only in validation code; the prompt never declared it, and the
repair re-ask named no fields.

**Changes.**

- `STRUCTURED_OUTPUT_CONTRACTS` — the wire schema per kind, exported once and used by both the
  system prompt (upfront) and the rejection re-ask (bounded diagnostics).
- Explorer prompt now declares `{summary, findings, evidence}` verbatim — parity with the
  reviewer/planner prompts which already did.
- Validation failures carry bounded shape diagnostics (`missingFields`, `presentKeys`) — never
  content. Runtime telemetry records them per run.
- Bounded deterministic recovery for the *only* observed failure class: explorer `summary`
  missing/blank while `findings`/`evidence` validate → promote a known synonym verbatim
  (`conclusion|overview|result`), else synthesize a strictly structural summary (counts +
  file names; no semantic conclusions). Repair strategies recorded: `summary_synonym`,
  `summary_synthesis`. All other kinds stay strict.
- Outcome classes feed role quality: accepted payloads record `valid` (native) or
  `structured_output_repaired`; exhaustion records `structured_output_failure` — all scoped to
  the serving role via `recordToolCallOutcome(..., { role })` into both the reliability
  tracker and the route-health authority.

**Proof.** `structured-output-security.test.ts` 26/26 (7 new: synthesis, synonym, blank
summary, diagnostics shape, non-explorer strictness, no-fabrication). `reliability.test.ts` +
`route-health-authority.test.ts` 34/34.

## 2. Provider response observation (§11–§12)

**Defect.** `freeCloud.onProviderResponse` existed only where hosts remembered to wire it.
`createProviderAdapterById("openrouter")` silently dropped `opts.onResponse` (and skipped the
capacity governor). `CloudProviderRegistry` passed no observer at all — the hosted path was
blind to quota/429/auth evidence mid-serve.

**Changes.**

- `provider-factory.ts`: both openrouter construction paths now compose
  `defaultCapacityGovernor.observeResponse` + caller `onResponse`. Nothing can build an
  openrouter adapter by id that drops observation again.
- `CloudProviderRegistry`: observation is non-optional in this host — every adapter built by
  the default factory pipes responses into a built-in `firewallManager` health bridge;
  `options.onResponse` is an *additional* sink. Custom `adapterFactory` receives the composed
  observer (`(id, ctx) => adapter`) — the invariant travels through the seam.
- Bridge semantics: 401/403 → provider `auth_required` (credential dead account-wide);
  429 → `markModelHealth` rate_limited for the upstream `retry-after` window (60s default) —
  per-model precision, siblings stay eligible; model-less 429 → provider-wide; success/5xx →
  no flap (transient noise).
- `CloudFirewallManager.markModelHealth` passthrough added.

**Proof.** `provider-registry.test.ts` 18/18 (5 new: 401→auth_required, per-model 429 +
sibling survives, model-less 429→provider-wide, 200/5xx no flap, host sink receives obs).

## 3. Managed-pool account identity (§13–§14)

**Defect.** The `provider::account::model` quota contract was implicit harness knowledge. Worse:
`quota.get(p, m, accountId)` and `hasProviderScoped(p, accountId)` fell back to the *unscoped*
provider bucket — unattributed evidence silently fed every managed account on that provider
(double-counted windows, no diagnostic).

**Changes.** `quota.ts` removes both fallbacks for account-scoped queries.
`free-cloud-service.ts`: `managedAccountObserver()` (the contract as API — throws on
undeclared identity), `capacityEvidenceGaps()` diagnostic surface, `onProviderResponse` flags
unstamped/stranger-account observations on managed providers. Corpus + §10 probe rewired to
the canonical seam (pools registered before adapters).

**Proof.** `free-cloud-registry.test.ts` 57/57 (3 new §13/§14 tests). See
`R47-ACCOUNT-IDENTITY-CONTRACT.md`.

## 4. Free role coverage (§9–§10)

See `R47-FREE-ROLE-COVERAGE.md` + `.json`. Headline: at the true account boundary the fleet is
CODER 3 / PLANNER 2 / REVIEWER 2 / **EXPLORER 1**. One bounded mistral probe added
`mistral-code-latest` (CODER+PLANNER qualified); mistral explorer failure is a measured
capability pattern (5/5 models, zero read discipline) — documented as supply limitation, not
retried.

## Regression status

- `tsc -b` clean across the workspace.
- Touched suites green: agent 26, cloud-gateway 18, model-registry 57, eight-bit
  reliability+health 34.
- No completion-gate, data-policy, or billing-boundary semantics changed.
