# Free capacity fabric — execution status (2026-10-01)

Status: **PARTIAL — do not claim product completion**.

Base HEAD: `24ecf1dd0cae5d78e6ee661efb779118b28387e1`. This checkout contained unrelated dirty R57–R60 work before this round; that work was preserved. The Free fabric change is scoped independently of those files.

## Implemented

- ForgeZero now represents quota domain, egress mode, explicit CodeForge marginal cost, privacy/training policy, and evidence receipts. New Packaged Free classes fail closed on missing or stale metadata. Costed, paid, and BYOK classes are excluded.
- A pinned Kilo anonymous transport runs only when a trusted installed client authorizes it. Its only host is `api.kilo.ai` over HTTPS; only `/models` and `/chat/completions` are used. It sends no credentials, rejects redirects, and accepts only `kilo-auto/free` or `:free` model IDs whose live catalog lists zero input and output prices.
- Desktop registers this transport with a per-user, public-IP pool. The default private-code policy excludes it. A user can attest that the active repository is public and consent to broader Free routing in Data & Privacy settings. The main process binds consent to that workspace; opening another workspace clears it. Legacy consent without a workspace binding fails closed.
- 8-Bit carries quota-domain and egress facts into its route ledger and prefers the isolated direct route for its owner. A fabric test proves that an exhausted Alice public-IP pool falls through to another Free domain while Bob's pool stays available.
- Capacity feedback, cooldowns and durable health snapshots carry the served physical pool. A 429 affects aliases sharing that pool, while another pool serving the same model remains eligible. Scoped failures no longer globally mark the ForgeZero model unavailable. The selected fabric decision carries quota domain, egress and marginal cost metadata.
- A sponsored-offer materializer rejects proposals, unqualified/expired grants, unknown data policy, and commercial-use restrictions. Lifecycle transitions enforce terms review → qualification → canary → promotion; promotion requires a canary receipt and installs the grant's concurrency cap. This is a foundation, not yet a live remote onboarding pipeline.
- Successful Kilo catalog refreshes remove models that disappeared or lost zero pricing, including an empty verified-free catalog. Null/blank pricing cannot certify a Free route.

## Real upstream observations

At approximately 20:00 UTC on 2026-10-01, anonymous `kilo-auto/free` returned HTTP 200 for a synthetic public prompt, with `usage.cost: 0`, `usage.cost_details.upstream_inference_cost: 0`, and `is_byok: false`. The resolved physical model was `stealth/space-bunny-alpha`. The same route worked through CodeForge's compiled direct adapter (`READY`, 161 input and 2 output tokens), then streamed a `record_result({"value":7})` tool call and usage (398 input, 27 output tokens). No secret header was sent by the adapter.

The live `/models` catalog listed `kilo-auto/free` with prompt and completion prices of `0`, plus several `:free` entries.

At 20:13–20:14 UTC, a real CodeForge local interactive runtime used `kilo-free-direct/kilo-auto/free` to inspect a fresh public synthetic workspace, write `add.ts`, and run functional checks. The turn reached `completed`. Its `run.outcome` explicitly recorded `executionMode: chat`, `verification: not_run`, `review: not_run`, and `completion: not_evaluated`. This is a real coding edit and tool-flow proof, **not** the required autonomous ForgeVerify completion gate.

At 22:19–22:22 UTC, the existing role suite measured Coder, Tool Agent, Analyst, Planner and Reviewer as QUALIFIED, with Explorer on PROBATION. The production autonomous orchestrator then fixed a real subtraction bug in `math.ts`, ran an independent model Reviewer, executed all three existing Node tests through ForgeVerify, passed `evaluateCompletion`, and integrated the commit. The durable ForgeVerify records include a plan, passed attempt, passed evidence and SUFFICIENT coverage receipt. See `kilo-live-qualification.json` and `kilo-autonomous-live.json`. The completion gate was not changed.

The corrected controlled-failure run (`kilo-autonomous-controlled-failover.json`) dispatched exactly one request to an explicitly marked `isTestProvider: true` synthetic domain, injected a 429, recorded ROTATE with INDEPENDENT_POOL_PREFERRED, and continued through actual anonymous Kilo inference. It produced the edit, independent Reviewer approval, three passed ForgeVerify tests, a completed gate and integration. The injected domain is **simulation only**; this does not demonstrate two live independent upstream providers. The fixture asserts that a fault was actually dispatched and a rotation was recorded before reporting successful acceptance.

The anonymous transport has no billing credential and accepts only Free model IDs verified against current catalog zero prices. Official billing policy and the earlier raw response's `usage.cost: 0` support $0 end-user inference and $0 CodeForge marginal inference cost for these Kilo tasks. A raw billing amount was not separately captured for every model request in the autonomous run.

