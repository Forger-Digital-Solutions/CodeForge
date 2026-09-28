# R55 architecture handoff

Status: product-owner requirements recorded during R54. This document is a handoff, not an R55 implementation or an R54 closure claim. R55 begins only after all three R54 live gates close and R54 is certified.

## ForgeAuto roster and execution topology

- ForgeAuto is the orchestration strategy for a user-selected roster. Do not create a separate Fusion subsystem without evidence of a distinct need.
- The conceptual flow is user-selected roster -> ForgeAuto -> optional Lead -> dynamic worker team -> Reviewer -> ForgeVerify. ForgeVerify alone authorizes completion; a Lead may recommend it but cannot bypass the completion gate.
- Free accounts may select only currently approved 8-Bit free models. Paid accounts may select from current approved 8-Bit free and 16-Bit paid models. Paid access does not force paid execution: one paid Lead with free workers is an intended configuration. No hidden paid or BYOK fallback for Free users. BYOK remains separate unless a future explicit BYOK Auto mode is authorized.
- The roster should be compact and intentional: minimum two selected models, recommended three or four, with a probable four-to-five-model upper bound to validate in R55. Do not hard-code an irreversible maximum before evidence supports it.
- A Paid user may select a Lead manually, let ForgeAuto select one, or use no explicit Lead. Lead is a role/topology preference, not an access tier. It may handle intent, difficult planning, architecture, delegation, escalation, and compressed worker review.
- ForgeAuto may assemble Explorer, Planner, Coder, Tester, and Reviewer workers from the user's approved roster. Assignment considers role qualification and quality, capacity, price, policy, Shilling efficiency, and independence requirements. It is not limited to one Sidekick.
- Future Paid cost preferences may offer cheapest, balanced, and maximum-intelligence behavior. The paid Lead should be used where its value warrants cost, while qualified free workers can perform mechanical work. Implement these modes only after the cost and Shilling model is established.

## Dynamic 16-Bit paid families

- 16-Bit is the dynamic paid sibling of 8-Bit, based on approved model families rather than a permanently hard-coded list of paid model IDs. Luna, GLM Flash, Qwen Flash, and DeepSeek Flash are conceptual examples, not a production roster.
- A newly discovered family version is a candidate, not an automatic upgrade. Inspect pricing, context, tools, reliability, role qualification, live proof, cost, and quality before promotion. Reuse existing lifecycle terms where possible; the intended progression is discovered -> probation -> qualified -> active -> superseded -> retired.
- A family upgrade (for example Luna 5.6 to Luna 6) may follow a certified successor only for a family `AUTO_CURRENT` slot. A `PINNED_VERSION` slot stays on its exact version. An explicit Luna selection never silently substitutes another family such as GLM; cross-family substitution requires an AUTO slot or other explicit policy.
- A predecessor may remain useful as an economy option after a newer, stronger, more expensive version becomes active. Evaluation must include verified completion, role quality, reliability, context, tool use, latency, input/output cost, Shillings, dollars per verified task, and efficiency against the incumbent. A newer version or higher raw benchmark score alone does not win.

## Shillings and accounting

- Shillings (`Sh`, pending final abbreviation) are a normalized inference-work unit, conceptually one normalized text-token-equivalent of CodeForge inference capacity/work. They are not a purchasable SaaS currency. The production conversion requires evidence.
- Design a Shilling ledger, likely owned by ForgeGreen/usage accounting, reusing raw telemetry. Track provider, account, route, model, role, task, raw allowance unit and usage, raw remaining allowance, conversion source and confidence, Sh consumed and remaining, Sh per request/successful role/verified task, paid spend, and timestamp.
- Conversion confidence is authoritative, observed, estimated, or unknown. Preserve `UNKNOWN` when evidence is absent; never invent a conversion. Provider allowances may be tokens, requests, credits, dollars, neurons, compute units, or provider-specific quotas.
- Distinguish gross theoretical Sh, usable Sh after qualification/policy/health/capacity constraints, and available-now Sh. Task receipts should show per-role Sh, total Sh, and paid spend, including a visible Free/Paid mix and paid inference share.
- Future benchmarking may report Shillings to verified completion (total Sh / verified completed tasks), verified work per million Sh, and free autonomous work per million Sh. Competitor estimates require actual evidence.

