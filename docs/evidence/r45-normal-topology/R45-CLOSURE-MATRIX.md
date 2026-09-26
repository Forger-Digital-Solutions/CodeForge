# R45 Closure Matrix — Normal-Topology Closure, Explorer Intelligence, Free-Capacity Efficiency & 8-Bit Production Proof

Branch: `codex/r29-release-closure`. Evidence root: `docs/evidence/r45-normal-topology/`.

## Requirement → Evidence

| R45 item | Status | Evidence |
|---|---|---|
| Explorer forensics: per-turn tool trace, batch size, outcome, classification (necessary / serialized-but-batchable / low-information / duplicate-suppressed) | DONE | `toolTrace` in `AgentContextMetrics`; `scripts/r45-explorer-forensics.mjs`; `R45-EXPLORER-FORENSICS.json` |
| Deterministic exploration brief before model navigation (candidates, definitions, consumers, related tests, hash-marked excerpts, recall) | DONE | `packages/context/src/exploration-brief.ts`; explorer + no-explorer coder paths; `R45-READ-PLAN-PROOF.json` |
| Packet excerpts declared read-equivalent, not hints | DONE | Explorer prompt language + packet header; live smoke: coder's first read was the root-cause file |
| Adaptive explorer budget: narrow on coverage, preserve on weakness, scaled by candidates, explicit budgets untouched | DONE | `adaptiveTurnBudget` metrics + `executionBudgetDerived` flag; live `10→5`, `10→4`, `10→10` (weak coverage correctly kept full); `r45-explorer-scaffold.test.ts` 3/3 |
| No-rediscovery handoff to planner AND coder (both paths) | DONE | Orchestrator + plain-runtime injection; `mentionedPaths` seeded from explorer paths; `R45-HANDOFF-EFFICIENCY.json` |
| Morphology-aware retrieval (bounded stem variants) | DONE | `repo-intelligence/src/engine.ts`; false-positive fixture `briefRecall 0/2 → 2/2`; repo-intelligence suite 44/44 incl. 1M-line bench |
| Topology adaptation: orientation coverage + capacity-aware normal→tiny, deterministic receipts, ForgeVerify never removed | DONE | `adaptive-topology.ts` + `orientationProbe`; `adaptive-topology.test.ts` 11/11; `R45-TOPOLOGY-BENCHMARK.json` |
| Provider window telemetry: per-route calls, first-failure, failovers with reason | DONE | `routeWindows`/`routeFailovers` journal fields; `R45-PROVIDER-WINDOWS.json`; live trace: openrouter 429@call0 → mistral codestral (4 calls) |
| Role-quality feedback: turn-budget exhaustion → 8-Bit `role_failed` (model quality ≠ availability) | DONE | `agent-runtime.ts` (gated on `exhaustedModelTurns`); `scripts/r45-role-quality.mjs`; `R45-ROLE-QUALITY.json` (wander → role_failed/EXPLORER persisted; packet arm → none) |
| Free-route inventory + no-false-waiting + 373-user regression | DONE | 64 verified-free routes; 78/78 fabric invariants; `R45-373-USER-REGRESSION.json` 746/746 tasks, 0 starved, 0 false waits |
| Paced live corpus, normal topology, multi-file | DONE (supply-limited) | `R45-LIVE-CORPUS.json`: 5 missions, all `blocked`, `rateLimited: true` each; 6–9 calls; brief delivered 5/5; adaptive budget discriminated; zero paid fallback |
| Tiny vs normal comparison | DONE | `R45-TINY-VS-NORMAL.json`: tiny 3–4 calls (deterministic packet to coder), normal 5–6 (+evidence+reviewer), complex 7–8 |
| Security: repository prose stays inside untrusted-data boundary | DONE | fg3-prompt-injection caught raw packet leak → fixed (`formatUntrustedData` wrap + section ordering); 88/88 context+tools green |

## Live corpus verdict (honest)

All five paced missions terminated `blocked` under provider rate-limit pressure — supply failure,
not agent-quality failure. Per-mission evidence: briefs recalled 2–5 candidate files, explorers
stopped at 2–5 turns (vs 8 pre-fix), coder received handoff, failovers journaled, no paid or
unverified route was ever used. No mission was classified as success.

## Regression state at closure

- context+tools focused sweep: 15 files / 88 tests green
- server focused sweep (r45-scaffold, adaptive-topology, orchestrator integration, fg1, r44): 6 files / 39 tests green
- repo-intelligence: 44/44
- fabric invariants: 78/78; 373-user regression: 746/746
- `npm run build`: clean

## Known limitation

Live corpus produced no completed mission — the free fleet window was saturated through the
measurement period. Capability claims rest on the deterministic harnesses (which complete against
scripted providers through the production path); supply-window claims on the live corpus. A
re-run during a wider free window would strengthen the live-completion signal.
