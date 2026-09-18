# CodeForge R14-OF — Ollama user-connected Free Cloud final report

Date: 2026-09-18
Status: **Implemented as an internal, rollout-flagged candidate; not public ForgeAuto/Free-ready.**

## Answers

1. **Can users create Ollama Free accounts?** Yes. Ollama documents a $0 Free plan with starter usage and starter models.
2. **Can they connect without installing Ollama?** Yes. Direct cloud API access is over `https://ollama.com/api` or `https://ollama.com/v1`; CodeForge uses the latter.
3. **Official auth mechanism?** API key in `Authorization: Bearer`.
4. **OAuth available?** No official OAuth/device flow was found in the reviewed material. The connection abstraction has future `API_KEY`/`OAUTH`/`DEVICE_AUTH` slots; Ollama is `API_KEY`.
5. **API-key onboarding implemented?** Yes: live `/models` validation, model discovery, secure connect, replacement, and disconnect are implemented behind `CODEFORGE_OLLAMA_USER_CONNECTED_FREE=1`.
6. **Credential storage secure?** Yes: existing main-process `safeStorage`, user-scoped encrypted key reference, renderer receives no secret.
7. **Can User A's key reach User B?** Not through the implemented desktop boundary: credentials are namespaced by the stable user scope and the renderer-safe view contains no key. Isolation tests cover the boundary.
8. **Independent pools?** Yes: `PER_USER_POOL`, `USER_ACCOUNT`, and hashed capacity identity.
9. **Can ForgeAuto consume only the connected user's pool?** The route and reservation primitives support that exact scope. Public routing remains disabled until the financial and terms gates pass.
10. **Concurrency enforced?** Yes: one-slot concurrency window plus reservation accounting.
11. **Is included usage distinguishable?** The model supports separate included and purchased balances. Current official API evidence does not provide a documented balance endpoint, so the desktop state remains `UNKNOWN` until an authoritative observation exists.
12. **Can purchased credits be prevented?** ForgeAuto/Free blocks purchased-credit crossover and auto-reload/paid subscription. A hard-stop proof is still required for public activation.
13. **What happens when Free is exhausted?** The route becomes exhausted/blocked and routing can continue with other qualified Free pools; CodeForge never buys credits or prompts an upsell.
14. **Is reset modeled?** Yes, as an observed `includedResetAt`; current UI says “Not observable” when no official account-scoped value is available.
15. **Which starter models qualify?** The live account catalog is authoritative. Current candidate metadata records `gemma4`, `gpt-oss:120b`, `gpt-oss:20b`, `nemotron-3-nano`, `nemotron-3-super`, and `nemotron-3-ultra` as starter candidates only.
16. **Which roles qualify?** None are publicly certified yet. 8-Bit must qualify each live model independently for Explorer/Planner/Coder/Reviewer-equivalent roles.
17. **Is private code acceptable?** Ollama's published privacy material says cloud prompts and responses are processed transiently and not used to train models. CodeForge keeps private-code routing behind its privacy and terms gates; provider/model terms are still separate checks.
18. **Are terms compatible?** Not certified. The own-account design is narrower than an owner-account relay, but the Terms' automated-access and competing-product restrictions remain material.
19. **Is provider permission required?** Yes, unless Ollama gives clear permission applicable to this third-party user-connected design.
20. **Can the owner dogfood the same path?** Yes. The implementation has no owner-only Ollama path; the owner uses the same user-scoped connection flow.
21. **How much capacity does a connected user gain?** `floor(observed included balance / estimated task cost)`, bounded by one concurrent request. The live included amount is not hard-coded.
22. **373-DAU adoption impact?** Under the illustrative simulation (`$2` per user, `$1`/task, 100 shared tasks/day): 10% → 37 users/74 added tasks; 25% → 93/186; 50% → 186/372; 75% → 279/558. These remain per-user entitlements, not aggregate company capacity.
23. **Ready for public ForgeAuto?** No.
24. **What remains blocked?** Official user-connected permission, authoritative included-balance and hard-stop proof, live account qualification, role evidence, and a production-grade usage observation path.

## Separate qualification verdicts

| Verdict | Result |
|---|---|
| `OLLAMA_OWNER_USER_CONNECTED_FREE_WORKS` | Technical path implemented; live owner test not run in this change |
| `OLLAMA_TECHNICAL_USER_CONNECTION_CERTIFIED` | Candidate implementation passes focused deterministic tests; live certification pending |
| `OLLAMA_FREE_ONLY_HARD_STOP_CERTIFIED` | **BLOCKED** — no documented hard-stop/balance API evidence |
| `OLLAMA_TERMS_USER_CONNECTION_CERTIFIED` | **BLOCKED** — provider permission required |
| `OLLAMA_FORGEAUTO_USER_FREE_CERTIFIED` | **BLOCKED** — depends on preceding gates and 8-Bit role evidence |

## Validation performed

- `npm.cmd run typecheck`
- Focused provider, ForgeZero, model-registry, desktop connection, and settings tests: **47 passed**
- Broader relevant ForgeZero, provider, model-registry, and desktop regression suite: **348 passed across 38 files**
- Added deterministic tests for Free-only financial scenarios, per-user pool identity, one concurrency slot, adoption simulation, cloud-only transport, user-scoped secure storage, and renderer secret absence.

No live inference, account changes, purchases, deployment, or production-secret changes were made.

## Official evidence reviewed

- [Ollama pricing and usage](https://ollama.com/pricing)
- [Ollama API authentication](https://github.com/ollama/ollama/blob/main/docs/api/authentication.mdx)
- [Ollama Cloud API documentation](https://github.com/ollama/ollama/blob/main/docs/cloud.mdx)
- [Ollama Terms of Service](https://ollama.com/terms)
- [Ollama Privacy Policy](https://ollama.com/privacy)
