# R62 Free Capacity Fabric production closure

Status: **PARTIAL**. The mandatory two-live-domain gate did not pass. This report preserves the R61 result without relabeling a paid-tier OpenRouter probe or synthetic failover as Packaged Free evidence.

## Repository state

- Starting HEAD: `196ff20a8439db3f453ac3a2f35720edd882f114` on `codex/r29-release-closure`.
- Implementation commit: `9a58d54c` (`fix: fail closed on remote session and sponsor freshness`).
- Pre-existing modified files and unrelated untracked R57–R60, screenshots, and GPU/Qwen work were not staged, reset, or edited by R62.

## Forensic closure matrix

| Area | State | Evidence |
| --- | --- | --- |
| Kilo public-IP Free route | CLOSED in R61, not rerun | `kilo-autonomous-live.json`, `kilo-live-qualification.json` |
| Quota-domain admission and domain-scoped health | IMPLEMENTED, only one live domain | `packages/forge-zero/src/capacity-policy.ts`, `packages/eight-bit/src/free-fabric.ts` |
| OpenRouter user PKCE | IMPLEMENTED, no Free-account grant | `apps/desktop/src/openrouter-oauth-flow.ts` |
| Second independent Packaged Free domain | BLOCKED BY EXTERNAL AUTHORITY | `R62-LIVE-DOMAIN-B.json` |
| Hosted remote client-direct execution | IMPLEMENTED BUT NOT LIVE-PROVEN | `R62-REMOTE-TRANSPORT.json` |
| Sponsor operator pipeline | IMPLEMENTED BUT NOT LIVE-PROVEN | `R62-SPONSOR-PIPELINE.json` |
| Legacy production cutover | OPEN | `R62-LEGACY-CUTOVER.json` |
| Two-domain coding, failover, multi-user concurrency | OPEN | `R62-CROSS-DOMAIN-FAILOVER.json`, `R62-MULTI-USER-CONCURRENCY.json` |

## Implementation

Remote direct assignments now require a MAC-bound, single-use acknowledgement before any stream frame or feedback is accepted. Duplicate sessions and empty assignment scopes are refused. Revoking a session invalidates its outstanding assignments; expired assignments cannot acknowledge, stream, or settle. This closes a protocol gap but does not create hosted delivery or session bootstrap.

The sponsor manifest feed now stops exposing an offer after six hours without successful verification or after the trusted signing key expires. HTTP 304 refreshes the freshness window only after the cached signature and signer revalidate. Signed offers remain inert until independent qualification. No operator deployment or grant was available.

A source-certificate guard recomputes file hashes from disk and fails on drift. The certificate identifies the implementation HEAD and hashes the authoritative source and evidence files. Its canary passes.

## Free quota domains and live coding

Domain A is the inherited R61 Kilo Gateway `PACKAGED_FREE_DIRECT` public-IP domain, owned by the installed user's egress IP; NAT users may share it. R61's `kilo-auto/free` coding run inspected a fixture, called tools, edited `math.ts`, passed independent review, passed 3 tests through ForgeVerify, passed `evaluateCompletion`, and integrated the verified tree. R62 did not rerun that task. Upstream reported cost for that run is **UNKNOWN** in this report; no zero-cost number is fabricated.

Domain B is **not admitted**. The available OpenRouter environment credential was reported paid tier by R61, and an R62 read of the current-key endpoint failed authentication. Groq and Gemini environment credentials have no verified Free entitlement/account-tier provenance. R62 made **zero inference calls** and therefore produced no Domain B coding, Reviewer, ForgeVerify, or completion receipt. See `R62-PROVIDER-CANDIDATES.json`.

## Failover and multi-user gates

The inherited controlled Kilo failover used a synthetic domain. No live A→B or B→A failover was run, because only one live domain is admitted. Scoped tests show Alice's public-IP 429 does not hard-exclude Bob's separate domain in the route-health authority; they do not prove concurrent live users, fair sponsor scheduling, or isolation of two real delegated credentials.

## Remote transport, sponsor pipeline, and legacy cutover

Remote transport: **PARTIAL**. Authenticated protocol primitives and negative tests pass. No hosted session handshake, liveness, result upload, runtime dispatch/cancellation integration, or deployed client exists.

Sponsor pipeline: **PARTIAL**. Manifest verification, lifecycle gates, and new freshness checks exist. No enrolled live operator, durable signing-key rotation, or independently qualified funded offer exists.

Legacy cutover: **OPEN**. `migrateLegacyFreeRoute` is fail-closed but has no production caller. `AgentRuntime` retains a deterministic provider-catalog fallback when a fabric fleet is absent. No claim is made that every production Free path passes the new domain gate.

## Validation

- Baseline full workspace build: PASS.
- Affected package TypeScript builds after changes: PASS (`packages/forge-zero`, `packages/server`).
- Focused tests after changes: 9 passed in 2 files, 0 failed, 0 skipped.
- Repository-wide bounded run: **FAIL**, 524 files, 4,381 tests: 4,312 passed, 17 failed, 50 skipped, and 2 pending after a worker heap failure. Four shards used bounded workers; the sum of shard durations was 4,774.5 seconds. These are not a single sequential wall-clock duration. See `R62-REPOSITORY-TESTS.json` for shard and failure detail.
- An isolated retry passed 14 assertions, including four broad-run timeout cases. Two Direct/BYOK outage cases remained pending after a repeat 4 GB worker heap exhaustion. Retry results are supplemental and are not added to the repository-wide counts.
- Four credit-related failures were independently reproduced on an unchanged earlier base in R61. Thirteen R62 failures have no unchanged-HEAD reproduction, so no baseline exemption or repository-wide green claim is made.
- R62 live inference calls: 0.

## Remaining blockers

1. A real second user Free account must authorize the existing provider-supported PKCE flow, or a provider must issue a documented zero-marginal-cost grant. The current paid-tier environment OpenRouter credential cannot serve as proof.
2. The authorized account/offer must pass tier, billing, terms, privacy, quota, role qualification and autonomous coding verification.
3. Hosted remote execution, sponsor operations, production legacy cutover, two-domain failover and live multi-user concurrency remain unfinished.

## Evidence

All evidence is under `docs/evidence/free-capacity-fabric/`. R62 files: `R62-LIVE-DOMAIN-A.json`, `R62-LIVE-DOMAIN-B.json`, `R62-CROSS-DOMAIN-FAILOVER.json`, `R62-MULTI-USER-CONCURRENCY.json`, `R62-REMOTE-TRANSPORT.json`, `R62-SPONSOR-PIPELINE.json`, `R62-LEGACY-CUTOVER.json`, `R62-PROVIDER-CANDIDATES.json`, `R62-REPOSITORY-TESTS.json`, and `source-certification.json`.
