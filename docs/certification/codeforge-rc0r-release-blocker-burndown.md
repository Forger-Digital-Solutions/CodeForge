# 1. Overall Verdict

`CODEFORGE_FULL_AGENT_HARDENED_RELEASE_BLOCKERS_REMAIN`.

The Cloudflare financial-safety blocker is hardened, the current full suite is green, and the
final asar-enabled packaged desktop smoke passes. The campaign still cannot claim an RC candidate
because the fresh Groq whole-agent run blocked before an authorized task graph, so no live
ForgeVerify/Completion Gate completion or CodeForge-builds-CodeForge proof exists.

# 2. Dogfood Readiness

`LIMITED_DOGFOOD_READY`. Internal bounded use remains possible under the existing safety gates;
general internal dogfood is not authorized by this campaign.

# 3. Starting State

Repository: `G:\CodeForge`.

Branch: `forger-digital-solutions-forgegreen-certified`.

Starting HEAD: `94acc84415cf70ad3f2ea3de53d39a31b4630b68` (`94acc84`). The starting worktree was
clean. No push was performed.

The preserved starting verdicts were Limited Dogfood, ForgeGreen R1 external-provider pending,
and R4 capacity-limited external evidence pending.

# 4. Cloudflare Workers Paid Account State

The authenticated Cloudflare dashboard showed Workers Paid at `$5/month + usage`; Workers AI
showed 8.47k Neurons used today. The fixed Workers Paid subscription is authorized by the user.
Workers AI overage is not authorized. Cloudflare’s official pricing reference is
[Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/).

# 5. Cloudflare Overage Risk Audit

CodeForge treats the included 10,000 Neurons/day as an absolute external allowance and applies an
8,000-Neuron internal ceiling. At the observed 8,470 Neurons, Cloudflare inference is blocked for
the UTC day. Billing alerts are not treated as caps. Paid-plan access does not grant permission to
consume paid overflow.

# 6. CodeForge Cloudflare Hard-Cap Implementation

`packages/providers/src/cloudflare-neuron-budget.ts` adds a versioned guard with conservative
input/output neuron estimation, explicit positive `maxTokens`, known-model-rate requirements,
usage-source validation, reservation-before-fetch, settlement/release, a durable atomic file
ledger, and a fail-closed default. The provider adapter and factory require this guard for
Cloudflare; adaptive routing skips a route whose cached budget cannot prove capacity.

# 7. Cloudflare Daily Budget / UTC Reset Tests

The focused guard suite passes the 8,000-Neuron ceiling, 10,000 included ceiling, unknown usage,
exact UTC-day rollover at `00:00 UTC`, and budget exhaustion cases. No Cloudflare inference was
sent because the observed account was already above the CodeForge ceiling.

# 8. Cloudflare Concurrency / Atomicity Tests

The focused suite passes concurrent reservation serialization, durable lock-file read-modify-write,
atomic temp-file replacement, settlement bounds, release, restart persistence, and corrupt-ledger
fail-closed behavior. Concurrency cannot oversubscribe the ceiling.

# 9. AI Gateway Spend-Limit Audit

The Cloudflare dashboard showed the AI Gateway surface and no CodeForge-configured gateway credits.
AI Gateway credits remain `$0`; no credits were added and no Unified Billing or spend control was
enabled.

# 10. Direct-Path / Bypass Audit

The direct Cloudflare REST/OpenAI-compatible path is guarded in the adapter before request
construction. The provider factory’s default Cloudflare guard fails closed, and adaptive selection
consults `canRoute`. No separate AI Gateway path, raw REST helper, paid overflow switch, or browser
alert-as-cap path exists in CodeForge.

# 11. Cloudflare Paid-Access Model Candidates

Static candidates were recorded without live calls: Kimi K2.6, GLM-5.3-Flash, GLM-5.3, and
DeepSeek V4 Pro. The catalog evidence records official paid-plan access requirements, captured
context/tool facts where available, and conservative neuron conversions. None was promoted to
Managed-Free. The complete machine-readable table is
[paid-model-candidates.json](../evidence/rc0r/cloudflare-cost-safety/paid-model-candidates.json).

# 12. Groq Account / Limit Evidence

The authenticated Groq console showed the Free plan. Captured limits for `openai/gpt-oss-120b`,
`openai/gpt-oss-20b`, and `qwen/qwen3.8-27b` were 30 RPM, 1K RPD, 8K TPM, and 200K TPD per model
entry. No Groq paid upgrade was made.

