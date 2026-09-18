# R13 source-freeze checkpoint

Recorded: 2026-09-18 after Priority 9 source validation.

- Historical base: `935ac48435530d46e6686ac8c0ec911a53f45384` (`935ac48`, the immutable R12 closeout).
- Frozen R13 engineering commit: `0743bc2` (`feat: add R13 capacity and shadow intelligence`).
- Branch: `forger-digital-solutions-forgegreen-certified`.
- Historical evidence check: no changed path under `docs/evidence/r11-release-candidate-closure` or `docs/evidence/r12-release-closure`.
- Formatting check: `git diff --check` passed.
- Generated-output review: the only pre-existing scale-report timestamp outputs are non-functional report artifacts; no generated source or benchmark residue was accepted.

The guarded source-state surface contains 31 material files. R13 intentionally changed only these two material members:

| Material file | Review result |
| --- | --- |
| `packages/server/src/agent-runtime.ts` | Capacity advice is consulted only after existing ForgeZero and admission filtering. It cannot make a route eligible or cross into paid/BYOK. |
| `packages/sessions/src/session-state.ts` | Adds typed session-scoped intelligence and paid-evaluation records only; records carry no routing, tooling, verification, or completion authority. |

The guarded recertification produced source state `45d31185f356034a6d49dacdae65b1865cf12a4f6b8f25`, surface `r13-intelligence-recovery-v1`. Post-freeze changes are certification evidence only. Known external blockers are local PostgreSQL availability and trusted Windows signing; the public benchmark is governed by its separate live capacity record.
