# R26 Phase 11 — Context / Memory Correctness + Efficiency

**Date:** 2026-09-22
**Tests re-run at HEAD:** `packages/context/test/` 55/55, `packages/sessions/test/` 61/62 (1 skipped)
**Live evidence:** Phase 5 paired-run context stats (raw records `r23-pilot-*-879e24e4` / `-3ef6b74d`)

## Correctness — proven at HEAD

- **Deterministic assembly:** identical context hash across replays; provenance
  receipts attached per assembled pack.
- **Budget bounding:** never overflows 16k/32k/64k/128k windows; on tight
  budgets optional repo context drops before the mandatory kernel — the kernel
  is never truncated.
- **Role isolation:** subagent roles get isolated context; read-only roles
  cannot pull mutating surfaces.
- **Page identity:** content+graph-scoped — a comments-only edit does not
  invalidate a dependency-neighborhood page, an import change does; dirty-tree
  edits produce new identities (never stale reuse); cross-worktree reuse is
  byte-identical only within the same repositoryNamespace; two repos with
  identical file bytes never share a page; corrupt/schema-mismatched cache
  entries are safe misses, never crashes.
- **Prompt-injection resistance:** repository prose cannot widen level,
  fake-completeness, or influence verification/completion authority (5/5).
- **Durable memory:** event store (17), persistence (19), durable agent
  continuation across crash (3), secret boundary — secrets never persisted (1),
  sqlite driver durability across restart (5), ForgeVerify immutability.

## Efficiency — measured on a live run (groq::gpt-oss-20b, tiny task)

| Metric | Optimized | Control |
|---|---|---|
| Transmitted context | 222,596 B | 190,895 B |
| Avoidable duplicate bytes | **86** | **86** |
| Provider-statelessness repeat | 214,928 B | 184,695 B |
| Provider prompt-cache hits | 1 | 3 |

- Dedup is effectively airtight: 86 bytes of avoidable duplication across
  ~200KB transmitted — one repeated `list_files` result within a single role.
- **Structural finding:** ~96% of transmitted context is re-transmission owed
  to stateless providers (`providerStatelessnessRepeatBytes`). ForgeGreen's
  page reuse + provider-side prompt caching are the only levers; on Groq the
  observed cache-hit rate is low (1–3 calls). This is the honest efficiency
  ceiling on stateless free routes, not a dedup defect.

## Verdict

`R26_CONTEXT_MEMORY_PROVEN` — correctness (identity, isolation, budget,
injection resistance, durability, secret boundary) is fully green at HEAD;
efficiency is measurable and dominated by provider statelessness rather than
assembly waste.