## R55 backend completion matrix

- R55 is the backend 100% completion matrix, not a random feature round. Enumerate internally controllable requirements across 8-Bit, 16-Bit, ForgeGreen, ForgeVerify, ForgeAuto, subagents, scheduling, restart/recovery, provider boundaries, usage accounting, Shillings, selected rosters, Lead/worker topology, paid-family rotation, and observability.
- Every matrix row must end in `PROVEN_DETERMINISTIC`, `PROVEN_LIVE`, `NOT_APPLICABLE`, or `BLOCKED_EXTERNAL`. `NOT_TESTED`, `PLANNED`, `ASSUMED`, `TODO`, and appearance-based claims are not completion.
- GEMS remains a separate proprietary frontier model family, not 8-Bit, 16-Bit, ForgeAuto, a wrapper, a third-party alias, or the Lead abstraction. A future GEMS model can join ForgeAuto only after genuine training, evaluation, freezing, and integration.

## R54 boundary

R54 records raw usage and completes the substantial-refactor, cross-package integration, and live alternate semantic Reviewer gates. No roster UI, Lead slot, paid-family rotation, Shilling normalization, or Paid cost mode implementation begins while R54 is blocked. The R54 report must not present these future requirements as proven features.

## Product thesis and user-owned intelligence addendum

CodeForge should make the model market interchangeable infrastructure. The developer permits intelligence sources and builds software; ForgeAuto determines how to use the approved resources. Frontier intelligence is valuable where it improves verified outcomes. Qualified free or cheaper workers should handle work they can reliably complete, while a frontier Lead concentrates on intent, architecture, difficult diagnosis, escalation, and compressed worker findings. This is an evidence-based optimization for the lowest practical inference cost that reaches verified completion with acceptable reliability, not a rule to always select the cheapest or strongest model. Repeated cheap-worker failure and frontier work on mechanical tasks both count against efficiency. ForgeVerify still decides completion.

### Source classes and authorization

- Keep 8-Bit CodeForge-managed Free, 16-Bit CodeForge-managed Paid, and user-managed/BYOK sources auditable and separate. Future explicit source classes may include `MANAGED_FREE`, `MANAGED_PAID`, `USER_API`, `USER_HOSTED`, and `LOCAL`; reuse repository-native names where possible. GEMS remains its distinct CodeForge/FDS-owned frontier family.
- ForgeAuto/Free uses only 8-Bit. ForgeAuto/Paid uses only the user's selected 8-Bit and plan-allowed 16-Bit members. A future ForgeAuto/Custom mode may admit specifically authorized user API, private/organization endpoint, self-hosted, or local models, along with allowed managed members. Neither Free nor Managed Paid may silently consume a user account, endpoint, or paid balance. A user-owned source never silently becomes managed capacity.
- Every roster member should carry family, version, provider, source class, role qualification and quality, lifecycle, cost provenance, meter confidence, and privacy/data-policy eligibility. Selection, role permissions, fallback permission, Lead-only/worker-only preference, pinning, and version policy must be explicit. A user preference does not bypass ForgeVerify.
- User-owned models require role-specific qualification. Identity, context, tools, structured output, Explorer/Planner/Coder/Reviewer suitability, latency, reliability, and available usage metadata should be measured. User ownership does not imply qualification. Provider endpoints must respect task isolation, privacy/consent, organization policy, role ownership, and failover boundaries.
- A family `AUTO_CURRENT` selection may follow a certified successor in that family. `PINNED_VERSION` stays exact. A user-owned endpoint does not change identity just because its provider announces a new model.

### Cost, escalation, and evidence

