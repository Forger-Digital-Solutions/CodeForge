# ForgeGreen FG-6 certification report

## Scope and inherited state

This certification builds immediately upon certified ForgeGreen FG-5 (`31b8b20`).
The inherited FG-5 baseline established deterministic verification obligations, evidence sufficiency evaluation, policy receipts, and Completion Gate integration.

FG-6 implements Gate-Specific Evidence Resolution, Obligation Deduplication, Evidence Subsumption, Minimum Valid Verification Plans, and Durable Resolution Receipts without weakening any FG-5 verification obligation.

## Authority chain

```text
FG-5 (Verification Policy Authority)
  ↓ [hard typed obligations]
FG-6 (Evidence Resolution Authority)
  ↓ [deduplicated, minimal valid verification plan]
ForgeVerify (Execution Authority)
  ↓ [structured execution evidence]
FG-5 (Sufficiency Authority)
  ↓ [evidence evaluation receipt]
Completion Gate (Completion Authority)
```

- **FG-5** remains the sole authority for determining which obligations exist and evaluating whether evidence is sufficient. FG-6 may NOT remove or waive any mandatory obligation.
- **FG-6** determines how those obligations are satisfied, deduplicates exact duplicates while preserving gate/reason provenance, resolves proven subsumptions from structured project configuration, and reuses valid existing evidence.
- **ForgeVerify** executes the deduplicated, minimal plan.
- **Completion Gate** decides task completion based on independent lifecycle gates (approvals, questions, review findings, unfinished plan work) and FG-5 evidence sufficiency. FG-6 `RESOLVED` does NOT equal verification `PASS` and cannot satisfy the Completion Gate.

## Resolution and Subsumption Architecture

### Exact Deduplication with Preserved Provenance
- Canonical obligation identities are computed via SHA-256 over semantic kind, scope, target paths/packages, requirement level, environment requirements, and security namespace.
- Duplicate obligations are deduplicated into a single planned execution while merging and preserving all distinct reason codes and source obligation IDs.

### Structured Project-Configuration Subsumption
- **Workspace Typecheck:** Proven workspace-level typecheck (`npm run typecheck` / `tsc -b`) subsumes package-level typechecks only when referenced in the root `tsconfig.json` project references. Excluded packages are not subsumed.
- **Package Test Suite:** A package test suite subsumes targeted test obligations only when the targeted test paths are verifiably contained in the package test directory. Unknown or cross-package tests are not subsumed.
- **Strict Prohibition of Prose-Based Subsumption:** Repository comments, README claims ("npm test runs everything"), script names (`test:all`), or malicious command stdout (`echo 'Ran package A and B'`) cannot define subsumption.

### Environment-Sensitive & Evidence-Class Preservation
- Simulated/mock tests cannot substitute for `REAL_POSTGRESQL`, `REAL_GIT`, or `REAL_CHILD_PROCESS` requirements.
- If an environmental dependency is unavailable, the obligation is marked `BLOCKED`, never silently downgraded.

### Valid Evidence Reuse First
- Existing valid evidence matching the current content hash, execution revision, and policy version is reused with 0 execution cost.
- Stale, failed, skipped, or timed-out evidence is rejected.

## Persistence and Ledger Metrics

- **Durable Receipts:** `EvidenceResolutionReceipt` records are persisted immutably and idempotently via `insertImmutableWorkItem` as `resolution_receipt` work items across SQLite and PostgreSQL.
- **ForgeGreen Ledger:** Records measured `resolutionObligationsReceived`, `resolutionDuplicatesRemoved`, `resolutionObligationsSubsumed`, `resolutionEvidenceReused`, `resolutionProducersScheduled`, `resolutionDispatchesAvoided`, and cache hits/misses.

## Measured Efficiency Results

In synthetic scale and structural verification benchmarks:
- **1,000 Duplicate Obligations Benchmark:** 1,000 input obligations deduplicated to 2 canonical obligations in <15ms with 998 redundant dispatches avoided.
- **Typical Monorepo Scenario (6 Obligations):**
  - Input obligations: 6 (Workspace typecheck, 2 Package typechecks, Package test suite, 2 Targeted tests)
  - Exact duplicates: 0
  - Subsumed obligations: 3 (2 package typechecks subsumed by workspace typecheck; 1 targeted test subsumed by package test suite)
  - Scheduled producers: 3
  - Redundant dispatches avoided: 3

## Certification Evidence

- **FG-6 Test Battery (`fg6-evidence-resolution.test.ts`):** 11 comprehensive adversarial and authority tests PASS.
- **Session Persistence Battery (`persistence.test.ts`):** Resolution receipt append-only persistence and restart recovery PASS.
- **Delivery Certification (`delivery-certification.test.ts`):** 29 delivery and recovery tests PASS.
- **PostgreSQL Adversarial Battery (`cloud-postgres-adversarial.test.ts` + `cloud-db` + `eight-bit`):** 8 files, 62 tests PASS against real WSL2 PostgreSQL 16.15.
- **Canonical Full Test Suite:** 219 test files, 1,680 tests, 0 failures, 0 skips in 760.69s (`vitest run --fileParallelism=false`).
- **Typecheck:** `npx tsc -b --force` PASS.
- **Production Build:** `npm run build` PASS.

## Boundary to FG-7

FG-7 Verification Coverage Authority remains next. FG-7 was not prematurely implemented.
