# R49 Final Report — 8-Bit Free Supply Closure, Capacity Federation & Live Mission Certification

Surface: `r49-free-supply-closure-v1`
Source-state hash: `029807c8b2469c5e…` (full value in `docs/codeforge-forgegreen-certified-source-state.json`)
Baseline: R48 (`r48-role-aware-runtime-v1`, `9012e79e…`, commits `b6cc77c3`/`790181a1`/`c107fb5f`)
Branch: `codex/r29-release-closure`

Commits:

- `d0923a8` — baseline + E2 failure reconstruction
- `7735445` — capacity semantics: split resets, bounded discovery, transient federation
- `f08a607` — free federation: live inventory + OpenRouter all-role qualification
- `9eafb43` — quality feedback: ForgeVerify outcomes demote exact free-role routes
- `7171fff` — scale proof: no-false-waiting 8/8 + multiuser simulation
- `d6898c4` — live certification: OpenRouter quota endpoint, unmetered-dimension admission, failover journal truth

## Answer to the R49 question

> Can 8-Bit take volatile, quota-limited, independently constrained free model supply and turn it into one reliable, fully verified autonomous coding mission without cheating, unnecessarily waiting, or depending on one fragile provider account?

**Yes, with one measured honest failure.** Four consecutive live missions ran on
CodeForge-managed zero-cost routes only: **3 completed end-to-end** (completion
gate `completed`, integration `integrated`, verified tree == integrated tree,
$0 paid spend), including a cross-provider-account independent reviewer and
three real transient-capacity failovers. The **4th blocked honestly** when the
independent reviewer (nemotron) emitted a workspace-escape tool call — the run
reported `blocked`, refused integration, and claimed nothing. No paid route,
BYOK route, or fake success occurred in any run.

## Root-caused and fixed during R49 (not in the original commit plan)

### 1. OpenRouter admission deadlock — real CodeForge defect

OpenRouter `:free` routes were role-QUALIFIED and ForgeZero-eligible yet could
never be fabric-admitted: the provider publishes quota on `GET /api/v1/key`
(`free_model_daily_requests`), never in chat response headers. The reservation
ledger's zero-window deny is intentional (unmeasured ≠ unlimited), so OR was
permanently deadlocked — quota evidence required a call the reservation blocked.

Fix (`d6898c4`):

- `ProviderAdapter.probeAccountQuota?()` — optional account-quota endpoint
  probe. `OpenRouterAdapter` implements it: reads `/key`, translates
  `free_model_daily_requests` (used/limit/remaining — authoritative account
  numbers) into the shared quota-observation vocabulary through the wired
  `onResponse` channel, preserving managed-account attribution. Bounded by the
  refresh-wide probe budget (`maxAllowanceProbes` now genuinely bounds all
  refresh probing).
- Ledger unmetered-dimension rule (`capacity-reservations.ts`): an *observed*
  requests window proves the provider meters the account; absent token windows
  are unmetered, not zero capacity. Zero-window routes still deny — fail-closed
  invariant preserved and covered by a new test.

Post-fix admission diagnosis (`scripts/r49-admission-diagnosis.mjs`): all five
roles admit; REVIEWER selects `openrouter/nemotron-3-super` with
`INDEPENDENT_POOL_PREFERRED`.

### 2. Journal route attribution bug — real CodeForge defect

`agent-runtime` updated `activeSelection` on failover but never updated
`journalActiveRoute`, so journals recorded the first-admitted route identity
with the final served pool — internally inconsistent role evidence. Fixed for
both free and paid rotate paths; verified live (post-fix runs show consistent
route+pool attribution).

### 3. Transient-capacity recovery and probe-budget leak (`7735445`)

Refresh-wide `maxAllowanceProbes` was declared but never enforced; transport
cause codes were dropped, hiding TRANSIENT_NETWORK from the failover
classifier; split request/token reset windows collapsed into one. All fixed;
probe-budget semantics now tested (`catalog-refresh-probe-budget.test.ts`,
9/9 including account-quota bootstrap coverage).

## Qwen 3.8-27B Coder diagnosis

Full writeup: `R49-QWEN-CODER-DIAGNOSIS.md`. Two R48 outcomes separated:

- Attempt A: model claimed completion, left both functions broken (0/2 tests).
  Model/task-quality failure — qualification predicted protocol competence, not
  correctness. **Fixed by the ForgeVerify→role-quality loop** (`9eafb43`):
  `recordRoleOutcome(route, "coder", "verification_failed")` demotes the exact
  serving route after a ForgeVerify rejection; `verified_complete` is recorded
  only after gate + integration both accept.