Validation: the final affected-package run passed 1,051 tests (3 skipped, 100 passed files and 1 skipped file). The final security/privacy/sponsor checks passed another 72 tests in 7 files after the last hardening edits. The workspace build passed. Full `npm test` did **not** pass: 4,298 passed, 16 failed, 50 skipped, plus a worker heap failure. Four cloud credit/account failures reproduce on an exported, unchanged base HEAD; the raw baseline results are in `baseline-credit-audit.json`. Fresh affected-package runs resolve the stale-module failures from edits during the full run, including the corrected settings registry entry. Frozen source-identity campaign failures and remaining full-suite failures have not been recertified in this round. See `validation-results.json`; no repository-wide green claim is made.

## Route and closure inventory

| Item | Result |
| --- | --- |
| New admitted supply | `kilo-free-direct/kilo-auto/free`, anonymous `PACKAGED_FREE_DIRECT`, live qualified Coder/Tool Agent/Analyst/Planner/Reviewer; Explorer remains PROBATION. Other zero-price catalog entries require their own qualification. |
| Researched routes | Kilo Gateway, OpenCode Zen, Gemini Developer API, GitHub Copilot Free, Cline Free, OpenRouter Free; source comparison and admission decisions are in `FREE-PRODUCT-COMPARISON.md` and `provider-capacity-matrix.json`. |
| Not admitted | Legacy keyed `kilo` remains gated by its existing legal-review definition; Zen/Gemini/Copilot/Cline have no new admitted route in this round. No new sponsor agreement exists. |
| Physical supply proven | One newly connected live domain: Kilo's actual public egress IP. Two users behind one NAT share it. Synthetic `test:fault-pool` is not counted as live supply. |
| Domain types | `USER_ACCOUNT`, `PUBLIC_IP`, `PROVIDER_PROJECT`, `PROVIDER_ACCOUNT`, `SPONSOR_POOL`, `CODEFORGE_ACCOUNT`, `GLOBAL_SHARED`, fail-closed `UNKNOWN`. |
| Egress modes | `CLIENT_DIRECT`, `CODEFORGE_GATEWAY`, `USER_DELEGATED`, `SERVER_SPONSORED`; installed-host direct execution is implemented, remote dispatch/feedback remains open. |
| Sponsored supply | Lifecycle/materializer foundation only; zero live grants and no authenticated remote manifest pipeline. |
| Privacy types | `PRIVATE_SAFE`, `PROVIDER_RETENTION`, `DATA_COLLECTION_ALLOWED`, `PUBLIC_CODE_ONLY`, fail-closed `UNKNOWN`. Kilo is broader-data-use supply admitted only for public code with workspace consent. |
| Cost | $0 user inference and $0 CodeForge marginal inference for the new Kilo route, supported by anonymous zero-price access and the recorded raw usage cost; autonomous per-call billing amounts were not separately recorded. |
| Closure gates A–D/G/I | New-schema domain, egress, cost, privacy, health and paid-exclusion controls are implemented and tested; legacy schema migration remains open. |
| Closure gates E/J/L | Real Kilo access, qualification, autonomous edit, Reviewer, ForgeVerify, gate and integration are evidenced. Terms expire on October 8 unless reverified. |
| Closure gates F/H | Independent-pool selection and automatic fault rotation are tested; one injected domain plus one live upstream completes a real task. Two-live-upstream proof remains open. |
| Closure gate K | No new fixed registration ceiling or singleton global pool is imposed; the installed-host path uses finite owner-scoped domains. Remote multi-user client transport remains open. |

The scoped implementation commit is reported in the final response. Base HEAD above identifies the preserved starting state; generated desktop binaries from this validation are not release artifacts.

## Gates still open

- Two live independent upstream domains have not been demonstrated. Controlled domain failure with real Kilo task continuation is proven; a second contractually admitted provider or sponsor allocation is needed for the physical supply proof.
- Kilo is the only newly connected independent quota domain. Other providers remain research or existing shared/user-connected supply, not new admitted routes.
- Trusted installed-host feedback is scoped and persisted. A hosted server dispatching jobs to remote user clients, with signed authenticated result feedback, remains open. The direct route currently runs on the single-user installed desktop host.
- Sponsor offers do not yet arrive through a remotely refreshed, authenticated manifest. A full proposal-to-canary operator pipeline remains open.
- The Kilo terms receipt is deliberately time-limited to 2026-10-08. After that it fails closed until authoritative terms/privacy evidence is reverified; automatic terms re-verification is not yet implemented.
- New Packaged Free classes enforce explicit evidence and zero marginal cost. Older supply classes retain their existing admission policy; migrating all legacy inventory to the full new receipt schema is still open.
- Registration is not capped by a fixed user count, but actual concurrent inference remains limited by each user's real public-IP and other authorized quota domains. Users behind one NAT share Kilo's documented IP allowance.

## Source evidence

- [Kilo authentication and anonymous per-IP allowance](https://kilo.ai/docs/gateway/authentication)
- [Kilo API, Auto Free, and changing catalog](https://kilo.ai/docs/gateway/models-and-providers)
- [Kilo free pricing and rate limits](https://kilo.ai/docs/gateway/usage-and-billing)
- [Kilo Auto Free data warning](https://kilo.ai/docs/getting-started/using-kilo-for-free)
- [Kilo Gateway API third-party application terms](https://kilo.ai/terms)