# 13. Groq Live Whole-Agent Result

The authorized Groq-only live run used `openai/gpt-oss-120b` and exited blocked with code 1. Two
explorers timed out/cancelled after bounded model requests; the planner cancelled before producing
an authorized structured graph. Changed files: none. Verification: none. Provider failures: zero.
The run therefore proves no whole-agent success and no ForgeVerify or Completion Gate pass.

Evidence: [live-run.json](../evidence/rc0r/groq-whole-agent/live-run.json).

# 14. Live Tools / Edits / Tests

No live provider task edits were attributed to CodeForge. Source work implemented the Cloudflare
guard, provider allowlist/adaptive admission, Gemini policy gate and consent UX, Mistral/Cerebras
packaging metadata, preview/Beta/Labs discovery exclusion, 8-Bit policy metadata, and truthful
desktop budget state. Focused tests, the workspace build, and the packaged smoke sequence were run.

# 15. ForgeVerify Result

ForgeVerify’s existing authority and focused regression suites remain green. A fresh live
whole-agent ForgeVerify result was not produced because the Groq run stopped before task execution.

# 16. Completion Gate Result

The existing Completion Gate tests remain green and no production path bypass was added. A fresh
live run did not reach the gate; no live completion is asserted.

# 17. ForgeGreen Live Efficiency

No new causal ForgeGreen efficiency measurement is claimed. The Groq run did not produce matched
workloads or a completed task. Existing ForgeGreen authority and R0/R1 instrumentation remain
preserved.

# 18. ForgeGreen R1 Status

`CODEFORGE_FORGEGREEN_R1_EXTERNAL_PROVIDER_PENDING` remains unchanged. The campaign does not
promote R1 based on an incomplete live run.

# 19. Electron Exit-49 Root Cause

The prior packaged event was `render-process-gone: launch-failed`, exit 49. Electron documents
`launch-failed` as the renderer never successfully launching; the event did not expose a more
specific OS cause. An explicit canonical file URL retry and an asar-disabled retry were attempted,
and neither established a source-level cause. Production sandboxing was never weakened.

