# CodeForge R3-RC2 Corpus Campaign — Window 1 Report

Campaign: `campaign-1` · Window: 2026-09-15 ~20:20–23:34 UTC · Verdict for the window: **capacity exhausted before any task could complete**

## 1. Verdict

`CODEFORGE_R3_RC2_CAPACITY_LIMITED` (window 1).

The frozen 100-task corpus was frozen, hashed, and executed through the real CodeForge pipeline
behind a durable, resume-safe runner. Every one of the 100 tasks has a durable, evidence-backed
record. 100/100 are `CAPACITY_BLOCKED`: the managed-free fleet's daily quotas (Groq
`openai/gpt-oss-120b` TPD 200,000 tokens/day; Cloudflare Workers AI 10,000 neurons/day; Z.AI
credential absent) were exhausted before any task could complete. No task result was faked; no
paid tier was touched; zero user keys were used. The campaign resumes automatically after the
daily quota reset.

## 2. Freeze (before any execution)

- `freeze.json` at `tests/evidence/r3/corpus-runs/campaign-1/freeze/freeze.json`, frozenAt
  `2026-09-15T21:45:56Z` (immutable once execution began; enforced by hash and by guard).
- Corpus hashes: `tests/evidence/r3/corpus-manifest.json`,
  `packages/benchmark/src/r3-corpus.ts`, `packages/benchmark/src/index.ts`,
  `packages/benchmark/dist/r3-corpus.js` (SHA-256 recorded in freeze.json).
- Runner + oracle wrapper SHA-256 recorded; `run` refuses to execute on any mismatch.
- Starting states: sandbox `d45db35` (as declared), dogfood `ef6b6d4` (as declared), CodeForge
  resolved to the certified HEAD at freeze time (`453ab6e`; manifest declared `850513c`).
- Pre-registered resolutions (documented in freeze.json, decided before any task ran):
  1. **CodeForge start state** — five adversarial oracle commands reference test files introduced
     by the certified post-freeze hardening commits (44ea7b2, 71f7a9a); at `850513c` those oracles
     cannot execute. Repository is authoritative: resolved to certified HEAD.
  2. **Oracle semantics** — `npm test` ≙ `npx vitest run` in all three repos. The frozen sandbox
     and dogfood starting states carry pre-existing failing tests unrelated to their task targets
     (sandbox: 1; dogfood: 15), so the frozen standard is enforced by
     `scripts/r3-oracle-wrapper.mjs`: no new failing test vs the baseline captured at the frozen
     commit, and no baseline-collected test file lost. Baselines hashed before execution.
- Oracle baselines captured at the frozen states (per distinct repo+args pair): sandbox-suite
  (1 failing), dogfood-suite (15 failing), codeforge-suite (0 failing — 2454 passed / 0 failed /
  36 skipped at the frozen HEAD), and six targeted adversarial baselines (all 0 failing).

## 3. Durable runner

`scripts/r3-corpus-runner.mjs` — per-task JSON records (`tasks/<ID>.json`) written atomically after
every state transition; per-attempt evidence (run result, events, workers, build log, diff patch,
internal + external oracle evaluations) under `evidence/<ID>/attempt-<N>/`; campaign checkpoints at
10/25/50/75/100 (all written); exhaustion ladder + bulk classification; `--retry-capacity-blocked`
resume path. A crash resumes by attempt and never resets progress.

Per-task record fields: task_id, category, starting_sha (declared + resolved), status, attempt,
oracle_command, baseline_key, provider_routes, model_roles, tokens, requests, started_at,
last_progress_at, finished_at, verified, completion_gate, intervention, failure_class,
false_completion, evidence_path, notes.

## 4. Pipeline fidelity

