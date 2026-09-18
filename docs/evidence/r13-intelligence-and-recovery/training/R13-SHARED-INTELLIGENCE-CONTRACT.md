# R13 shared intelligence contract

Feature schema: `codeforge-intelligence-features-v1`
Split schema: `codeforge-intelligence-splits-v1`

`@codeforge/intelligence` is the shared data layer for 8-Bit, 16-Bit, and ForgeGreen. A row is an append-only, sanitized observation. It has no prompt, repository-content, tool-output, provider-response-body, credential, customer filename, or hidden benchmark-answer field.

## Contract and lineage

Each row carries pseudonymous task, run, tenant, task-family, fixture-family, repository, and benchmark-lineage hashes; an observation timestamp; deterministic policy version; optional model-profile and ForgeGreen versions; provenance; source classification; feature-schema version; production decision; optional shadow recommendation; and actual outcome.

The shared feature groups are `TaskFeatures`, `RouteFeatures`, `TopologyFeatures`, `ContextFeatures`, `ToolFeatures`, `EconomicFeatures`, and `VerificationOutcome`. Exact metrics that are noisy or privacy-sensitive are expressed as bands where possible. USD values are decimal strings with at most six fractional places; the pre-existing 16-Bit ledger remains the authority and uses integer micros internally.

## Outcome taxonomy

The terminal labels are `VERIFIED_SUCCESS`, `VERIFIED_SUCCESS_AFTER_RETRY`, `VERIFIED_SUCCESS_AFTER_ESCALATION`, `MODEL_REASONING_FAILURE`, `MODEL_RELIABILITY_FAILURE`, `PLANNING_FAILURE`, `CONTEXT_FAILURE`, `TOOL_FAILURE`, `PROVIDER_RATE_LIMIT`, `PROVIDER_FAILURE`, `QUOTA_BLOCK`, `BUDGET_BLOCK`, `VERIFICATION_FAILURE`, `COMPLETION_CONTROL_FAILURE`, `USER_CANCELLED`, `TIME_BUDGET_EXHAUSTED`, and `INFRASTRUCTURE_FAILURE`.

`falseCompletion` is a distinct verification field; it is never folded into a generic failure. Provider rate limiting, quota block, and provider failure set model capability to `UNKNOWN`, never model failure.

R13 historic classification is encoded and tested as follows:

- PF-01 is `TIME_BUDGET_EXHAUSTED`, with `verificationStarted=false` and `falseCompletion=false`.
- GS-02 / SS-01 are `VERIFICATION_FAILURE`, with `verificationCaught=true`, `completionBlocked=true`, and `falseCompletion=false`.
- R12 rate-limit outcomes are `PROVIDER_RATE_LIMIT` or `QUOTA_BLOCK`, with model capability `UNKNOWN`.

`historicalOutcomeRecord` is the sanitized R11/R12/R13 summary-ingestion boundary. It consumes only classification and derived route metadata; the benchmark task body and hidden answer never cross into a training row.

## Split isolation and retention

The splitter groups connected records by any shared task family, fixture family, repository, or benchmark lineage. It then deterministically assigns whole components to `TRAINING`, `VALIDATION`, `PUBLIC_TEST`, or `PROTECTED_HOLDOUT`; protected records are not returned by the training selector. Simulated evidence may be retained and reported, but is always labeled `SIMULATED` rather than silently blended with observed data.

Retention is restricted to these de-identified operational outcomes. Tenant-scoped shadow telemetry uses the existing authoritative session work-item store; a session query cannot read another session's rows. The existing generic work-item schema is already durable in both SQLite and PostgreSQL, so the additive shadow kind does not require a destructive database migration.