The final clean asar-enabled package no longer reproduces the failure, so the honest classification
is `NOT_REPRODUCED_AFTER_CLEAN_FINAL_PACKAGE`, not a claim of a proven original OS root cause. See
[Electron renderer-process-gone details](https://www.electronjs.org/docs/latest/api/structures/render-process-gone-details).

# 20. Packaged Desktop Visual Smoke

The final package passed `npm.cmd run smoke:all --workspace=codeforge-desktop`: full mode exit 0,
interrupt mode exit 73, recovery mode exit 0. It exercised renderer lifecycle, ForgeGreen, 8-Bit,
cloud DB, workspace/index/search, model catalog/filter, workflow repair, reload count 5, settings,
control-plane trust, encrypted credential round trip, interruption, and recovery. Sixteen
credential-safe screenshots were captured. Evidence:
[full-smoke-result.json](../evidence/rc0r/desktop-smoke/full-smoke-result.json).

# 21. UI Truthfulness

The provider settings UI now labels Cloudflare as a daily allocation with an explicit 8,000-Neuron
safe ceiling, `paid overflow disabled`, and `usage unknown — route blocked` when no trusted
account-scoped usage source is available. Gemini is visibly consent- and region-gated. Mistral and
Cerebras are labeled as commercial API-compatible integrations while their trial/allowance status
is kept distinct from durable Managed-Free capacity.

# 22. FG-11 / FG-12E Source-State Recertification

The certified surface was reviewed rather than merely rehashing a stored hash. The current source
state is `a40af59269e054e4547ea4aaaf71f5010a9416d3a33a2338067e9600b1264569`; the enumerated
certified-surface drift is `packages/server/src/agent-runtime.ts` with material blob hash
`96004ed0d535e7a9d64b6c4b88e7a05a967c807d`. Bounded shutdown/recovery changed; ForgeGreen and
ForgeVerify authority did not. FG-11 and FG-12E focused evidence passed.

# 23. Full Vitest Aggregate

Current final aggregate: 344 test files passed, 0 failed; 917 suites passed, 0 failed; 2,516 tests
passed, 0 failed, 36 skipped; duration 282,932 ms; exit code 0. The complete JSON report is
[current-full-suite.json](../evidence/rc0r/full-suite/current-full-suite.json), with the compact
[summary.json](../evidence/rc0r/full-suite/summary.json). `tests/evidence/**` excludes immutable
archive evidence only; active production tests remain collected.

# 24. Build Results

`npm.cmd run build` passed across all workspaces, including the desktop main/renderer and web
builds. The only output was existing Vite chunk-size guidance; no build failure occurred.

# 25. CFA-001 Regression

Pass. Exact missing/unregistered model selection fails closed before provider invocation in
`packages/server/test/agent-provider-contract.test.ts`.

# 26. CFA-002 Regression

Pass. Server shutdown cancels/drains active work before persistence close in
`packages/server/test/server-stop.test.ts`.

# 27. CFA-003 Regression

Pass. A 200 SSE with no usable choices is rejected as an empty completion in
`packages/providers/test/openrouter-stream-errors.test.ts`.

# 28. Shutdown / Uncooperative-Stream Regression

Pass. The bounded AgentRuntime shutdown path, durable interrupted state, and packaged interrupt /
recovery sequence passed. No sandbox weakening or forced stream shortcut was introduced.

# 29. Safe Managed-Free Failover

Deterministic failover and active-run handoff suites pass, including cross-provider replacement and
health/cooldown handling. No Cloudflare request was used for failover in this campaign, and no
OpenRouter paid balance was used.

# 30. Exact-Model Outage

Pass in the existing exact-model contract: an unavailable exact model fails closed, does not
substitute another model, and does not cross into paid/BYOK routing. The new Cloudflare guard adds
the same fail-closed behavior at the budget boundary.

# 31. Restart / Recovery

Pass in focused shutdown/recovery tests and final packaged smoke. Interrupted work remains durable,
approval replay is prevented, corrupt credentials fail closed, and a fresh task can run after
restart.

# 32. R4 Capacity Update

Cloudflare usable capacity is modeled only through the 8,000-Neuron CodeForge ceiling, not through
Workers Paid overage. Groq limits are captured from the authenticated Free console, but sustained
allowance and independent quota dimensions remain externally unproven. OpenRouter remains degraded
for this campaign.

# 33. R4 Verdict

`CODEFORGE_R4_CAPACITY_LIMITED_EXTERNAL_EVIDENCE_PENDING`. The 373-DAU/heavy-user/provider-
concentration/sustained-allowance gates are not cleared.

# 34. 8-Bit Training Readiness

8-Bit now carries policy metadata for commercial packaging eligibility, acceptance requirement,
region restrictions, data-use class, confidential-data eligibility, free/paid class, policy
revision, and official terms URL; it does not decide user acceptance. Mistral is packageable under
current commercial terms but its normal route excludes Preview/Beta/Labs model IDs. Cerebras is
packageable under its API terms but its current `$5` expiring trial is not durable Managed-Free.
Gemini is packageable but unpaid use is policy-gated. The existing R3.5 corpus still needs its
provider/model provenance, duplicate/contradiction, temporal-leakage, train/dev/test, and stale-
knowledge gates completed before training. No training was run.

Mistral’s [Commercial Terms](https://legal.mistral.ai/terms/commercial-terms-of-service/) and
Cerebras’s [Terms of Service](https://www.cerebras.ai/terms-of-service) are the recorded official
authorities; normal production qualification remains account/model/quota dependent.

# 35. GEMS Boundary

Topaz 1.1 and Sapphire 1.1 remain outside CodeForge production routing. No interim checkpoint was
integrated; training, protected evaluation, and frozen release-artifact gates remain required.

# 36. CodeForge-Builds-CodeForge Result

Not attempted. The required successful live Groq whole-agent run, fresh ForgeVerify result, and
fresh Completion Gate result were absent. No supervisor intervention was misattributed as an agent
success.

# 37. New Defects

No new P0/P1 production defect was confirmed after the fixes. The release blockers are evidence
gaps: live Groq whole-agent orchestration blocked before task execution; R1/R4 external proof is
pending; and the desktop has no trusted live Cloudflare dashboard usage source, so its Cloudflare
route remains intentionally blocked until one is supplied. The original Electron launch-failed:49
event is not reproduced by the final package.

# 38. Fixes Implemented

Implemented: Cloudflare neuron hard cap and durable reservations; paid/unlisted Cloudflare model
admission boundaries; adaptive budget-aware routing; Gemini versioned unpaid-policy metadata,
region/age/business-use/data-use gate, account-bound explicit consent, no silent fallback, paid
separation, preload/main/UI wiring; Mistral/Cerebras commercial packaging metadata and
experimental-model discovery exclusion; 8-Bit policy metadata receipts; source-state renewal; and
truthful desktop Cloudflare budget messaging.

# 39. Regression Tests Added

Added Cloudflare unknown-usage, exhaustion, UTC rollover, concurrency, persistence, reservation,
settlement, and estimator tests; Gemini policy/consent/region/paid-separation/provider-gate tests;
Mistral/Cerebras registration and packaging tests; 8-Bit metadata tests; preview/Beta/Labs
discovery tests; and desktop Gemini/Cloudflare disclosure-state tests.

# 40. Security / Privacy

No credentials, cookies, account identifiers, browser tokens, billing identifiers, or payment
details were committed. The packaged smoke verified bearer withholding, secondary-renderer
rejection, encrypted credential storage, plaintext absence, and corrupt-credential fail-closed
behavior. Gemini unpaid metadata explicitly marks training/human-review possibility and
`confidential_data_eligible=false`; its official [Additional Terms](https://ai.google.dev/gemini-api/terms)
govern.

# 41. Spend Summary

- Workers Paid fixed subscription: already authorized.
- Workers AI overage: `$0` target / unauthorized.
- AI Gateway credits: `$0`.
- OpenRouter paid usage: `$0`.
- Other paid provider usage: `$0`.

No purchase, credit addition, billing activation, paid upgrade, or live Cloudflare inference was
performed in this campaign.

# 42. Evidence Files

- [Cloudflare account/cap evidence](../evidence/rc0r/cloudflare-cost-safety/account-and-cap.json)
- [Cloudflare paid-model audit](../evidence/rc0r/cloudflare-cost-safety/paid-model-candidates.json)
- [Electron forensic report](../evidence/rc0r/electron-exit49/forensic-report.json)
- [Packaged smoke summary](../evidence/rc0r/desktop-smoke/full-smoke-result.json)
- [Packaged smoke screenshots](../evidence/rc0r/desktop-smoke/screenshots/)
- [Source-state recertification](../evidence/rc0r/source-state-recertification/recertification.json)
- [Full-suite summary](../evidence/rc0r/full-suite/summary.json)
- [Full-suite JSON report](../evidence/rc0r/full-suite/current-full-suite.json)
- [Groq whole-agent run](../evidence/rc0r/groq-whole-agent/live-run.json)
- [Dogfood readiness](../evidence/rc0r/dogfood/readiness.json)

# 43. Commits

- `5b5cd96baf4c04476f84997ca65a3c11badf4bd0` — Harden provider routing and RC0R release safety.
- `f07f8cd` — Expose Cloudflare safe budget state in desktop UI.

Both commits are local only. No push was performed.

# 44. Remaining Release Blockers

1. Fresh successful Groq whole-agent execution, with real ForgeVerify and Completion Gate evidence,
   is still required.
2. ForgeGreen R1 external-provider proof remains pending.
3. R4 public-scale capacity evidence remains pending.
4. CodeForge’s desktop Cloudflare usage source is intentionally unknown/blocking; after the UTC
   reset, a trusted account-scoped usage source is required before any minimal live qualification.
5. Gemini Free remains blocked in the current desktop host until a trusted account identity and
   region source is wired; this is intentional fail-closed behavior. Mistral account attestation
   and Cerebras trial-vs-production qualification remain pending.
6. CodeForge-builds-CodeForge dogfood remains not attempted until the above live prerequisites pass.

# 45. Recommended Next Campaign

After the Groq planner/cancellation issue is understood, rerun one bounded Groq whole-agent task
with the exact captured Free model and no paid fallback. Require ForgeVerify, Completion Gate,
durable evidence, and then one deterministic safe failover test. After `00:00 UTC`, provide a
trusted Cloudflare usage observation below 8,000 Neurons and run at most one minimal qualification
request under the hard cap. Then, only if every live gate passes, run one low-risk
CodeForge-builds-CodeForge task and recalculate R1/R4 without upgrading beyond the evidence.
