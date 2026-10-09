# R73 quota and user isolation

Audit date: 2026-10-08. Baseline: R72 delivery `220b365c553bff0b1ee952fb6b96498c8ddea325`. Quota ownership remains based on the existing `provider:scope:identityHash` evidence and physical capacity-independence rules. Registered users, local sessions, model aliases, and extra API keys do not create additional provider allowances.

## Deterministic validation

The focused R73 isolation run passed **24/24 tests in four files**. See [quota-isolation-tests.json](quota-isolation-tests.json) for individual assertions and the exact Vitest results. Command:

```text
node node_modules/vitest/vitest.mjs run packages/eight-bit/test/r71-free-pool-isolation.test.ts packages/eight-bit/test/r52-multi-user-fairness.test.ts packages/forge-zero/test/capacity-independence.test.ts packages/model-registry/test/blockrun-free-supply.test.ts --reporter=json --outputFile=docs/evidence/r73-free-supply-and-completion/quota-isolation-tests.json
```

| File | Passed | Evidence covered |
| --- | ---: | --- |
| `r71-free-pool-isolation.test.ts` | 6 | Existing 2/10/25/50 simultaneous fixture owners with authoritative distinct quota identities; admission and dispatch reservations; model rotation within one pool; ambiguous pool cooldown and hydration |
| `r52-multi-user-fairness.test.ts` | 7 | Existing 50 users × 3 concurrent fixture turns; fairness, provider isolation, idempotent request holds, lease recovery, per-user concurrency and first-run reservation |
| `capacity-independence.test.ts` | 6 | Unknown NAT collapses across users/models/keys; same verified egress remains one group; distinct verified egress differs; same account's keys remain shared; organization/sponsor ownership; malformed or stale evidence fails closed |
| `blockrun-free-supply.test.ts` | 5 | New anonymous route source-IP classification; its own policy receipt; public/private code admission; scoped cooldown isolation from Kilo and other egress identities; changed terms withdraw admission; Reviewer-only qualification remains role-bound |

The first attempt could not collect tests because the restricted sandbox's Vite transform-cache files disappeared (`ENOENT`); no assertions executed. [quota-isolation-cache-error.json](quota-isolation-cache-error.json) preserves that failure. The passing rerun used a worktree-local temporary directory, which was subsequently resolved against the exact worktree root and removed. Providers and account data were injected fixtures; this run made no live inference calls or account changes. Missing intelligence sourcemap source warnings did not fail the assertions.

Separate [account validation](user-entitlements-validation.json) passed 85/85 overlapping affected tests, including owner-specific OpenRouter credentials/receipts, restart recheck, revoked credential withdrawal, owner-switch races, legacy OAuth migration, Puter owner isolation/disconnect, encryption and browser boundaries. Counts are separate and are not added to broad-suite totals. [Kilo scope tests](kilo-upstream-scope-tests.json) passed 21/21; their shared/model upstream walls are recorded separately by the provider/runtime workstream.

## Correct supply boundaries

| Supply | Quota owner and limit | Isolation implication |
| --- | --- | --- |
| Kilo anonymous direct | Public source IP; documented 200 requests/hour shared across Free models | Same NAT shares capacity. A new model/user/session cannot multiply it. Unknown egress evidence is conservatively grouped. |
| BlockRun anonymous direct | Public source IP; documented 30 requests/minute and 300/hour shared across Free models | Separate gateway quota domain from Kilo; multiple BlockRun models remain one source-IP allowance. Free upstream NVIDIA capacity may fail or correlate independently of the gateway's counters. |
| OpenRouter unpaid entitlement | Authoritative external account identity; documented 50 requests/day and 20 requests/minute | Owner-scoped local authorization is required. Multiple keys for the same account remain one physical domain. Paid-tier/ambiguous receipts are excluded from automatic Free. |
| Groq managed fallback | Existing CodeForge organization/account allowance | Shared managed capacity; it is not an independent entitlement for each registered user. |
| Puter | Encrypted owner account connection and observed allowance | Transport infrastructure remains blocked from Free admission because purchased-credit continuation is not authoritatively prevented. Observations are not new capacity. |
| SambaNova/Z.ai optional connections | Provider account/key with independently verified cost/quota/privacy requirements | Existing adapters and narrowed catalog policy do not establish a live, user-owned allowance without an authorized account receipt. |

Kilo and BlockRun direct limits are separate provider allowances, not a guarantee of independent underlying model infrastructure or concurrency. The dispatch governor and route-health authority distinguish model failures from provider/quota-owner walls. BlockRun's shared gateway 429 cools its affected source-IP provider domain, not Kilo or an independently evidenced source-IP identity. A model/schema failure must not become an unrelated account or provider cooldown.

The desktop OpenRouter key is now stored under the local owner's hashed credential key. A switched owner cannot refresh the previous owner's key into a new receipt. Restart retains encrypted credentials but requires an authoritative recheck before delegated Free admission; account rejection withdraws the route. Puter SDK initialization remains trusted-process-bound to its owner token and becomes unusable after account change, disconnect, or token replacement. See [R73-USER-ENTITLEMENTS.md](R73-USER-ENTITLEMENTS.md).

## Live constraints and practical capacity

R71's account-owned OpenRouter inference remains historical evidence. R72's accessible OpenRouter credential was paid-tier and therefore excluded from automatic Free. This workstream received no newly verified unpaid OpenRouter account, no second independently owned authorized account, and no second independently verified public-IP egress. It created no external accounts, rotated no IPs, and performed no live account authentication or revocation.

R73's actual anonymous inference and Reviewer results are recorded in [R73-SUPPLY-MATRIX.md](R73-SUPPLY-MATRIX.md), [R73-REVIEWER-RECOVERY.md](R73-REVIEWER-RECOVERY.md), and individual live receipts. They do not prove live two-user allowance independence, same-NAT external counters, or account revocation/restart in an installed desktop. The 2/10/25/50-user assertions demonstrate deterministic application isolation only.

The application imposes no arbitrary registered-user ceiling. Real capacity is finite: all users on one public IP share the applicable Kilo and BlockRun quotas; every distinct verified unpaid OpenRouter account contributes its own allowance; managed fallback remains shared. Requests are not equivalent to autonomous tasks, since a task uses multiple model calls and qualification/recovery also consume quota. Do not multiply source-IP or organization quotas by registrations. No live aggregate capacity guarantee is claimed.

Outstanding live evidence requires two legitimate authorized unpaid account entitlements or distinct verified egress domains, same-NAT observations that remain within limits, cross-user revocation/credential isolation through the real application, and authorized packaged desktop restart. None of those prerequisites is fabricated or waived by the passing fixture tests.
