# R27 Phase 1 — Forensic Recovery & R26 Baseline Verification

**Recorded:** 2026-09-22  
**Repository:** `G:\CodeForge`

## Repository state

| Item | Observed value | Status |
| --- | --- | --- |
| HEAD | `c42a8bc35d95a1c158703ad99d92945f5b4fbe17` | verified |
| HEAD subject | `R26 Phase 17: final evidence freeze + release verdict` | verified |
| working tree | clean; `git status --porcelain=v1` produced no entries | verified |
| active branch | `forger-digital-solutions-forgegreen-certified` | verified |
| R26 stash | `stash@{0}: On forger-digital-solutions-task-fix: preserve task-fix forgegreen work` | preserved |
| recent release tags | `v0.2.0`, `v0.1.0`, `v0.1.0-test-debug` | inspected |
| accidental push/deploy | no push or deployment command issued by R27 Phase 1 | verified for this campaign |

The active branch has the R26 commit chain through `c42a8bc`. The repository was not
reset, rebased, cleaned destructively, or modified to remove prior evidence.

## R26 evidence recovery

The R26 evidence directory exists at
`docs/evidence/r26-production-readiness/` and contains the final verdict, release
blocker ledger, regression report, live roster, ForgeGreen benchmark, subagent,
context/memory, semantic verification, desktop, GitHub, permissions, recovery,
server, canary, database-chaos, and capacity artifacts.

The recovered R26 verdict is:

`R26_RC_READY_WITH_CONDITIONS`

The following R26 claims are execution-backed and retained as prior evidence:

- `forge serve` HTTP runtime: 13/13 server E2E checks;
- six qualified zero-cost routes in the recorded roster;
- packaged desktop startup/runtime/security/audit coverage;
- permission audit 18/18 and GitHub audit 18/18;
- context/memory suite 55/55;
- deterministic subagent machinery 21/21;
- semantic verification corpus and canonical regression evidence;
- database chaos 20/20 exactly-once through seven kill rounds.

The following R26 limits are carried forward as R27 hypotheses, not resolved claims:

- ForgeGreen had one valid live tiny-task pair and lost on calls, tokens, and wall time;
- live subagent value was not measured because the paired quota was consumed by the
  ForgeGreen campaign;
- Planner supply was effectively one qualified route;
- packaged browser/MCP dependencies were audited as shipped but not exercised in a
  packaged runtime smoke leg;
- managed multi-user capacity and 373-DAU owner-pool support were explicitly not
  proven;
- the R4 capacity simulator was recorded as stale/broken.

## Provenance discrepancy requiring R27 recertification

R26’s final verdict says its freeze commit is `b71d894`, while the actual current HEAD
is the later `c42a8bc` documentation commit. R26 desktop evidence also says the
artifact was built from the `221226e` tree and embeds `dirty=true`, while the desktop
report names an older `04aee58` build identity. The bytes currently present in the
repository were independently hashed below, but source-to-artifact identity is not
treated as certified by this recovery note.

R27 must recertify the exact source tree, build identity, asar contents, installer,
portable executable, and packaged smoke results before any final release claim.

## Current shipped-byte hashes

SHA-256 hashes observed with `Get-FileHash` on 2026-09-22:

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `apps/desktop/release/CodeForge-Setup-0.4.0.exe` | 120,457,173 | `b6a9c038143f855b8c8f39b2c02d1213a7b131f21978e4e58fd96e9704d4ac2f` |
| `apps/desktop/release/CodeForge-Portable.exe` | 120,121,723 | `cad62e03b55acc8e53690122ba7f84109c775eb31ab18e60c335969b5b67ac38` |
| `apps/desktop/release/win-unpacked/resources/app.asar` | 43,236,239 | `1e4f6d68dc92c9b7cf5f8be4906c98dfa16b29bbde7523c3394e58a6cf7e566f` |

These are observations of existing bytes, not a new build or certification.

## Provider and cost posture

No inference request, paid probe, provider qualification run, deployment, or push was
performed during this recovery step. Provider posture is read from R26 evidence and
source contracts only: free routing remains ForgeZero/8-Bit governed; unknown free
status must fail closed; GEMS has no production learned-model integration; low-cost
paid routes remain unproven for R27 until a bounded probe is justified.

## Baseline blockers to resolve

1. Reconcile source/build identity and recertify the packaged artifact.
2. Create a comparable whole-agent scorecard and golden-task manifest.
3. Find ForgeGreen’s task-size crossover and prevent tiny-task overhead.
4. Measure live subagent value separately from deterministic machinery.
5. Improve or honestly bound Planner supply without weakening semantic qualification.
6. Exercise browser/MCP behavior in the packaged product.

This document is additive evidence. It does not rewrite or alter R26 artifacts.
