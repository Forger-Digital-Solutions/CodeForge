# R46 Baseline — Free Supply Resilience & 8-Bit Live Closure

Recorded before any R46 source change.

## Repository

- Branch: `codex/r29-release-closure` (verified via `git branch --show-current`)
- HEAD: `134904b` — "R45: closure matrix, tiny-vs-normal comparison, explorer-efficiency verdict"
- Dirty paths (preserved, untouched):
  - `scripts/r11-codeforge-bench-r2-executor.mjs`
  - `scripts/r20-postgres-admission-benchmark.mjs`
- Untracked: none outside this evidence directory.

## Certified source state

- Doc: `docs/codeforge-forgegreen-certified-source-state.json`
- Surface version: `r44-multifile-intelligence-v1` (recertified 2026-09-26, 39 material files)
- **Expected drift**: R45 modified material files (`agent-runtime.ts`, `context/index.ts`,
  `adaptive-topology.ts`, `autonomous-orchestrator.ts`, `subagent-manager.ts`,
  `repo-intelligence/engine.ts`, `agent/index.ts`, `tools/compress.ts`-adjacent code) without
  recertification — deferred per convention to end-of-round. `fg11-source-state` and
  `fg12e-harness-provenance` canaries therefore report drift at R46 open (2 failed, 6 passed).
  Resolution: R46 recertification (`r46-free-supply-resilience-v1`) after material changes land.

## R45 evidence present

`docs/evidence/r45-normal-topology/` — 14 artifacts: baseline, forensics, read-plan proof,
handoff efficiency, planner value, topology benchmark, provider windows, role quality,
tiny-vs-normal, live corpus + smoke, 373-user regression, explorer efficiency, closure matrix.

## R45 regression state at R46 open (carried verified)

- context+tools: 15 files / 88 tests green
- server focused (r45-scaffold, adaptive-topology, orchestrator, fg1, r44): 39/39 green
- repo-intelligence: 44/44 (incl. 1M-line benchmark)
- fabric invariants: 78/78; 373-user regression: 746/746, 0 starved / 0 false waits / 0 leaks
- `npm run build`: clean at `134904b`

## R45 live state (defines R46)

- Live corpus: 5/5 normal-topology missions `blocked`, `rateLimited: true` on each; 6–9 calls;
  briefs delivered 5/5; adaptive budgets discriminated (10→4, 10→5, 10→10); explorers stopped
  at 2–5 turns; coder handoff worked; zero paid fallback.
- Bottleneck after R45: external free-supply saturation at mission time, not agent turn waste.

## R45 machinery to preserve (do not regress)

Exploration Brief, adaptive explorer budgets (`executionBudgetDerived`), toolTrace forensics,
`routeWindows`/`routeFailovers` journal telemetry, role-quality `role_failed` observations,
capacity+coverage-aware topology, coder evidence injection on both paths, stem-variant
retrieval recall, untrusted-data wrapping of the deterministic packet.
