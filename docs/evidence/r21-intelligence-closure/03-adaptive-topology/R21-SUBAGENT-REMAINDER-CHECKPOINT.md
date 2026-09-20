# R21 Subagents Remainder Checkpoint (M10c)

Recorded: 2026-09-20
Branch: `forger-digital-solutions-forgegreen-certified`
Scope: worktree isolation, handoff quality, fan-out/failure recovery — verified, no code changes needed.

## Verified against real Git worktrees (all 32 green)

**Worktree isolation & concurrency**
- Two Coders run concurrently in **separate real worktrees**; clean synthesis promoted.
- A denied Coder direction leaves the sibling worktree unmodified (parallel-security).
- Private Coder/Reviewer context stays inside its own agent; only public artifacts cross.
- Synthesis writers confined; both reviewer roles read-only.

**Failure handling (fail-closed, never silent)**
- Real textual Git conflict → fail closed, **every workstream branch retained**.
- Clean synthesis that fails real global verification → promotion blocked.
- IntegrationService divergence protection when the user advances the target mid-run.
- Persisted synthesis revision mismatch vs real Git → fail closed.
- Missing persisted synthesis worktree → fail closed.

**Recovery / durability**
- Restart during synthesis: resumes without reapplying already-incorporated workstreams
  (cherry-pick idempotency proven by commit inspection).
- Scoped steering consumed exactly once; queued steer survives restart and cannot be
  claimed by the wrong workstream.
- Cancellation retains dirty+committed autonomous work, releases leases, idempotent
  on a second cancel.
- Cross-process recovery leases gate worker resumption (subagent-manager R2 journal path).

**Handoff quality**
- Contracts publish only public evidence; consumers invalidated on revision drift.
- Restart after dispatch persists stable identities — a second Coder is never dispatched.
- Ownership/dependency/cycle validation + writer-ceiling fan-out bounds.

## Suites run

`parallel-orchestrator-integration` (4), `parallel-security` (3), `parallel-recovery` (3),
`parallel-cancellation` (1), `parallel-contracts-recovery` (2), `parallel-workstreams` (2),
`parallel-api` (1), `subagents` (9), `multi-subagent-concurrency` (5),
`cf17-parallel-scoped-steer` (2) — **10 files / 32 tests green**.

## Boundary (honest)

- All evidence above is deterministic local runtime + real Git — no paid infrastructure.
- `vision` topology plans remain contract-level (no vision worker exists); the adaptive
  planner only emits them via explicit `topology`/`hasImages` input, never auto-selects.

## Certification label

Subagents (isolation, handoff, fan-out, failure recovery): **VERIFIED — evidence-backed.**
