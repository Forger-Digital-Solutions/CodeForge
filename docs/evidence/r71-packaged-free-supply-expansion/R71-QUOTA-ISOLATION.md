# R71 quota isolation

Two kinds of ownership must stay separate: Kilo PUBLIC_IP and OpenRouter USER_ACCOUNT. One model is not one pool. All Kilo aliases at one egress share its physical parent window. Ambiguous/account/IP limits cool that entire domain; a trusted model-scoped upstream 429 cools only the named model inside it. It does not mint another 200/hour allowance.

`packages/eight-bit/test/r71-free-pool-isolation.test.ts` passes six deterministic regressions: model-limit sibling rotation/recovery, ambiguous shared-domain exhaustion and aliases, Alice/Bob owner isolation with hydrated state, and simultaneous 2/10/25/50 synthetic independently entitled fixture domains with reservation cleanup. These fixtures are explicitly test providers. They establish implementation semantics; they are not measured live 50-user throughput or independent-IP entitlement.

`packages/model-registry/test/r71-kilo-health-wiring.test.ts` passes two tests using the real adapter and FreeCloudService observer with injected HTTP responses, proving model/domain scope reaches production health once and unrelated domains remain untouched. Provider tests cover governor scope, including an account/IP message that also mentions a model.

The real OpenRouter receipt verifies a personal free account through official `/api/v1/key`, hashes identity rather than exposing it, builds an owner-only production route, admits it through FreeFabric, and records **zero routes for an unrelated user**. Actual runtime edit completed and active reservations returned to zero. See [account proof](openrouter-account-proof.json). Receipt validity ends at 2026-10-08T18:21:39.153Z; fresh verification is required afterward.

The Kilo autonomous campaign conservatively carries `PUBLIC_IP:shared-unverified`; it does not prove two distinct real egress addresses. Only one personal OpenRouter account was connected. Two independently entitled live users executing concurrently were not available, so acceptance Gate C is **PARTIAL**, and Gate A cannot be closed merely by counting provider names.

All recorded real campaign terminal paths released their reservations. Durable waiting/recovery/process-restart and stale-owner/entitlement safeguards pass the affected existing regressions. There was no new live provider-reset, second-account, or process-restart proof against the personal account, and no claim that deterministic recovery is live proof.