Each attempt runs the real architecture: ForgeZero firewall → governed managed-free providers
(ProviderCapacityGovernor: groq 6,000 TPM / 20 RPM / 2 concurrent) → AgentRuntime →
Explorer → Planner → Coder → Reviewer → ForgeVerify (the frozen oracle command through the
wrapper) → Completion Gate, in a git worktree pinned to the frozen starting commit with node_modules
junctioned and the worktree **built** (dist-consuming child fixtures verified against the
worktree's own source).

## 5. Window-1 results (all 100 tasks)

| Category | Total | Passed | Recovered | Human | Failed | Capacity-blocked | External | Invalid |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Simple | 20 | 0 | 0 | 0 | 0 | 20 | 0 | 0 |
| Normal | 35 | 0 | 0 | 0 | 0 | 35 | 0 | 0 |
| Complex | 30 | 0 | 0 | 0 | 0 | 30 | 0 | 0 |
| Adversarial | 15 | 0 | 0 | 0 | 0 | 15 | 0 | 0 |
| **Total** | **100** | 0 | 0 | 0 | 0 | **100** | 0 | 0 |

- 90 task attempts were actually dispatched before classification; 10 were gate-blocked at the
  pre-flight probe (`rate_limited_beyond_bounded_wait`).
- Attempt failure classes: 65 `provider_rate_limited` (429 TPD on a worker turn), 25
  `provider_health_marked_unavailable` (ForgeZero provider-wide health marking after a TPD 429 →
  planner truthfully receives `PROVIDER_MODEL_UNAVAILABLE`), 10 gate-blocked.
- **false_completion: 0** · silent corruption: 0 · unsafe replay: 0 · human intervention: 0.
- Two smoke attempts (archived under `smoke-archive/`) exercised the full pipeline against real
  Groq inference before the TPD wall: explorers genuinely explored (12 model requests, ~15K input
  tokens, 10+ tool calls) and every failure was honest (no fabricated completion, no silent
  fallback, no `modelId:"default"` revival).

## 6. Capacity findings (empirical input for R3.5 / 8-Bit / Free Cloud)

- **Groq `openai/gpt-oss-120b`**: TPD 200,000 tokens/day (hard, observed verbatim in the 429
  body: "Limit 200000, Used 199…"); TPM 8,000 tokens/min and 1,000 requests/day windows observed
  in rate-limit headers. At the observed smoke consumption (~15K input tokens for two explorers'
  partial work; a full simple task plausibly 30–80K tokens end-to-end), one model's TPD funds
  roughly **3–5 simple tasks per day**.
- **Cloudflare Workers AI**: 10,000 neurons/day free; exhausted earlier the same day by
  qualification + live runs; resets ~00:00 UTC. Marginal additional capacity.
- **Z.AI**: `EXTERNAL_AUTHORIZATION_REQUIRED` (no credential present; preserved honestly).
- Provider-wide health marking means a single TPD 429 zeroes the whole provider for the rest of a
  run (certified ForgeZero semantics) — cross-provider failover is the only resilience path, and
  with every fleet provider daily-capped, runs cannot bridge a daily reset inside one attempt.
  This is the central capacity-model input for the R3.5 campaign.
- Daily pacing implication: with Groq-only capacity, ~3–5 simple / 1–2 normal tasks per day are
  realistically executable; a full 100-task corpus at free-tier capacity is a multi-week campaign
  unless additional legitimate free routes are qualified first.

## 7. Failures discovered and fixed (durable registry: `tests/evidence/r3/failure-registry.json`)

| ID | Severity | Title | Status |
| --- | --- | --- | --- |
| FR-001 | P1 | Build-stamped staging manifest committed, breaking the development-channel invariant + regression test | FIXED (c217e96) |
| FR-002 | P1 | Verification gate's 300s per-command ceiling could never pass a real monorepo suite; no override existed | FIXED (bf6bc14 + recert 3bedc16) |
| FR-003 | P2 | Oracle wrapper spawned npx.cmd without shell (Node ≥20.12 EINVAL) | FIXED (8ca0fec) |
| FR-004 | P2 | Runner classified daily-capacity exhaustion as FAILED instead of CAPACITY_BLOCKED | FIXED (8ca0fec) |

## 8. Full regression

The frozen CodeForge baseline (full suite, JSON) at the certified HEAD: **2454 passed / 0 failed /
36 skipped** — the certified claim, restored and re-verified after FR-001/FR-002 fixes and the
guarded source-state recertification (FG-11/FG-12E identity tests green).

## 9. Packaged zero-key golden path (unchanged, Path B)

`packaged-first-user-acceptance.log`: 7 PASS / 5 BLOCKED — every block requires a real human
GitHub OAuth sign-in. No operator was available in this autonomous window; OAuth is classified
**EXTERNAL/HUMAN BLOCKED** (truthful Path B; not faked). Technical flow is green to the OAuth
boundary: fresh profile, zero client provider keys, desktop launch, cloud ready, catalog refresh
(2 verified-free models, no user key), OAuth start (staging callback).

## 10. Continuation

The campaign is fully resume-safe. A scheduled automation resumes it daily at 20:10 local
(00:10 UTC, after quota reset) with `run --limit=4 --retry-capacity-blocked`, committing evidence
and never pushing. At ~4 tasks/day the corpus completes in ~25 days of windows; each window's
results land as durable task records.

## 11. R3.5 handoff data (preliminary, from window 1 + smoke)

- tokens/task (partial, smoke): explorer-phase ≈ 15K input for a tiny repo; expect 30–80K per
  simple task end-to-end — to be replaced by real per-task measurements as windows complete.
- requests/task (smoke): 6 per explorer over 5 min under 6K TPM pacing.
- role shares (smoke): explorer ≈ 100% of pre-planner consumption; planner/coder/reviewer shares
  pending real runs.
- rate-limit pressure: TPD (daily) binds long before TPM/RPM under task-shaped load; the governor's
  minute-level pacing is not the binding constraint — daily buckets are.
- provider concentration: 100% Groq this window (CF exhausted; Z.AI uncredentialed).
- capacity-blocked frequency at current fleet size: 100% of the window once daily buckets
  exhausted — first-run availability protection cannot rely on today's two-provider fleet alone.
