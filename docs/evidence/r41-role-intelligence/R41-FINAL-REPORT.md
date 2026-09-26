# CODEFORGE R41 FINAL

**Verdict: R41 PARTIALLY VERIFIED.** This is an interim production slice, not a certification of the complete R41 brief. No live inference, new paired benchmark, or 373-user revalidation ran in this slice. Historical R39/R40 evidence was not modified.

## Implementation changes

- Orchestrated Explorer/Planner/Coder/Reviewer turns now send a bounded route-specific `maxTokens` instead of silently inheriting the same 4,096-token adapter default. The Coder retains 4,096 tokens; the other baseline caps are 1,024 (Explorer/Reviewer) and 1,536 (Planner). Exact-route R40 reasoning observations add at most 1,024 tokens, expire on 2026-11-25, and can be replaced with injected profiles. The hard cap remains 4,096.
- Free Fabric reserves the candidate's actual output cap rather than reserving a reasoning-model worst case on every route. Nonpositive, nonfinite, or sub-token callback values fall back to the flat reservation; positive fractional demand rounds *up*. No route gains free eligibility from these changes.
- Dispatch refuses a known exhausted context before sending a request. Truncated output cannot be declared complete and has one bounded repair attempt; a content-filter response is blocked without re-asking. Unusable answers feed role-scoped evidence, not provider-outage or quota evidence. Reported reasoning tokens are included in run usage.
- Google's `CONSUMER_SUSPENDED` detail is now classified as structural `ACCESS_RESTRICTED`, not generic 403 authentication failure. Bare `PERMISSION_DENIED` remains an authentication failure. Structural exclusion persists until a verified explicit catalog change; an ordinary `present` listing or credential-change signal does not clear it.
- The FG certified source-state was reconciled for the changed AgentRuntime and its newly material output-budget module. This is an interim fingerprint, not a new claim of ForgeGreen quality certification. Historical source-state entries were preserved.

## Reasoning-budget fix

R40 recorded `openrouter/cohere/north-mini-code:free` using 457 of 500 completion tokens for reasoning and returning no usable answer; `groq/openai/gpt-oss-120b` failed role samples at a 120-token cap and passed after a 1,500-token retry. R41 deterministic fixtures exercise the same empty/length signature and verify that it blocks instead of masquerading as success. A measured route now receives 2,048 tokens for a Reviewer and 2,560 for a Planner, while an unprofiled Reviewer stays at 1,024. The fixtures do **not** prove a real provider now returns a usable answer; live before/after starvation, visible-output and retry-rate metrics remain unmeasured.

## Role intelligence and heterogeneous routing

R40's role corpus remains the only live role evidence (Codestral 4/4, gpt-oss-120b 3/4 after output-budget correction, north-mini-code 2/4). This single-sample-per-role corpus cannot justify a production role-quality rank. R41 makes **reasoning overhead** runtime-consumable and time-limited, but does not implement a recency-weighted *role-quality* profile or heterogeneous role preferences. The deterministic preferred-route 429 rotation test verifies budget recomputation (2,048 to 1,024) and completion on another free route; it is not a live heterogeneous A/B, nor proof that the alternate is the best-qualified Reviewer. Heterogeneous A/B: 0 new tasks; live success, tokens, latency, conflicts, and provider-switch metrics unavailable.

## ForgeGreen

R40's nine paired cases (eight BOTH_PASS), three efficiency regressions, and 1.107x aggregate remain historical observations. In the three new R40 pairs, multi-file took 24 Green calls versus 19 baseline with identical completion counters; refactor took 24 versus 23; test-repair tied at 18. These observations do not isolate the cause of the extra calls from stochastic tool-round-trip variation. No Green selectivity policy, reversible quality guard, or new paired corpus shipped; no R41 Green savings or regression-avoidance claim is made.

## Canonical regression closure

