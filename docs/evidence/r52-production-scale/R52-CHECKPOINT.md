# R52 Checkpoint — Verified Starting State

Verified at R52 start (not assumed from prompt).

## Repository

- Branch: `codex/r29-release-closure`
- HEAD: `bb6e4433` — `R51 source-state recertification r51-capacity-closure-v1`
- R51 commits: `d0d10c2a` (source+tests+mission harness+sim), `5ce55adb` (evidence+state
  machine+3 mission receipts+final report), `bb6e4433` (recertification), parent `1cfcfd0d` (R50 closure)
- Dirty files: **only** `docs/evidence/r34-capacity-efficiency/context-efficiency-benchmark.json`
  (intentional R34 artifact — rewritten by its own benchmark test; pre-existing before R51)

## Certification

- Surface: `r51-capacity-closure-v1`
- Source-state: `f24481030f350a69de885b9b73f8394adb50b4c23bfc47067a3754c5be2fce19`
- Prior: `r50-runtime-quality-closure-v1` / `cd2dbd78…`
- Post-certification material drift: **NONE** (recertifier verified 39-file surface clean at
  `bb6e4433`; no source edits since)

## R51 handoff claims re-verified from artifacts

- `R51-LIVE-MISSION-UNMEASURED.json`: `status=completed`, 112 unmeasured domains →
  demand-probe recovery, gate `completed`, treeEqual `true`, `$0` — present.
- `R51-LIVE-MISSION-HEALTHY.json`: `status=completed`, reviewerIndependent `true` — present.
- `R51-LIVE-MISSION-REVIEWER-SCARCITY.json`: `status=completed`, real failover onto
  surviving Groq pool — present.
- `R51-LONG-HORIZON-SIMULATION.json`: 241 decides, `ALL_INVARIANTS_HELD` — present.
- `R51-CAPACITY-STATE-MACHINE.md`: the wait/park/deny trace + defect + fix — present.
- Regression totals: forge-zero 152, model-registry 138, eight-bit 332/2sk,
  server 896/3sk + 2 baseline failures (`agent-certification-r`, `fg3-model-aware-budget`,
  failing since `d4769e8`), monorepo build clean.

## Cloudflare third-domain credential re-check (R52 §3/§Y)

Token in env: `CLOUDFLARE_API_KEY` (`cfut_jNm…` prefix), `CLOUDFLARE_ACCOUNT_ID=d200b771…`.

| Probe | Result |
|---|---|
| `POST /ai/run/@cf/meta/llama-3.1-8b-instruct` | **HTTP 200** — live inference works |
| GraphQL `aiInferenceAdaptiveGroups` (exact production query, `date_geq`) | HTTP 200 + `"not authorized for that account"` (`code: authz`) |
| GraphQL `workersInvocationsAdaptive` | HTTP 200 + `"authorization denied"` (`code: authz`) |
| `GET /accounts/{id}` (REST) | HTTP 403 `9109 Unauthorized` |
| `GET /user/tokens/verify` | token `d2c1f873…` active |

Docs: `aiInferenceAdaptiveGroups` requires **Account Analytics: Read** at account level.
The user reports the token was updated with Workers AI Read + Account Analytics Read +
entire-account scope; the env credential still cannot read the datasets — most likely the
env var is not the updated token's secret, or the grant sits on a different token/scope.
Inference works on the same token+account pair, so the pair itself is valid.

**Status: `R52_CLOUDFLARE_TELEMETRY_BLOCKED` — neuron guard correctly stays fail-closed.**
Record exact limitation; do not weaken the guard; if a corrected token lands, rerun §Y.

## R52 focus

Production-scale Free Capacity Fabric: demand-probe storm control, multi-user fairness,
provider/domain diversification, ForgeGreen long-horizon intelligence, ForgeVerify/subagent
reliability under scarcity, closure of the two historical server failures, cold-start
restart proof, and refreshed certification.
