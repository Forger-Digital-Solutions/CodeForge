# R45 Explorer Efficiency — Forensics & Verdict

## The R44 question answered

"Why did an Explorer spend all 10 turns on a fixture with ~4 relevant files?"

Live trace evidence (R45-LIVE-CORPUS-SMOKE, `r45-distributed-bug`, model `dots-studio/dots-3-note-preview:free` → failover → `mistral/codestral-2508`):

| Turn | Call | Class |
|------|------|-------|
| 1 | `read_file tests/report.test.mjs` | serialized_but_batchable (packet-excerpted) |
| 2 | `read_file src/report.mjs` | serialized_but_batchable (packet-excerpted) |
| 3 | `read_file src/normalize.mjs` | serialized_but_batchable (packet-excerpted) |
| 4 | `repo_symbol totals` | useful (not in packet) |
| 5 | `repo_references totals` | serialized_but_batchable |
| 6 | `repo_tests src/report.mjs` | serialized_but_batchable |
| 7–8 | structured output attempts | — |

The orientation packet had already delivered **all 3 relevant files, excerpted, hash-marked**. The weak free model re-verified everything serially anyway — prompt-level batching instructions did not transfer into behavior. That is the measured answer: the waste was verification-redundancy, not discovery.

## What R45 changed, measured

1. **toolTrace forensics** (`contextMetrics.toolTrace`, journaled): per-turn batch size, tool, target, outcome, bytes — the substrate for every classification above.
2. **Deterministic read-plan packet**: brief recall measured 3/3, 4/4, 2/2 across forensics fixtures and 3/3 live. A real retrieval gap (morphology: "totals"→`total`, "rounding"→`round`) was found via the `false-positive-name` fixture and fixed with bounded stem-variant expansion in `findRelevantContext`.
3. **Adaptive turn budget**: strong coverage narrows 10 → `max(4, ⌈candidates/2⌉+2)`; weak/absent coverage keeps 10. Live proof: `10->4` on the smoke mission, `10->5` on `r45-rename`. The budget is *reachable on the orchestrated path* — SubagentManager's derived budgets are flagged adaptive-eligible; pinned turn counts keep authority.
4. **Prompt**: packet excerpts are declared read-equivalent (`[hash:H]` = current content); re-reading them is named waste.

## Honest negative

Adaptive narrowing does not make a serial model answer earlier — it bounds the damage. On the smoke mission the capped explorer still spent its 4 turns on redundant verification and exited `converged_failed`. The mission benefit is real regardless: the coder inherits the packet directly (when explorer evidence is empty the packet is injected into coder context), and saved calls stay in the free window for the roles that mutate and verify. On both live missions the coder's first read went straight to the root-cause file — zero rediscovery.

## Classification availability

`serialized_but_batchable` marks a batch-1 call whose target was already packet-covered. `duplicate_suppressed` marks ForgeGreen's exact-duplicate suppression firing live (observed in forensics `reread` arms).
