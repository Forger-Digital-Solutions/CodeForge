# ForgeGreen FG-5 certification report

## Scope and inherited state

This continuation started from the intentional dirty worktree at `eb20049`, the certified FG-4 commit on the `feat/codeforge-cloud` lineage. The inherited FG-5 work covered the policy module, ForgeGreen ledger metrics, ForgeVerify contracts and service integration, Completion Gate wiring, workflow integration, and immutable verification persistence. No reset or destructive cleanup was used.

The inherited focused policy proof was 14 tests passing; the continuation expanded the completion and persistence proof before certification. The canonical full-suite topology remains `vitest run --fileParallelism=false` with normal Vitest file isolation.

## Authority chain

- FG-2 supplies structural facts, provenance, completeness, and candidate relationships.
- FG-4 supplies blast-radius and analyzability advice; it cannot certify verification.
- FG-5 deterministically derives V0–V5 obligations and evaluates evidence sufficiency.
- ForgeVerify executes trusted verifier definitions and records structured evidence.
- Completion Gate independently validates current verification identity and all non-verification completion authorities.

FG-5 does not grant filesystem or shell permission, resolve approvals or questions, select a provider/model, override exact pins, publish, or declare final completion.

## Policy and evidence

`V0_NO_VERIFICATION` is restricted to provably documentation-only changes. Local internal changes use V1/V2 targeted evidence; signature changes use V3 package evidence; public API and cross-package changes use V4; systemic, delivery, or publication work may use V5. Obligations are explicit, typed, scoped, reason-coded, and identity-bound rather than test-count scores.

Evidence is evaluated from structured status and exit code, not output prose. Required skips, partial execution, failures, timeouts, interruptions, blocked infrastructure, and missing checks remain unsatisfied. Evidence and receipts bind policy version, workspace content hash, revision, verifier/command selection, and relevant environment; a same-HEAD dirty-tree mutation therefore invalidates prior proof.

## Runtime and persistence proof

The Completion Gate rejects sufficient decisions with an old revision, old workspace identity, or incompatible policy version. It also blocks when approval, a user question, review, or unfinished plan work remains. The ForgeVerify observer persists plans, attempts, evidence, and policy receipts as immutable work items; duplicate receipt delivery is idempotent.

SQLite receipt persistence was exercised across close/reopen and duplicate insertion. Real PostgreSQL migration and restart batteries passed, including namespaced sessions/cloud migrations and CF-17 queued-steer restart behavior. The existing PostgreSQL migration history remains `sessions_schema_migrations` and `cloud_schema_migrations`.

## Certification evidence

Focused continuation battery after the identity and authority-boundary changes:

- Completion Gate, ForgeVerify evidence, policy, verification service, and SQLite persistence: passed.
- Real PostgreSQL migration namespace, cloud database, 8-Bit, and CF-17 restart suites: passed.
- Full typecheck, production build, canonical full suite, and final delivery certification are the final release gates for `FG5_PASS` and are recorded in the final certification result.

## Boundary to FG-6

FG-6 remains future work. This implementation stops at deterministic verification policy, evidence identity, sufficiency, persistence, and Completion Gate integration; it does not introduce a broader evidence-governance or resolution engine.