- Attempt B: `groq stream failed: fetch failed` — TRANSIENT_NETWORK, and the
  failover never happened. **Fixed**: whitelisted transport cause codes now
  reach the classifier (`[cause=X]` marker), and failover prefers independent
  managed pools. Live proof: run 3's coder recovered `groq/qwen3.8-27b →
  openrouter/nemotron` after RATE_LIMITED and completed.

## No-false-waiting

`scripts/r49-no-false-waiting.mjs` — 8/8 scenarios: alternate healthy supply is
always attempted before parking; DENIED never waits; near-term QUEUED gets one
bounded wait; distant QUEUED fails closed; stale reset re-decides immediately.
Live corroboration: no mission ever queued when an admissible route existed
(explorer failover in runs 1–3 happened in milliseconds, not queue waits).

## Multi-user capacity simulation

`scripts/r49-multiuser-simulation.mjs` (`R49-MULTIUSER-SIMULATION.json`):
2,136/2,136 simulated tasks admitted/completed across single(8/8),
modest(128/128), large(2000/2000) scenarios; fair per-user isolation, no
starvation, no false waits; tripling independent pools moved success fraction
**0.333 → 1.000** — pool federation is the binding constraint, not orchestration.

## Live 8-Bit mission evidence

One coherent run each — Explorer → Coder → Reviewer → ForgeVerify → completion
gate → integration. Task: fix `multiply` (returns 0) and `format` (returns
`value:` instead of `result:`) without touching tests.
Verification: `node --test test/math.test.mjs test/format.test.mjs` → 2/2 pass.

### Run 1 — `completed`, 261.2s (transcript-captured; canonical file overwritten by later run)

| ROLE | PROVIDER | MODEL | POOL | QUAL | FAILOVERS | REQ | TOOLS | OUTCOME |
|---|---|---|---|---|---|---|---|---|
| explorer | openrouter→groq | nemotron-super→gpt-oss-120b | managed:groq | QUALIFIED | 1 (TEMPORARY_CAPACITY) | 2 | 0 | completed |
| coder | groq | gpt-oss-120b | managed:groq | QUALIFIED | 0 | 8 | 7 | completed |
| reviewer | openrouter | nemotron-super | **managed:openrouter** | QUALIFIED | 0 | 7 | 6 | completed |

Independent reviewer pool (`INDEPENDENT_POOL_PREFERRED`), 4 ForgeVerify
records, gate `completed`, integrated, trees equal (`f439e6d`), $0.

### Run 2 — `completed`, 209.0s — `R49-LIVE-8BIT-MISSION-RUN2.json`

| ROLE | PROVIDER | MODEL | POOL | QUAL | FAILOVERS | REQ | TOOLS | OUTCOME |
|---|---|---|---|---|---|---|---|---|
| explorer | groq→openrouter | gpt-oss-20b→nemotron-super | managed:openrouter | QUALIFIED | 1 (RATE_LIMITED) | 5 | 3 | converged_failed (absorbed, bounded exploration) |
| coder | openrouter | nemotron-super | managed:openrouter | QUALIFIED | 0 | 9 | 8 | completed |
| reviewer | openrouter | nemotron-super | managed:openrouter | QUALIFIED | 0 | 8 | 6 | completed (SAME_POOL_FALLBACK — independent preferred but unavailable at that instant) |

Gate `completed`, integrated, trees equal, $0.

### Run 3 — `completed`, 167.9s — `R49-LIVE-8BIT-MISSION-RUN3.json`

| ROLE | PROVIDER | MODEL | POOL | QUAL | FAILOVERS | REQ | TOOLS | OUTCOME |
|---|---|---|---|---|---|---|---|---|
| explorer | openrouter | nemotron-super | managed:openrouter | QUALIFIED | 0 | 2 | 0 | converged_failed (turn budget; absorbed) |
| coder | groq→openrouter | qwen3.8-27b→nemotron-super | managed:openrouter | QUALIFIED | 1 (RATE_LIMITED) | 6 | 7 | completed |
| reviewer | openrouter | nemotron-super | managed:openrouter | QUALIFIED | 0 | 9 | 8 | completed |

Gate `completed`, integrated, trees equal, $0.

### Run 4 — `blocked`, 280.2s — `R49-LIVE-8BIT-MISSION-RUN4.json` (canonical `R49-LIVE-8BIT-MISSION.json`)

| ROLE | PROVIDER | MODEL | POOL | QUAL | FAILOVERS | REQ | TOOLS | OUTCOME |
|---|---|---|---|---|---|---|---|---|
| explorer | groq | gpt-oss-20b | managed:groq | QUALIFIED | 0 | 1 | 0 | completed |
| coder | groq | gpt-oss-20b | managed:groq | QUALIFIED | 0 | 12 | 11 | completed |
| reviewer | openrouter | nemotron-super | **managed:openrouter** | QUALIFIED | 0 | 1 | 1 | converged_failed — `TOOL_WORKSPACE_ESCAPE` (emitted `path:"/"`) |

Independent pool WAS selected; nemotron produced an invalid tool call; the run
reported `blocked`, integration refused, nothing claimed. This is the
fail-closed contract working — a mission must not complete without a real review.

**Totals:** 4 missions, 3 completed, 1 honestly blocked; 5 provider calls
recovered by failover; 2 distinct providers, 4 distinct models served real
work; paid spend $0.00; every served route `isForgeAutoEligible`=true.

## ForgeVerify / completion gate / integration

- ForgeVerify persistence recorded per run (4 work items on completed runs).
- `evaluateCompletion` was the only `completed` authority; blocked run produced
  no gate decision and no integration.
- Verified worktree tree == integrated tree hash in every completed run.

## Regression

| Suite | Result |
|---|---|
| forge-zero | 151/151 pass |
| model-registry + providers | 354/354 pass (incl. 9 probe-budget tests) |
| eight-bit | 309 pass / 2 skipped (postgres env-gated) |
| server full suite (under live-mission load) | 869 pass / 21 fail / 3 skip (136 files) |
| server suite re-isolation | 19/21 failures pass standalone; **2 baseline failures unchanged since `d4769e8`**: `agent-certification-r` (million-symbol bound), `fg3-model-aware-budget` (tiny-context pin). `parallel-orchestrator-integration` needs ~31.6s vs a 30s limit — wall-clock margin on this machine, passes at raised timeout |
| Builds | `@codeforge/agent`, `eight-bit`, `model-registry`, `providers`, `forge-zero`, `server` all clean |

## Honest remaining risks

- **Nemotron-super is volatile for tool-driven roles**: 2/2 explorer
  convergences failed on nemotron (turn budget, reasoning verbosity), and 1/3
  reviewer attempts emitted a workspace-escape tool call. It *can* serve coder/
  reviewer (did so in runs 2–3) but QUALIFIED ≠ reliable — convergence evidence
  should feed role verdicts, not just ForgeVerify outcomes. Flagged for R50.
- **Single OpenRouter account** carries all OR supply; the free-model daily
  window (939→~870 remaining across 4 missions) is real but finite — daily
  exhaustion is a hard external wall, correctly fail-closed.
- **Mistral routes all excluded by `DATA_POLICY_USER_CONSENT_REQUIRED`** —
  effective managed supply is Groq + OpenRouter only; Mistral cannot count as
  an independent domain until consent policy is resolved.
- **Reviewer independence is preferred, not guaranteed** — `SAME_POOL_FALLBACK`
  is honest when independent supply is transiently unavailable (runs 2–3).
- **OR upstream wraps provider overloads in HTTP-200 error bodies** — observed
  `provider_overloaded` 503s; handled as transient, but upstream volatility is
  external.
- **`parallel-orchestrator-integration` timeout margin** (~31.6s vs 30s) on
  this Windows host — environmental, not semantic.

## R50 recommendation — continue backend reliability, not UI

The free runtime completes real missions, but the weakest link is now **model
role-fitness**, not supply plumbing:

1. **Convergence-aware role verdicts** — feed bounded-telemetry outcomes
   (turn-budget exhaustion, invalid tool calls like the `/` escape) into role
   qualification tiers so nemotron can't hold EXPLORER/REVIEWER `QUALIFIED`
   while empirically failing. Reuse the `recordRoleOutcome` seam with
   `role_failed` for absorbed explorer failures.
2. **Second independent account or provider domain** — supply depth for
   reviewer independence is luck-of-the-moment; a third managed domain (or a
   second OR account) converts `SAME_POOL_FALLBACK` into the rare path.
3. **Qualification refresh for volatile free models** — receipts age while
   upstream reliability drifts; bounded re-qualification on health transitions.

Do **not** start UI/productization: the backend still has a live quality gap
(nemotron's tool-protocol discipline) that only evidence-driven qualification
hardening closes.

## Integrity notes

- Only intentional dirty file remains: `docs/evidence/r34-capacity-efficiency/context-efficiency-benchmark.json` (rewritten by its own benchmark test — expected, never committed).
- Credentials referenced by env-var presence only (`GROQ_API_KEY`, `MISTRAL_API_KEY`, `OPENROUTER_API_KEY`); no values in evidence.
- Run 1 artifact fields were captured from the working transcript before the canonical file rotated to run 4; runs 2–4 ship as full JSON artifacts.
- The `missionAdmission` field in mission JSON is `null` — the orchestrator's result carries no such field; per-role admission evidence lives in `routerEvents` and `roleReport` instead. Reported rather than suppressed.
