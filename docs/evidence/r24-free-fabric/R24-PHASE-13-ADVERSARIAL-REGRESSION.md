# R24 Phase 13 Checkpoint — Admission Is Not Verification + Canonical Regression

Date: 2026-10-06 · Branch: `forger-digital-solutions-forgegreen-certified`
Prior: `00bf295` (Phase 11–12 — multi-pool fabric + production-shaped pilot)

## Verdict

**`R24_ADMISSION_COMPLETION_BOUNDARY_PROVEN`** — a run can hold a real Free Fabric
admission, execute provider calls under a live reservation, claim a change, and
still terminate `blocked` with `no_effective_change`, because `evaluateCompletion`
is the only authority that reaches `completed`. Admission, execution, and claim are
necessary but never sufficient.

Mechanism verdict, not a live-provider claim: all evidence is deterministic,
in-process, $0.

## The adversarial boundary

`packages/server/test/r24-admission-vs-completion.test.ts` (1 flight through the
real `AutonomousRunOrchestrator` path, scripted providers):

```text
Free Fabric ADMITS → live reservation → provider executes →
coder reports "I edited src/auth/session.ts" → working tree has no such change →
completion gate → BLOCKED / no_effective_change → reservation released
```

| Assertion | Evidence |
|---|---|
| Admission alone cannot produce completion | Run is admitted (reservation exists), yet outcome is `blocked` |
| Claiming an edit ≠ making one | Gate's `no_effective_change` fires on diff review, not on the coder's narration |
| The gate is authoritative | No path from admitted+executed+claimed to `completed` exists outside `evaluateCompletion` |
| Blocked runs still drain | `activeReservations` returns to 0; no leaked holds on the terminal path |

This closes the last un-proven seam in the campaign's own claim chain: previous
phases proved admission is *correct* (role-matched, capacity-bounded,
health-aware); this phase proves admission is *not sufficient* — the two must
never be conflated in the fabric's evidence.

## Canonical regression

| Suite | Result |
|---|---|
| `packages/eight-bit` full | 243/243 (+2 skipped postgres) |
| `packages/forge-zero` full | 117/117 |
| `packages/model-registry` full | 90/90 |
| `packages/server` focused (fabric wiring, topology capacity, adaptive wiring, pilot, adversarial) | 30/30 |
| `npm run build` (workspace) | clean |
| `npm test` (workspace) | 3472 passed / 4 failed / 48 skipped — all four triaged below |
| `npx tsc --noEmit` (server, eight-bit) | clean |

### Full-suite failure triage

| Failure | Disposition |
|---|---|
| `server/test/role-routing.test.ts` — expected `explorer → TOOL_AGENT` | **Stale assertion on the intentionally removed conflation.** `EXPLORER` is a first-class role since Phase 10; the assertion encoded the old aliasing. Updated to `EXPLORER`; file now 8/8. |
| `forgegreen-campaign/fg11-source-state.test.ts` + `fg12e-harness-provenance.test.ts` | **Certified source-state drift from already-committed R24 work.** The FG certification (`12cfd79`, pre-R24) hashes `agent-runtime.ts`, `autonomous-orchestrator.ts`, `session-state.ts` — all legitimately evolved by Mission A/C/Phase 7–10 commits. Drift is in committed code on a clean tree, not Phase 13. Recertification follows the R23 precedent (`424aff2`) and belongs to the Phase 14 evidence freeze. |
| `workflow/r21-forgeverify-malicious-corpus.test.ts` — `shell-wrapper-hides-silent-failure` | **Flake under full-suite parallelism.** Untouched R21-era package; passes 24/24 standalone (54s of real subprocess spawning). Matches AGENTS.md's known wall-clock sensitivity for heavy integration tests. |

## Lint hygiene

`npm run lint` fails at HEAD on **pre-existing** debt in files untouched by R24
(unused imports in `external-tools-wiring.test.ts`, plugins, cloud-DB tests;
spread warnings in `workflow-service.ts`). Verified by linting at the base
commit. R24 introduced 8 findings across its own files; all are fixed:

- `role-qualification.test.ts` — unused `runCompactQualification`, `ModelQualificationReceipt`
- `r24-role-routing.test.ts` — unused `roleReceipt` helper, `ROLE_QUALIFICATION_SUITE_VERSION`, `ModelQualificationReceipt`
- `role-suite.ts` — unused `roleOfId` planner-graph helper
- `runtime.ts` — redundant nested spread on the queued verdict
- `r24-serving-pilot.test.ts` — unused `managedProvider`, unnecessary fallback spread
- `free-fabric.test.ts` — unused `FreeFabric` type import (pre-existing, same file family)
- `index.ts` — unused `isWorkspaceEvent` import (pre-existing, R24-touched file)

Post-fix status: `eight-bit`, `forge-zero`, `model-registry` lint **clean**
(0 errors / 0 warnings). `server` has 0 errors and 2 warnings, both pre-existing
`...(existing ?? {})` spreads in `workflow-service.ts`. Remaining repo-wide debt
predates R24 and is out of scope for this campaign.

## Money

$0 spent. Deterministic in-process fixtures only.

## Known limitations / open work

- **Adversarial coverage is mechanism-level.** The gate blocks a *claimed* change
  that produced no diff; it does not (yet) judge semantic correctness of a diff
  that *was* produced — that is ForgeVerify's reviewer-evidence lane, not this
  boundary test's.
- **Pre-existing lint debt remains repo-wide.** Out of scope for R24; recorded
  here so it cannot be confused with new findings.
- Phase 14 (final checkpoint + evidence freeze) remains.
