# ForgeVerify

ForgeVerify is the verification evidence layer between verification planning and the Completion Gate. It does not grant completion, publication, permission, or model authority.

## Authority boundary

The trusted runtime registers `VerifierDefinition` records with a stable machine ID, version, structured executable/arguments, timeout, retry limit, scope, and default requirement. A `VerificationPolicy` produces a versioned immutable plan. ForgeGreen and Repository Intelligence may provide ordering or relevance advice, but neither is an input that can lower a policy-required verifier.

The legacy `verificationCommands: string[]` surface is a compatibility input only. `runVerification` adapts it at the trusted workflow boundary into a stable, digest-versioned `VerifierDefinition` with structured executable and argument fields. Shell-only forms are rejected rather than falling back to opaque shell execution. Legacy reports are derived from ForgeVerify evidence for compatibility; they are not a second completion authority.

## Evidence graph

`VerificationPlan` owns explicit required, optional, and advisory obligations. Every execution creates a separate `VerificationAttempt`; terminal execution produces one frozen, content-addressed `VerificationEvidence` record. A retry creates another attempt and never rewrites the former record. The in-process evidence store is idempotent per attempt and recovery changes unfinished work only to `interrupted`, never to pass.

Evidence contains the workspace path, verifier definition digest, input-state hash, command and output digests, bounded redacted output excerpt, execution status, and timing. The state hash binds Git HEAD, tracked dirty diff, untracked file contents, and workspace identity. Non-Git workspaces use a deterministic bounded-tree identity. Thus a changed dirty worktree, different worktree, or definition drift cannot satisfy a current plan.

## Completion integration

`summarizeVerification` calculates completeness as required obligations minus current matching PASS evidence. Missing, failed, cancelled, timed-out, infrastructure-error, interrupted, stale, and definition-drift evidence are negative reasons. Optional and advisory evidence cannot satisfy a required obligation. `WorkflowEngine` passes the canonical ForgeVerify summary into the Completion Gate, which emits the final verdict. Legacy report data is retained only for display/failure diagnostics and cannot override the summary.

## Durable projection

The workflow service observes plan, attempt, and evidence lifecycle records. The same session-backed observer is used by parallel, mission, autonomous, and delivery verification paths. It appends plans and terminal evidence through the session persistence store's immutable insert path; running attempts are updated only through their permitted lifecycle. Re-opening a session SQLite database reconstructs all records. At the start of a subsequent workflow, any persisted running attempt is explicitly marked `interrupted`; no restart produces PASS evidence.

The same observer emits bounded structured `forgeverify.*` workspace events. They carry plan identity, verifier identity, terminal status, duration, and truncation metadata—never raw output. The run-inspection snapshot and desktop inspection projection consume this server-authoritative state and render current evidence status without parsing stdout. Session event persistence provides SSE replay using the existing sequence-based deduplication.

Cloud persistence exposes the same source-of-truth primitives through `ICloudDatabase`: plans, attempts, terminal transitions, evidence, ordered reads, and running-attempt recovery. Migration `006_cf16r2_forgeverify_evidence` creates foreign-keyed plan/attempt/evidence tables in both SQLite and PostgreSQL; evidence is unique per attempt and duplicate inserts return the existing record. These methods do not grant completion or publication authority.

## Runtime safety

ForgeVerify runs structured commands with `shell: false`, captures bounded redacted output, and derives result only from its child-process lifecycle. Model text, repository comments, and stdout containing pass-shaped strings have no route to create evidence. Verification completion remains separate from delivery and publication authorization. Evidence from a coder worktree cannot certify an integration worktree because their workspace paths and state hashes differ.

## CF-16R4 certification

The real PostgreSQL certification completed on 2026-09-05. Node `pg` connected to the pre-existing PostgreSQL 16.15 test server, and the PostgreSQL persistence contract was exercised through plan reload, attempt terminalization, immutable evidence, retries, duplicate callbacks, two-client races, and running-attempt recovery. A fresh runtime reconstructed persisted ForgeVerify evidence and a `VerificationSummary`; the Completion Gate accepted it only when the reloaded evidence matched the current state hash. Mutating the workspace after reload retained the historical evidence but made the current obligation stale and unsatisfied.

The PostgreSQL-enabled monorepo gate completed with 170 test files, 1,335 tests, zero failures, and zero skips. The steer-aware `UserIntentHold` / Steer-Aware Execution Hold remains a follow-on ForgeGreen requirement: composer typing, scheduler holds, new runtime states, and related UI behavior were intentionally not added during this certification.
