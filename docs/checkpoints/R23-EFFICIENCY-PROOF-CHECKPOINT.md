# R23 Efficiency Proof — Continuation Checkpoint

Updated: 2026-09-20 (M4 complete)
Branch: `forger-digital-solutions-forgegreen-certified`
Base: `ae2aa87` (R22 closure) — verified clean at M0.

## HEAD and tree

| | |
|---|---|
| HEAD | `7969481` R23 M3-M4: run-record schema, per-call ledger, usage accounting, golden tests |
| Previous | `1ada7c0` R23 M0-M2: recovery note, measurement inventory, frozen efficiency protocol |
| Dirty state | clean after each commit (verify with `git status --porcelain`) |
| Canary status | **No canary-covered material file has been modified.** Changed source: `packages/providers/src/{chat-types,openrouter,openai-compatible}.ts`, `packages/server/src/model-execution-adapter.ts` (none in `docs/codeforge-forgegreen-certified-source-state.json`). Run `node node_modules/vitest/vitest.mjs run packages/forgegreen-campaign/test/fg11-source-state.test.ts` to confirm. |

## Completed phases

- **M0 Recovery** — `docs/evidence/r23-efficiency-proof/recovery/R23-RECOVERY-NOTE.md`.
- **M1 Measurement inventory** — `docs/evidence/r23-efficiency-proof/instrumentation/R23-MEASUREMENT-INVENTORY.md` (9 critical gaps identified).
- **M2 Frozen protocol** — `docs/benchmarks/codeforge-efficiency-protocol-r23.md` v1.0.0, sha256 `7f5e4b5bcbfe6de82b3139b93617430a77f2128369b155d70ec22d2786d237c9` (`protocol/PROTOCOL-DIGEST.txt`). Frozen before any paired result.
- **M3 Instrumentation** — `packages/forgegreen-campaign/src/r23/*` (see commit `7969481`). Gaps 1–7 and 9 from the inventory are closed at the harness boundary; gap 8 (cross-run roll-up) is closed by the orchestrated mode ledger (all children's calls in one record).
- **M4 Golden tests** — 36 tests green: `packages/forgegreen-campaign/test/r23-*.test.ts` (4 files) + `packages/providers/test/r23-openrouter-usage-accounting.test.ts`.

## Live capacity facts (owner-confirmed 2026-09-20)

- OpenRouter account: `free_model_daily_requests {limit: 1000, used: 59}` at 19:40 local; `total_credits 25, total_usage 0`. `:free` routes are $0; the deposit unlocks the 1,000/day tier and **must never be consumed** (exact-pin `:free`, `lock: "route"`).
- 20 tool-capable `:free` models in the live catalog (list in the recovery note / probe output).
- Groq (8K TPM), Cerebras ($5 trial), Gemini (403), OpenAI (paid) — not used for the headline.
- Mistral Free (PAYG disabled, $10/month included, training-permitted account) — optional replication only.

## Current benchmark status

- Harness proven end-to-end with a scripted model in both execution modes (single-agent and orchestrated) and both arms. **No live model run has been made yet.**
- Pilot corpus: not yet authored (next action).
- Pricing snapshot: not yet frozen (taken from the live OpenRouter catalog on the qualification day).

## Known blockers / owner actions

1. None blocking the pilot. Live runs consume the owner's OpenRouter daily `:free` allowance (1,000/day) at $0.
2. Live GitHub publication remains OWNER ACTION REQUIRED (unchanged from R22).
3. Postgres-gated suites still skip without `CODEFORGE_TEST_POSTGRES_URL`.

## Failing tests

None known. Canonical suite not yet re-run since R22 close (do so before the M5 pilot commit and at every milestone commit that touches `packages/`).

## Next exact action

1. Author the pilot corpus: 12 tasks + 3 qualification tasks under `benchmarks/r23/tasks/<task_id>/{task.json,fixture/,hidden/}`; freeze `benchmarks/r23/tasks/manifest.json` with `freezeManifest`.
2. Write `scripts/r23-efficiency-bench.mjs` (modes: `snapshot-pricing`, `qualify`, `pilot`, `main`; capacity gate from `/api/v1/auth/key`; exact `:free` $0 pin check from the live catalog before registering the ForgeZero record; raw records to `docs/evidence/r23-efficiency-proof/raw/<phase>/`; `exclusions.jsonl` append-only).
3. Write `scripts/r23-efficiency-report.mjs` (recompute every summary from raw; paired bootstrap CIs per protocol §8.3).
4. Freeze the pricing snapshot; run the qualification round; record `pilot/MODEL-SELECTION.json`; run the pilot; write `pilot/R23-PILOT-REPORT.md` against the §16 gate.

## Evidence paths

`docs/evidence/r23-efficiency-proof/{recovery,instrumentation,protocol,schemas}` populated; the remaining directories exist and are empty by design until their milestone.
