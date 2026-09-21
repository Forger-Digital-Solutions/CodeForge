# R23 Efficiency Proof — Continuation Checkpoint

Updated: 2026-09-20 (post-interruption recovery; M5 prescreen interrupted)
Branch: `forger-digital-solutions-forgegreen-certified`
Base: `ae2aa87` (R22 closure) — verified clean at M0.

## HEAD and tree

| | |
|---|---|
| HEAD | `70dfbf8` R23 M5 prep: pilot corpus, bench runner, report tool, dry run, Python verifier fix |
| Previous | `7969481` M3-M4 · `1ada7c0` M0-M2 · `ae2aa87` R22 closure |
| Dirty state | 3 untracked: `packages/forgegreen-campaign/test/r23-report-statistics.test.ts` (8/8 green), `pilot/MODEL-PRESCREEN.json` (interrupted prescreen), `raw/qualification/` (1 run record). No modified tracked files. |
| Canary status | No canary-covered material file modified since R22 recertification (verify: `node node_modules/vitest/vitest.mjs run packages/forgegreen-campaign/test/fg11-source-state.test.ts`). |

## Completed phases

- **M0 Recovery** — `recovery/R23-RECOVERY-NOTE.md`.
- **M1 Measurement inventory** — `instrumentation/R23-MEASUREMENT-INVENTORY.md` (9 critical gaps identified).
- **M2 Frozen protocol** — `docs/benchmarks/codeforge-efficiency-protocol-r23.md` v1.0.2, sha256 `f522cc7ce5355cf72b4ac09c052d5328db45bb3764b79c40270c13ea5faccb1f` (`protocol/PROTOCOL-DIGEST.txt`). Frozen before any paired result; v1.0.1/v1.0.2 amendments landed before the first live run.
- **M3 Instrumentation** — `packages/forgegreen-campaign/src/r23/*`; inventory gaps 1–7, 9 closed at the harness boundary; gap 8 via orchestrated-mode ledger.
- **M4 Golden tests** — 36 tests + 8 report-statistics tests (the latter committed post-M5, this recovery).
- **M5 prep** — 15-task corpus generated + frozen (`benchmarks/r23/manifest.json`, gitignored task dirs, digest pinned); pricing snapshot `cost/pricing-snapshot-2026-09-21.json`; scripted dry-run of all 15 tasks both arms green; report tool `scripts/r23-efficiency-report.mjs`; Python verifier runtime fix (`packages/workflow/src/child-process.ts`).

## Live capacity facts (owner-confirmed 2026-09-20)

- OpenRouter: `free_model_daily_requests {limit: 1000}` resets 00:00 UTC; deposit unlocks the tier and **must never be consumed** (exact-pin `:free`, `lock: "route"`, $0/$0 re-checked in the live catalog per run; any `actual_cost > 0` halts the campaign).
- 19 tool-capable `:free` candidates in the live catalog at prescreen time (excluding `openrouter/free`).
- Groq (8K TPM), Cerebras ($5 trial), Gemini (403), OpenAI (paid — never used). Mistral Free — optional replication only, synthetic fixtures.

## Current benchmark status

- Harness proven end-to-end: scripted dry run (15 tasks × 2 arms) + **one live qualification run** (`inclusionai/ling-3.0-flash-vl:free`, provider_failure — upstream 400 invalid request; per-call ledger captured provider-reported prompt/completion/cached/reasoning tokens on 5/6 calls).
- **Prescreen attempt 1 incomplete:** candidate 1 ran; candidates 2–19 refused `ineligible: tree dirty` because the runner re-checks the tree per candidate and its own `raw/qualification/` output dirtied the tree. Preserved in git; superseded by a complete re-run.
- **Decision (this recovery):** prescreen/qualify re-run with `--allow-dirty` — the protocol's own escape hatch (§1); `dirtyFiles` is recorded in every run record. `pilot`/`main` check the tree once per campaign, so they start clean after evidence commits.
- No model selected yet; no pilot run yet.

## Known blockers / owner actions

1. Live runs consume the owner's OpenRouter daily `:free` allowance at $0 — authorized.
2. Live GitHub publication remains OWNER ACTION REQUIRED (unchanged from R22).
3. Postgres-gated suites skip without `CODEFORGE_TEST_POSTGRES_URL`.

## Failing tests

None known. Canonical suite re-run at recovery (see commits for results).

## Next exact action

1. `node scripts/r23-efficiency-bench.mjs prescreen --allow-dirty` (complete §2.2 pre-screen of all live `:free` tool-capable candidates; overwrites `pilot/MODEL-PRESCREEN.json`).
2. `node scripts/r23-efficiency-bench.mjs qualify --allow-dirty` (3 qualification tasks × ≤6 advancing candidates, orchestrated optimized arm) → `pilot/MODEL-SELECTION.json`.
3. `node scripts/r23-efficiency-bench.mjs pilot --model <winner>` → 12 tasks × 2 arms; then `scripts/r23-efficiency-report.mjs` + `pilot/R23-PILOT-REPORT.md` against the §16 gate.

## Evidence paths

`docs/evidence/r23-efficiency-proof/{recovery,instrumentation,protocol,schemas,cost,pilot,raw/dry_run,raw/qualification,summaries}` populated; remaining directories exist empty by design until their milestone.