R40's five exact failure signatures were CF14 context-pack latency 618 ms versus a 500 ms bound (one), delivery-certification Vitest timeouts at 30/60 s (two), and progress-watchdog wall 2,159 ms versus a 1,800 ms bound plus a cancelled-versus-blocked timing result (two). Their standalone success and R41 parallel success are consistent with load sensitivity, **not proof of each underlying mechanism**; no thresholds or assertions were weakened. R41 ran the full suite before source-state reconciliation: **3,795 pass / 2 fail / 48 skip** in 482.95 s. Neither R40 failure reproduced. The two new failures were FG-11/FG-12E fingerprint guards because the deliberately changed AgentRuntime no longer matched the frozen certified material manifest. After the reviewed interim recertification, both guards passed in a focused 8/8 rerun; CF14 1/1, delivery-certification 14/14, watchdog 2/2 passed standalone. The post-recertification **full canonical suite passed 3,798 / failed 0 / skipped 48** in 469.81 s. The five original mechanisms remain open for investigation under controlled parallel load.

## Gemini

The R40 Google response is `PERMISSION_DENIED` with `CONSUMER_SUSPENDED`: the API consumer is suspended. Its underlying cause, duration, and whether a different project/account would qualify are unknown. Gemini is **not usable free capacity** on the observed credential. Routing now hard-excludes this explicit structural signature rather than repeatedly cooling and retrying it; only a verified configuration/entitlement change should trigger requalification. No new live Gemini completion occurred.

## ForgeVerify, scale, endurance and admission

- ForgeVerify reviewer selection remains deterministic-first with the preexisting semantic layer; R41 adds bounded Reviewer output headroom but did not compare live reviewer candidates or catch rates.
- The R40 373-user / 746-task simulation with 50 absorbed 429s, no starvation and no lease leaks remains historical. R41 did **not** rerun its profile under the new per-candidate budget; route concentration, false waits and scale regression are unmeasured.
- No new endurance or dogfood campaign ran; zero new live-provider requests and zero new paid inference were made. The free-only boundary remains enforced by existing eligibility but was not revalidated with live traffic in this slice.
- The R40 0.75x admission correction is unchanged. A deterministic 1,500-token output-window case routes away from a 2,048-token reasoning candidate to a qualified 1,024-token plain candidate instead of falsely waiting; overflow safety remains enforced in focused tests. R41 false-denial population counts and estimator/actual ratios are not measured.
- The R40 111,408 billed input-token context proof stands as historical evidence. No higher live context was attempted.

## Regression evidence

Focused output-budget 16/16, Free Fabric 31/31, source-state 8/8, CF14 1/1, delivery-certification 14/14, watchdog 2/2; full `npm run typecheck` passed. Post-recertification canonical: 3,798 pass / 0 fail / 48 skip. Full-suite logs `/tmp/r41-npm-test.log` and `/tmp/r41-post-recert-canonical.log` are local artifacts, not immutable checked-in evidence. R40 baseline comparison: 3,774 pass / 5 fail / 48 skip; the pass-count increase includes added R41 tests and other suite changes, not a quality-equivalent benchmark.

## Remaining risks

R41 Gates B-F, I, L-N and P require live role qualification/A-B, Green selectivity and paired quality checks, root-cause closure for all five load-sensitive signatures, and 373-user/route-distribution/endurance validation. No metrics have been invented for those gates. A time-expired reasoning profile returns to the role baseline; new qualification should precede expiry for consistently reasoning-heavy routes.

## Commits

- `c229526` - bounded role output and per-route reservation, Google structural denial classification, regression tests, and reviewed interim FG source-state fingerprint.

## R42 recommendation

Finish R41's missing evidence gates before starting a new milestone: authorize bounded free-provider network calls, measure heterogeneous versus homogeneous software-engineering tasks, add role-quality profiles only from that evidence, validate selective Green against correctness-equivalent pairs, and rerun canonical plus the 373-user preference workload.
