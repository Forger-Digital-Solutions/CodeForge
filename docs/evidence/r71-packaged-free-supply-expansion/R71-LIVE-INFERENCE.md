# R71 live inference and qualification

All inference used public synthetic fixtures and legitimate zero-price cloud routes. Catalog and account preflights are separately labeled, with no inference on the existing paid-tier OpenRouter developer key.

| Proof | Actual result | Limit of claim |
|---|---|---|
| [Kilo Cohere qualification](kilo-free-direct-cohere_north-mini-code_free-2026-10-08T12-03-32-552Z-qualification.json) | 30 requests; CODER, TOOL_AGENT, ANALYST, EXPLORER qualified; PLANNER and REVIEWER hard failures. | Development qualification, no autonomous completion. Role results are not blanket model qualification. |
| [Kilo Poolside qualification](kilo-free-direct-poolside_laguna-s-2.1_free-2026-10-08T12-09-53-585Z-qualification.json) | One real request hit upstream 429; inconclusive provider failure, not qualified. | Scarce quota not repeatedly reprobed; transport failure does not demote model capability. |
| [Corrected transport sequence](live-failover-2026-10-08T12-09-05-404Z.json) | Kilo auto HTTP-200 embedded 503 correctly failed; named Cohere answered `5` for `2 + 3`, 79 tokens. | Health observer and real transport, not automatic production-dispatch failover or coding. |
| [Personal OpenRouter account](openrouter-account-proof.json) | Official PKCE user authorization, `/key` free-tier identity and 50/day before proof; three compact cases produced **four recorded transport calls** including multi-turn edit, plus a measured quota probe; real runtime read/edit/final response turns change Hello → Goodbye. Unrelated user sees no route, no active reservations afterward. | Interactive tool turn: verification/review `not_run`, workflow completion gate `not_evaluated`. No false claim of reviewed autonomous completion. |
| [Autonomous campaign](R71-TASK-CAMPAIGN.json) | Real production orchestrator/Fabric selection, 2 attempts, 0 completed; deadline cancellation and upstream 429 block. | Development execution before source freeze, not packaged product proof. |

The initial [transport diagnostic](live-failover.json) was produced before the transport fix and falsely labeled an embedded error/no-choices response successful. It is retained as historical failure evidence, expressly invalid for success claims. The corrected receipt supersedes it. Qualification suite completion timestamps can describe a sub-suite; use the containing receipt's final timestamp to bound the full run.

The OpenRouter key was kept in memory for the bounded validation and never written to evidence, `.env`, or product credentials. The connection process is now closed. The existing desktop official OAuth flow uses secure product storage and account verification; this transient harness did not install or configure the unsigned packaged app. The account receipt proves a working user-connected source, not an already persistent desktop connection.

No actual reviewer-approved, verified, integrated R71 autonomous task completed on either qualifying route. Gate D is **PARTIAL**: actual tools and a file edit are proven for OpenRouter; the stronger everyday autonomous requirement remains unmet.