- Separate the CodeForge billing ledger (subscription allowance and CodeForge-paid spend), the cross-source Shilling work ledger, and user-owned provider-spend telemetry. Do not attribute user API charges to CodeForge. Show authoritative or estimated user-provider spend only when supported by provider evidence, with confidence and `UNKNOWN` otherwise.
- Shillings compare inference work across 8-Bit, 16-Bit, user API, user-hosted, future GEMS, and supported local sources; they do not identify who paid and are not credits. Source-class-aware task receipts should show each class's Sh, managed spend, user-provider spend, and ForgeVerify result separately.
- Future bounded escalation may move from a qualified free/cheap worker to an alternate, then to a paid worker or frontier Lead only when the user's policy permits and evidence justifies it. Avoid both immediate expensive escalation after one failure and endless low-quality retries. Planned cost policies include cheapest, balanced, maximum intelligence, and possibly custom controls for per-task/monthly managed spend, Lead permission, user API permission, free-first preference, and escalation threshold. Final names and thresholds require evidence.
- Instrument frontier inference share, free offload ratio, frontier cost per verified task, and Shillings to verified completion without inventing values. Compare equivalent tasks with a frontier-only baseline and the same frontier model as Lead with qualified workers: verified completion, time, frontier/total tokens and Sh, dollars, retries, model calls, and intervention. Do not assume the Lead strategy saves cost before measurement.
- Credentials must use the repository's secure storage and redaction paths. Never log, receipt, model-expose, plaintext-persist, or cross-send an API key. Keep private-code eligibility, provider data handling, user consent, organization rules, endpoint ownership, and local/private status in routing decisions.

### Existing repository seams audited during R54

| Existing seam | Reuse potential | Gap for R55 |
|---|---|---|
| `packages/model-registry/src/env-discovery.ts` | Presence-only environment discovery, enabled preferences, and `OFF`/`FREE_ROUTES_ONLY`/`ALL_ENABLED_BYOK_ROUTES` policy; default is Free-only. | No persisted ForgeAuto/Custom roster or per-member source authorization contract. |
| `packages/model-registry/src/free-cloud-registry.ts` and `free-cloud-service.ts` | Credential-source and paid-BYOK labels; managed Free capacity projection explicitly excludes Paid/BYOK routes. | Need a source-class-aware roster view without merging managed and user-owned capacity. |
| `packages/providers/src/provider-factory.ts`, `openai-compatible.ts`, and `openrouter-oauth.ts` | Provider adapters, optional credential store/direct key, compatible API transport, and user-controlled OpenRouter key exchange. | User/organization endpoint registration, ownership, qualification, and allowed-fallback contracts are not a unified ForgeAuto source. |
| `packages/eight-bit/src/qualification/` and `role-quality.ts` | Fresh role-specific qualification receipts and quality advice. | Generalize the discipline for explicitly user-owned sources without lending 8-Bit Free status or trust. |
| `packages/eight-bit/src/free-fabric.ts` and `packages/server/src/agent-runtime.ts` | Role, capacity, health, policy, and independence admission; free and paid role routing already have explicit branches. | ForgeAuto still lacks a single user-approved mixed-source roster and bounded cross-class escalation policy. |
| `packages/paid-auto/src/registry.ts` and `role-router.ts` | Paid route records, price provenance, and fresh per-role verdicts. | Registry is a fixed canonical-model union/list; family succession, `AUTO_CURRENT`, pinning, promotion/demotion, and incumbent cost comparisons remain to be built. |
| `packages/cloud-usage/src/types.ts`, `packages/cloud-billing/src/`, and R54 raw journals | Token/credit calculations, managed billing, and raw request usage provenance. | No cross-source Shilling ledger or distinct user-provider spend receipts. Existing cloud credits are not Shillings. |
| `packages/secrets/src/` and provider response redaction | Environment filtering and credential redaction primitives. | Complete security proof for user-added endpoints and credentials remains an explicit matrix requirement. |

This is a source audit, not a claim that the gaps are implemented or that current BYOK/local routes are safe to mix into ForgeAuto/Free.

### Addendum rows required in the R55 matrix

Include user-selected roster persistence; Free/Paid/Custom roster eligibility and compact size; optional Lead and role assignment; managed-Free, managed-Paid, and BYOK source isolation; custom endpoint registration; user-owned qualification and per-role suitability; family/version pinning and `AUTO_CURRENT`; 16-Bit successor discovery and promotion/demotion; paid price/quality evaluation; frontier-offload telemetry; raw usage; separate billing, user-owned spend, and Shilling ledgers; source-aware task receipts; bounded explicit escalation; no-silent-paid and no-silent-BYOK invariants; credential security; privacy/data-policy routing; and ForgeVerify authority across every source. Use only the matrix evidence states defined above.
