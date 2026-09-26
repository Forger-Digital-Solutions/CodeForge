# R44 Regression Record

Final regression pass, all suites green on the recertified source state
(`r44-multifile-intelligence-v1` / `d863c424…`).

## R44 targeted surface — 71/71

| Suite | Tests | Coverage |
|-------|-------|----------|
| `packages/server/test/r44-edit-discipline.test.ts` | 6 | Blind-edit denial + recovery recipe, hash auto-attach + drift fail-closed, new-file create vs blind overwrite denial, write-drift denial, fenced-block repair telemetry, exhaustion → `converged_failed` journal pin |
| `packages/server/test/r44-reviewer-visibility.test.ts` | 3 | Planted defect beyond the retired ~2KB slice reachable in reviewer context; truncation marker honest |
| `packages/tools/test/r44-compression-formats.test.ts` | 9 | Vitest/TAP `✗`/`×`, `AssertionError`, Jest `●`, Go `--- FAIL`, pytest `FAILED`, Rust `panicked`, `Segmentation fault`, repeated stacks |
| `packages/tools/test/fg1-compression.test.ts` | 9 | Determinism, boundedness, head/exit markers, fold counts, provenance |
| `packages/agent/test/structured-output-security.test.ts` | 19 | Adversarial extraction cases + R44 repair-order paths |
| `packages/tools/test/no-effect-write.test.ts` | 2 | `TOOL_NO_EFFECT` broker denial |
| `packages/tools/test/prompt-tool-contract.test.ts` | 4 | Prompt/tool contract coherence |
| `packages/tools/test/role-boundary.test.ts` | 2 | Read-only role enforcement |
| `packages/tools/test/command-exit-status.test.ts` | 1 | Nonzero exit → structured failure |
| `packages/server/test/agent-orchestrator-integration.test.ts` | 8 | Full pipeline E→P→C→R→V→I incl. scripted coders updated to the read→write contract |
| `packages/server/test/fg1-runtime-efficiency.test.ts` | 8 | Suppression/receipts under the new gate (fixtures updated where they scripted blind writes) |

## ForgeGreen campaign + workflow — 326 passed / 1 skipped

44 files, including the recertified canaries:

- `fg11-source-state.test.ts` (5/5) — live tree matches the re-issued certified
  source-state document.
- `fg12e-harness-provenance.test.ts` (3/3) — harness identity byte-stable,
  no fg12e files in the material set.
- `fg12d-trial-runner`, `fg11-*` observation/aggregator/candidate suites —
  all green.

## Deterministic harnesses

| Harness | Result |
|---------|--------|
| `scripts/r44-provider-saturation.mjs` | 28/28 checks |
| `scripts/r44-role-benchmark.mjs` | 15/15 checks |
| Compression proof (fg1 + r44 formats) | 18/18 |

## Live corpus (separate from tests — honest record, not pass/fail)

- `R44-MULTIFILE-CORPUS.json`: 14 arms, 0 completed, 14 blocked, all
  `RATE_LIMITED`; zero paid fallback.
- `R44-MISSION-TINY-1.json`: 1 **completed** mission (adaptive→tiny plan).
- `R44-MISSION-RETRY-1/2/3.json`: 4 arms, blocked on rate limits /
  explorer turn limit — the residual-defect record.
