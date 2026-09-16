# CodeForge full-agent and app release-readiness audit

Date: 2026-09-16

## Verdict

`CODEFORGE_FULL_AGENT_HARDENED_RELEASE_BLOCKERS_REMAIN`

This campaign fixed three confirmed fail-closed/recovery defects and passed the focused deterministic and process-boundary matrix. It did not produce a fresh legitimate Managed-Free whole-agent run, a current packaged-desktop visual smoke, or sustained R4 capacity evidence. Those facts prevent a stronger verdict.

## Starting state

The audit began clean on `forger-digital-solutions-forgegreen-certified` at `d0e946bd063bcba69a390b5e94ba65a4200cd560`. The starting facts for ForgeGreen R1 and R4 are preserved unchanged: `CODEFORGE_FORGEGREEN_R1_EXTERNAL_PROVIDER_PENDING` and `CODEFORGE_R4_CAPACITY_LIMITED_EXTERNAL_EVIDENCE_PENDING`.

## Implemented authority map

| Area | Source authority | Audit state |
| --- | --- | --- |
| Managed-free eligibility | `packages/forge-zero/src/firewall.ts` `ForgeZero.verify` | IMPLEMENTED + ACTIVE |
| Qualification vs routing | `packages/eight-bit`, `packages/router`, `packages/server/src/model-execution-adapter.ts` | IMPLEMENTED + ACTIVE |
| Runtime roles/tools/recovery | `packages/server/src/agent-runtime.ts` `AgentRuntime` | IMPLEMENTED + ACTIVE |
| Parallel worktrees | `packages/server/src/parallel-orchestrator.ts` | IMPLEMENTED + ACTIVE |
| Verification | `packages/workflow/src/forge-verify.ts` `runForgeVerify` | IMPLEMENTED + ACTIVE |
| Completion authority | `packages/workflow/src/completion-gate.ts` `evaluateCompletion` | IMPLEMENTED + ACTIVE |
| Desktop trust boundary | `apps/desktop/src/main.ts`, `preload.cjs` | IMPLEMENTED + ACTIVE |
| 8-Bit future training | `packages/eight-bit`, `tests/evidence/r3.5-8bit-dataset` | IMPLEMENTED + PARTIAL |
| Fresh external live proof | provider qualification evidence | BLOCKED (not re-run; no credentials/capacity spent) |

## Confirmed defects and repairs

1. `CFA-001` (P0): an explicit model registered in a provider catalog but absent from ForgeZero could reach that provider. `ModelExecutionAdapter.resolveModel` now rejects unregistered exact models before execution. The regression also proves provider `streamChat` is not called.
2. `CFA-002` (P1): server stop closed persistence while live agent loops could still publish best-effort events. `AgentRuntime` now tracks executions and drains them after cancellation; `CodeForgeServer.stop` cancels workflows and runtimes before persistence closes.
3. `CFA-003` (P1): OpenRouter HTTP 200 SSE with no usable choices could become a clean `stop`. The adapter now emits retryable `EMPTY_COMPLETION` and the non-stream response path rejects an empty choices array.

The machine-readable ledger is [defect-ledger.json](../../tests/evidence/full-agent-audit/2026-09-16/defect-ledger.json).

## Evidence and tests

Passed after repairs:

- Provider/exact-model/recovery/steering matrix: 38 tests in 6 files, including real process-boundary crash recovery.
- Desktop/parallel/verification matrix: desktop security and bridge gates, ForgeVerify evidence, completion, steering, cancellation, real concurrent worktrees, conflict handling, synthesis restart, and scoped-steer recovery.
- TypeScript forced build: passed.
- Desktop main and renderer production build: passed. Vite reports a 649.79 kB JavaScript chunk warning; this is a P3 performance follow-up, not a correctness pass/fail.

`npm test` was attempted but the host run emitted no final aggregate summary. It must be repeated in CI/a stable host before release certification; no aggregate all-suite pass is asserted.

## Honest limits and release blockers

- No fresh legitimate Managed-Free end-to-end autonomous task was run. Existing historical provider evidence is preserved, but it is not current proof.
- No current packaged executable smoke/visual desktop inspection was run. The native automation surface had no targetable desktop app; repository desktop tests/builds passed.
- R1R remains externally pending; no matched pair was started.
- R4.6 remains capacity-evidence pending; the scale simulator is not a sustained-capacity certification.
- Full Vitest aggregate completion requires a stable CI/host run.

## Dogfood assessment

`LIMITED_DOGFOOD_READY`: deterministic AgentRuntime, verification, recovery, cancellation, steering, and worktree conflict paths have strong focused evidence. Restrict use to supervised internal work until the four release blockers above are cleared. The provider subscription decision remains `OPTIONAL_LATER`; no paid capacity is authorized or required for this campaign.
