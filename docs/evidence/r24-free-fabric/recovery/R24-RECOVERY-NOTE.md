# R24 Recovery Note (Phase 1)

Recorded: 2026-09-21 16:47Z
Campaign: R24 — Free Fabric, Routing Intelligence & Efficiency Proof
Evidence lineage: `docs/evidence/r24-free-fabric/` (new; R23 evidence under `r23-efficiency-proof/` is historical and is not mutated)

## Exact starting state — verified against the repository, not the brief

| Item | Expected (R24 brief) | Actual | Match |
|---|---|---|---|
| Branch | `forger-digital-solutions-forgegreen-certified` | `forger-digital-solutions-forgegreen-certified` | YES |
| HEAD | `0c4d9eb` | `0c4d9eb01cfdb9e8edd24316d40cba3a7303fc8c` — "R23 verdict: winner null — zero-cost supply unqualified; system guarantees proven live" | YES |
| Working tree | clean | `git status --porcelain` → 0 entries; 0 staged, 0 unstaged, 0 untracked | YES |
| Push / deploy | none | none (no remote interaction this session) | YES |

Nothing was reset or discarded. Snapshot JSON: `r24-recovery-snapshot-2026-09-21T16-47-11-649Z.json` (this directory).

## R23 verdict loaded (historical, preserved)

- `R23-VERDICT.md`: protocol `codeforge-efficiency-protocol-r23` **v1.0.6**, digest `3660352…04b8` (MATCH). 80 served runs, 134 error calls, 16 verified_complete. `MODEL-SELECTION.json` → **winner: null**.
- Route verdicts: Groq `gpt-oss-20b` → §2.2(c) malformed-tool-call runs (~9.4% of calls; 3/3 verified in round 4); Groq `gpt-oss-120b` → §2.2(a)+(c); nemotron → §2.2(a) supply (30.3% call errors, `ResourceExhausted … (16/16)`, 0 malformed calls in 27 runs); Cloudflare → attestation-blocked (F6); Copilot → owner/legal-blocked; Cerebras 402 / Mistral 429 / Gemini 403 / GitHub Models 410.
- R23's coder bar (§2.2) is frozen. R24 does not re-run it and does not lower it.
- R23 suite baseline: 3,377 passed / 4 failed (pass standalone; load-sensitive) / 48 skipped; security gate 4/4 PASS.

## Live facts readable without inference (this session)

| Fact | Value | Source |
|---|---|---|
| OpenRouter key `free_model_daily_requests` | **753 / 1000 remaining** (used 247) | `/api/v1/auth/key` at 16:47Z |
| OpenRouter key `usage` / `is_free_tier` | see snapshot JSON (`usage` unchanged from R23 = deposit not consumed) | same |
| OpenRouter `:free` catalog | **21 free / 19 tool-capable** — same shape as R23's 04:45Z and 10:51Z snapshots | `/api/v1/models` (no auth) |
| Groq per-model daily buckets | not re-probed (bucket state is only visible on a completion response); R23 last observed: 20b ≈119k/200k served, 120b exhausted; continuous refill cap/24h | R23 checkpoint |
| Probe-gate ledger | `supply/probe-gates.jsonl`: 2 routes (`groq::openai/gpt-oss-20b`, `openrouter::nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free`) — bench-side only, **not consumed by routing** (the §14 gap Mission A closes) | R23 |
| Credentials present | OPENROUTER, GROQ, GEMINI, MISTRAL, CEREBRAS, OPENAI (paid — never used by R24), no CLOUDFLARE / GITHUB / POSTGRES | env (names only) |

## Current architecture truth for the R24 missions (inspected, not assumed)

**8-Bit health (Mission A).** Three disconnected health surfaces exist today:
1. `EightBitHealthTracker` (`packages/eight-bit/src/health.ts`) — per-session consecutive-failure counter + cooldown, feeds `ForgeZero.markProviderHealth`; persisted per session as `eight_bit_route_health` work items.
2. `FreeCloudService.health` (`packages/model-registry/src/free-cloud-service.ts`) — host-shared consecutive-failure map + `RouteQuotaTracker` from rate-limit headers; only `quota` feeds `capacityRoutingAdvice`.
3. `EightBitMeasuredHealthTracker` (`measured-health.ts`) — rolling aggregate scorer joined into the route ledger; **no production emitter** (confirmed gap).
Probe-gate verdicts (`scripts/r23-efficiency-bench.mjs runProbeGate`) are written to a bench JSONL and never read by any of the three. `EightBitRouter.eligibleForRole` is a binary `isInCooldown` gate; ranking penalties come only from quota headers. There is no temporal (TTL/decay) model and no role-specific penalty (a TOOL_UNRELIABLE route is gated only by the session-local reliability tracker with a 5-sample minimum).

**Supply classes (Mission B/E).** `ForgeZero.SupplyClass` = economic source (`PURE_MANAGED_FREE`, `USER_CONNECTED_FREE`, `DISTRIBUTED_USER_FREE`, `DEPOSIT_UNLOCKED_FREE`, `PROMOTIONAL_FREE`, `SPONSORED_FREE`, `OWNER_DEV_FREE`, `TRIAL_CREDIT`, `OWNER_CREDIT_RESERVE`, `PAID`). Route ledger owner kinds: `SHARED_CODEFORGE_POOL | USER_ENTITLEMENT | OWNER_DEV | SPONSORED | UNKNOWN`. `forgeAutoSupplyPlan` orders shared → sponsored → user (M14D). Copilot scaffolding: `forge-zero/src/copilot-user-connected.ts` (USER_CONNECTED_FREE, paid-crossover refusal, ineligible by default). Ollama: `user-connected-free.ts` (`DISTRIBUTED_USER_FREE`). The product-level classes the brief names (`MANAGED_FREE`, `OWNER_DEV_FREE`, `USER_CONNECTED_FREE`, `USER_CONNECTED_ENTITLEMENT`, `BYOK`, `PAID_AUTO`, `GEMS_AUTO`) are not yet a single explicit type.

**Durable admission.** `HostedAdmissionAuthority` (`cloud-gateway/src/hosted-admission.ts`) over `ICloudDatabase`: idempotent enqueue, lease claim with `maxUserConcurrent`, heartbeat, complete, cancel, recovery. No per-user share-of-pool fairness beyond concurrency.

**ForgeGreen topology (Mission C).** `classifyTaskComplexity` (`server/src/task-complexity.ts`, `r21-task-complexity-v1`) → `tiny | normal | complex`; `resolveAdaptiveTopology` maps tiny → Coder→ForgeVerify, normal → Explorer→Coder→Reviewer→ForgeVerify, complex → 2 Explorers→Planner→Coder→Reviewer. R23 dry-run pairs (`raw/dry_run/*.json`): `py-small-fix-median` and `py-bug-fix-config-merge` classified **normal** → optimized arm 8 calls / 20.1k input tokens vs control (tiny) 3 calls / 7.5k, identical verified outcome — the 2.3×/2.7× over-provisioning is the classifier sending single-file, known-location fixes to the three-agent team.

**Tool surface.** 19 built-in tools; `ToolRegistry.getForRole` gives read-only roles all 15 read-only tools (no further role specialization).

## R24 evidence directories

`recovery/` (this), `eight-bit/`, `free-fabric/`, `user-connected/`, `forgegreen/`, `role-routing/`, `pilot/`, `scale/`, `final/` — populated by their milestones; empty until then.
