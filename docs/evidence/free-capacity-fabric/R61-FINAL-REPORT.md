# R61 Free Capacity Fabric continuation

Status: **PARTIAL**. `CODEFORGE_FREE_CAPACITY_FABRIC_COMPLETE` is not claimed.

Starting HEAD: `f4c455a68eb0d2331c4e5a38f667640ca5304f24`. The unrelated dirty R57–R60 files and parked GPU/Qwen files were preserved. The inherited Kilo autonomous completion and synthetic-domain failover receipts remain in this directory; neither was relabeled as two-live-domain proof.

## What this continuation delivered

- The desktop now rechecks Kilo's authoritative terms, Free data warning, and billing documentation at startup and every six hours. The current normalized page hashes were fetched live on October 1. A changed page clears the Kilo admission receipt; an unreachable page cannot create a new receipt, and a prior receipt expires after seven days. New direct assignments fail closed until the startup check succeeds. `terms-reverification.json` records the live result; `privacy-reverification.json` and tests record the private-code and change behavior.
- The sponsor intake library accepts only strict versioned Ed25519 manifests signed by a trusted, time-valid sponsor key. It checks cost, commercial use, privacy evidence fields, expiry, offer identity, monotonic sequence, revocation, HTTPS origin, ETag refresh, bounded body size and backoff. A signed manifest becomes an inert proposal. Independent zero-cost, terms, privacy, quota, qualification and canary receipts are required before materialization. There is no real sponsor grant or deployed operator workflow.
- Remote client-direct assignment and feedback primitives now bind account, device, session, workspace, run, route, physical quota domain, Kilo endpoint, Free model, request digest, expiry and nonce. The installed client rejects an unadmitted local route; frames are authenticated and sequenced; feedback is authenticated, single-settlement and scoped into 8-Bit. A test shows Alice's signed public-IP 429 does not hard-exclude Bob's separate public-IP domain. The hosted assignment transport, real remote stream relay, session handshake and runtime reservation/cancellation integration remain open.
- A legacy migration assessor maps only explicit recurring zero-cost evidence to the new schema. Unknown cost or missing terms/privacy/qualification stays `REQUIRES_REVERIFY`; promotional and sponsor-funded legacy classes do not silently become Packaged Free. Production route selection has not cut over to this assessor, and the actual legacy account inventory remains unverified.

## Second-domain attempt

OpenRouter's official PKCE flow already exists in the desktop. Its live catalog showed zero prompt and completion prices for `nvidia/nemotron-3.5-lightning:free`. A real request through the available environment credential returned HTTP 200, a `record_result({"value":7})` tool call, `usage.cost = 0`, `upstream_inference_cost = 0`, and `is_byok = false`. A separate Qwen Free-model probe returned 429. The authenticated current-key endpoint reported `is_free_tier = false` for this key. Its ownership is an environment credential, so the probe is **not** an admitted CodeForge Packaged Free route or a user-entitled Free account. No second-domain autonomous edit, Reviewer, ForgeVerify completion, or two-live-domain failover was run. See `second-live-domain.json`.

Gemini's official OAuth path requires an enabled Cloud project and production authorization scope verification. The available Gemini environment key has no verified Free billing-tier or delegated-project receipt, so it was not used for inference. Groq documents Free limits, but the available credential's account/project tier and product authorization were not verified. Neither was admitted. Exact missing authorization is a real user Free account connected through a sanctioned flow with current tier and free-only proof, or a provider-approved zero-marginal-cost CodeForge grant. The route then needs terms/privacy, quota, coding qualification and autonomous completion receipts.

## Closure matrix

| Gate | Result | Evidence or remaining condition |
| --- | --- | --- |
| A quota-domain architecture | PASS, inherited | Existing domain model preserved. |
| B domain-scoped cooldown | PARTIAL | Signed feedback preserves Alice/Bob scope in tests; no production remote clients. |
| C Kilo Direct | PASS, inherited and reverified | Live authoritative policy recheck and prior Kilo task receipts. |
| D second live independent admitted domain | OPEN | OpenRouter live probe is not an admitted entitlement. |
| E second-domain coding qualification | OPEN | Tool probe only. |
| F second-domain autonomous dogfood | OPEN | No real edit, Reviewer or gate on second domain. |
| G two-live-domain failover | OPEN | Inherited controlled proof uses a synthetic first domain. |
| H remote client dispatch | OPEN | Secure protocol primitives exist; hosted transport is not wired. |
| I signed client feedback | PARTIAL | MAC/replay/scope tests pass; remote production delivery is open. |
| J sponsor manifests | PARTIAL | Signed remote feed library passes tests; no deployed feed or trusted sponsor grant. |
| K sponsor lifecycle | PARTIAL | Local proposal, qualification, canary, promotion, revocation and expiry guards; no durable operator pipeline. |
| L automatic terms re-verification | PARTIAL | Kilo production startup/timer path; other admitted Free routes not migrated. |
| M privacy re-verification | PARTIAL | Kilo policy hash and route invalidation; other routes open. |
| N legacy migration | OPEN | Decision logic exists; production cutover and real account inventory are open. |
| O no paid contamination | PASS in scoped checks | No paid, BYOK, paid GPU or ForgeZero relaxation was added. |
| P arbitrary-user architecture | PASS, inherited | No registration ceiling added; capacity remains domain-dependent. |
| Q validation | PARTIAL | Final build and 359 scoped tests pass. Full suite did not complete. |

## Validation

The final workspace build passed. The final scoped command passed **359 tests in 33 files** with zero failures or skips. An `npm test` attempt ran for about 28 minutes, showed many unrelated timeout and credit/source-certificate failures, and was stopped after exceeding twice the prior 802-second baseline without a final Vitest summary. No exact repository-wide totals or green claim are made. Isolated `progress-watchdog.test.ts` passed 5/5 and `autonomous-orchestrator.test.ts` passed 22/22. `cloud-failure-matrix.test.ts` still failed alone on a 500,000-credit assertion; the previously documented cloud account/deletion failures remain reproduced on unchanged base HEAD. See `validation-results.json`.

The next closure work is a sanctioned second Free account/grant and coding qualification, followed by the hosted remote transport and durable sponsor/legacy operator cutover. No provider limits were circumvented and no money was spent on inference infrastructure.
