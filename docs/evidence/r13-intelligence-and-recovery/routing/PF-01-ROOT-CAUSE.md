# CBR2-PF-01 investigation — root cause and fix

Recorded: 2026-09-18. Investigation performed by reading raw benchmark evidence and repository history; no live OpenRouter request was made or needed.

## Re-diagnosis: not a completion-gate/state-machine bug

The initial working hypothesis (from the R13 handoff) was that PF-01 was a ForgeVerify/Completion Gate plumbing defect — valid verification evidence produced but lost or ignored. Direct inspection of the raw attempt artifacts disproves this:

- R12's `attempt.json` (`docs/evidence/r12-release-closure/codeforge-bench-r2/raw/CBR2-PF-01/9917ad09-.../attempt.json`) shows `eventTypeCounts` ending at `command.executed`/`file.written` — **no `workflow.verification_started` event exists at all.** CodeForge's own verification pipeline never started for this attempt.
- The benchmark harness (`scripts/r11-codeforge-bench-r2-executor.mjs:254-297`) polls the session every 300ms up to a fixed `CASE_TIMEOUT_MS = 5 * 60_000` (line 15), then records whatever `turn.status` it last observed as `terminalStatus`. R12's attempt shows `wallTimeMs: 301187` — just past that exact 300,000ms ceiling. The harness gave up while the turn was still genuinely in progress; `"running"` is a snapshot of live state, not a stuck/orphaned state.
- The harness's own "visible"/"hidden" checks (`node --test`, hidden verifier) are re-run independently against the final workspace file state regardless of whether CodeForge's turn ever finished — which is why both show `passed: true` even though `forgeVerifyPassed: false`. The code the agent wrote was already correct; CodeForge's own bookkeeping of that fact just hadn't happened yet when the harness's clock ran out.

## R11 vs R12 comparison (same case, same model, same fixture)

| | R11 (`7cb8f915...`, passed) | R12 (`9917ad09...`, failed) |
|---|---:|---:|
| `approvedActions` | 2 | 21 |
| `tool.call_started` | 19 | 42 |
| `tool.execution_failed` | 0 | 2 |
| Reached `workflow.verification_started`? | yes — full clean completion | no |
| `wallTimeMs` | 274,128 | 301,187 (over the 300,000ms harness budget) |

## Correction: the capacity-governor commit predates R11, not R12

An earlier draft of this document claimed `11a5880` ("govern interactive provider capacity") was the only behaviorally-relevant commit between R11's benchmark run and R12 closeout, and built a causal story around it (queue-wait pacing plausibly contributing to the wall-time blowout). That claim was wrong: `git log --date=iso` shows `11a5880` at `17:09:55`, which is **before** `cb4b9cf` at `17:34:18` — R11's actual frozen benchmark commit (confirmed via `definitive-post-final-40.json`'s `frozenCommit` field, which applies to all 40 cases, not just this one). Capacity governance was already active during R11's PF-01 run too, so its introduction cannot explain why R11 passed and R12 didn't. The error came from reading `git log`'s newest-first ordering against the wrong reference point, before locating R11's actual commit hash.

**The real, fully-verified commit range** between R11 (`cb4b9cf`) and R12 (`935ac48`) contains exactly one commit: `83dc1db` ("remove deferred lint debt and replace suspended test credential"). Its full diff was read directly: it removes one unused `StreamEvent` type import from `agent-runtime.ts` (a compile-time-only change with zero runtime effect) and swaps a real-but-suspended Google API key for a synthetic one in `packages/providers/test/redact.test.ts` (a unit-test fixture, not production code). **There is no source-code change between R11 and R12 that could account for any behavioral difference in any of the 40 benchmark cases**, PF-01 included.

## Confirmed, real, general defect found along the way (independent of the above)

While investigating, direct code reading (not inference) established that `GovernedProviderAdapter.chat()`/`streamChat()` (`packages/providers/src/capacity-governor.ts`) never called `governor.recordResponse()` or `governor.recordRateLimit()` on any response, success or failure — confirmed by exhaustively grepping `packages/server`, `apps/`, and `scripts/` for `onResponse:`/`onProviderResponse` wiring. `apps/desktop/src/main.ts` does wire real quota headers to `FreeCloudService` (the 8-Bit free-route-health system works as intended there) — but nothing wires them to `capacityGovernor`, in the desktop app or the benchmark scripts. The governor's evidence-driven adjustment logic in `getEffectiveLimits()` — which already existed and is tested — could therefore never fire through this path in production or in the benchmark. This is real and affects live desktop-app users today on any moderately tool-heavy free-tier OpenRouter task. It does **not** explain the R11→R12 PF-01 flip (see correction above), but it is a genuine defect and was fixed on its own merits.

## What actually explains PF-01

With no code change available as an explanation, and the harness's own 5-minute per-case timeout (`CASE_TIMEOUT_MS`) landing almost exactly at R12's recorded `wallTimeMs: 301187`, the best-supported conclusion is plain benchmark-trial variance: each side ran this case exactly once against a free, weak, non-deterministic model. R12's trial needed more tool calls/approvals/retries than R11's trial for reasons intrinsic to that one model response, not to anything CodeForge does differently. Fully proving this beyond reasonable doubt would require a live reproduction (~20-42 real OpenRouter requests against the 50/day free-tier cap, more for repeated trials to separate signal from noise). Owner decision (2026-09-18): do not spend that budget on this.

## Fix applied

`packages/providers/src/capacity-governor.ts`: `GovernedProviderAdapter.chat()`'s catch block and `streamChat()`'s in-band error handling now call `governor.recordRateLimit(providerId, retryAfter)` when the observed failure is a 429 (via `ProviderError.status`/`StreamEvent.status`, fields R13 already added upstream). This closes the confirmed gap for the safety-critical direction (real 429 detected → correct cooldown/backoff) without inventing any new relaxation heuristic or touching ForgeVerify/Completion Gate. Proven by two new deterministic tests (`packages/providers/test/capacity-governor.test.ts`, tests 14-15) showing the governor now enters cooldown after a 429 observed through this specific wrapper — which it previously silently ignored — with no live provider call involved.

**Explicitly deferred, not fixed:** the *loosening* direction (learning that real headroom exceeds the static fallback on success) still has no evidence path into `capacityGovernor` from this call site — that would require either extending `ChatResponse`/`StreamEvent` to carry quota headers on success, or wiring `recordResponse` at every place an adapter is constructed with `onResponse` (apps/desktop, provider-connections, benchmark scripts) — a larger, more speculative change scoped out of this pass per the above.

## Verdict

PF-01's classification changes from `VERIFICATION_FAILURE` (implying ForgeVerify itself is untrustworthy) to `MODEL_RELIABILITY` / benchmark-trial-timing — CodeForge's completion authority was never actually exercised and never gave a wrong answer; the harness's own external clock ran out first, most plausibly because this particular model trial needed unusually many tool calls and approvals. A real, general, production-affecting defect (capacity-governor's evidence-blindness) was found and fixed as part of this investigation, on its own merits, independent of whether it explains this specific case's timing.
