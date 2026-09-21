# R25 Checkpoint — Live Qualification + Semantic Verification

**Phase**: 3 (live free-provider role qualification) + 4 (semantic verification adversarial layer)
**Commit base**: `de12447` (R25 recovery + frozen corpus)
**Recorded**: 2026-09-21

## Phase 3 — Live free-provider qualification (execution evidence)

Zero-spend pre-flight (`scripts/r25-live-preflight.mjs`, catalog/account reads only, no inference) classified routes:

| Provider | Result | Basis |
|---|---|---|
| OpenRouter `:free` | `LIVE_OK` | 21 models priced `"0"/"0"` in live catalog; key shows `usage: 0`, `limit: null` |
| Groq | `LIVE_OK` | R23 owner free-plan precedent + live `x-ratelimit-*` headers observed per call |
| Cloudflare Workers AI | `SKIPPED_FREE_ONLY_NOT_PROVEN` | Token is Workers-AI-scoped; account/subscription endpoints 403 — plan state unreadable → fail closed |
| Gemini | `SKIPPED` | Catalog 403 — key cannot read the catalog |
| Z.AI | absent | no credential |

Qualification sweep (`scripts/r25-live-qualification.mjs`, role-aware suite `R24_ROLE_QUALIFICATION_V1`) → `qualification-pass1.json`:

| Route | Result | Role detail (measured) |
|---|---|---|
| `openrouter::nvidia/nemotron-3-super-120b-a12b:free` | QUALIFIED (17 req, 126s) | CODER/TOOL_AGENT/ANALYST/REVIEWER pass; **EXPLORER fail; PLANNER hard-fail** |
| `openrouter::nex-agi/nex-n2.5-pro:free` | QUALIFIED (18 req, 162s) | CODER/TOOL_AGENT/ANALYST pass; PLANNER hard-fail; REVIEWER probation; EXPLORER fail |
| `openrouter::nvidia/nemotron-3-ultra-550b-a55b:free` | QUALIFIED (16 req, 348s) | all but PLANNER (hard-fail); EXPLORER probation |
| `openrouter::qwen/qwen3.8-27b:free` | NOT_QUALIFIED | transient — upstream 429 after 1 request (shared pool saturation), not capability |
| `openrouter::google/gemma-4-31b-it:free` | NOT_QUALIFIED | transient — upstream 429 after 1 request |
| `groq::openai/gpt-oss-120b` | QUALIFIED (14 req, 10s) | CODER/TOOL_AGENT/ANALYST/PLANNER pass; **EXPLORER fail** (hallucinated `JSON` tool + TPM cap) |
| `groq::openai/gpt-oss-20b` | QUALIFIED (14 req, 8s) | CODER/TOOL_AGENT/ANALYST/**EXPLORER** pass; PLANNER hard-fail |
| `groq::qwen/qwen3.8-27b` | QUALIFIED (15 req, 6s) | CODER/TOOL_AGENT/ANALYST/PLANNER/REVIEWER pass; EXPLORER not tested (quota pacing) |

Spend audit: `openrouterUsageBefore.usage = 0` → `openrouterUsageAfter.usage = 0`. Unauthorized paid calls: 0. Evidence contains statuses, filtered quota headers, latencies, tool names only — no prompt/response text, no secrets.

**Honest findings**: role capability is real and uneven — PLANNER (structured planning contract) hard-fails on 4 of 5 qualified routes; EXPLORER fails on 3. The live pool for autonomous runs is effectively Groq (`qwen3.8-27b` broadest; `gpt-oss-20b` covers EXPLORER). OpenRouter `:free` routes are usable for CODER workloads but shared-pool saturation makes them fragile (two routes 429'd out after one request).

## Phase 4 — Semantic verification layer (deterministic)

`reviewDiff` previously caught sensitive files, verification-config rewrites, oversized diffs — but a diff could be clean on all three and still semantically wrong. New module `packages/workflow/src/semantic-diff-review.ts` adds deterministic findings wired into `reviewDiff` (blocking findings flow to `evaluateCompletion` as `review_rejected`; orchestrator already maps findings into the bounded repair loop):

| Finding | Severity | Detects |
|---|---|---|
| `test_assertion_weakened` | blocking | test diffs adding `.skip`/`.todo`/`xit`, suppression directives, net assertion-count reduction, or strict→loose matcher swaps |
| `error_swallow_added` | blocking | added `catch` with empty body or bare default return; `.catch(() => {})`-style swallows |
| `environment_special_case` | blocking | behavior gated on `NODE_ENV=test`, `process.env.*TEST`, `import.meta.vitest`, `navigator.webdriver` |
| `dead_branch_added` | blocking | `if (false)`/`if (0)`/`while(false)` literal-dead branches |
| `test_input_special_case` | blocking | added `=== literal` early-exit where the literal appears verbatim in a workspace test file |
| `unreferenced_new_symbol` | advisory | new exported symbol referenced nowhere else in the workspace |
| `non_functional_change` | advisory | diff touches only comments/whitespace |

Adversarial corpus `packages/workflow/test/r25-semantic-diff-review.test.ts` — 17 cases, all passing:
- 9 cheat cases → expected blocking findings (hardcoded fixture response, input special-casing, env gating, catch-swallow inline + block, dead branch, test skip/count/matcher weakening).
- Gate integration case: blocking semantic finding + otherwise-clean evidence → `evaluateCompletion` → `blocked` (`review_rejected`), even with verification passed.
- 5 honest controls → zero blocking findings (correct fix, fix+stronger tests, legit catch w/ rethrow, domain literal absent from tests, `.env`/config-rewrite regression).

**Boundary**: deterministic lint cannot prove semantic correctness of arbitrary code — it rejects gaming patterns and defers to hidden verifiers/reviewers for the rest. Documented limits: yoda-style comparisons, non-literal special-casing, multi-statement catch bodies with plausible content.

## Harness semantics fix (campaign package)

`run-task.ts` reviewer path: the runtime maps `revision_required` → run status `blocked` (production pipeline semantics — a rejected review blocks the workstream). The harness's `delivered`/`claimedComplete`/`summary` computation previously required `status === "completed"`, so a correct rejection verdict could never verify. Fixed: a validated verdict object is the deliverable and the completion claim; `summary` uses the structured result when present. `runtimeStatus` still records the raw `blocked` — classification now distinguishes `false_complete` (wrong verdict) from `verification_failed` (no verdict delivered).

## Benchmark harness (Phase 5 instrument)

`scripts/r25-live-bench.mjs` — sibling of the R23 runner on the frozen R25 corpus (`benchmarks/r25`, manifest `r25-task-manifest-1`, 10 tasks). Preserves live-safety invariants: `$0` route pinning, ForgeZero admission, production-shaped probe gate, per-run allowance gate (OpenRouter daily free counter; Groq x-ratelimit headers + 200k-token/day bucket replay), cost halt on `actualCostUsd > 0`, exclusion ledger, paired-arm ordering.

**Dry-run result**: 10 tasks × 2 arms, `single_agent_run`, scripted reference model → **20/20 `verified_complete`** (`bench/raw/dry_run/`).

## Baseline note

`forge-verify.test.ts` case "executes ALL applicable verifiers…" is a pre-existing wall-clock boundary flake (4 serial child-process spawns ≈ 5s default timeout; passes at 5766ms under 20s). Not caused by R25 changes; recorded, not fixed here.

## Next

Phase 5: live paired benchmark on `groq::qwen/qwen3.8-27b` (broadest qualified role set) / `groq::openai/gpt-oss-20b` (EXPLORER-capable), `single_agent_run` mode to avoid the PLANNER gap.
