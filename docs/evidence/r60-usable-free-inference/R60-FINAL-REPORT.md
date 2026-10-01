CODEFORGE_R60_INCOMPLETE

# CodeForge R60 execution report

## 1. Repository base

Continuation began at `6b8fbada0e5367301974bc319f76f7281ce84dd0` on branch `codex/r29-release-closure`. The pre-existing R57/R59 dirty and untracked work was preserved.

## 2. R60 implementation commits

- `f92b99f` — hosted Free accounting, logical gateway, first-party worker/fleet, autoscaling seam, and focused tests.
- `a88011ca` — align the desktop allowance assertion with the UTC calendar-month contract.
- `e68c3a5c` — assert authenticated usage access and the published Free task limits.

The R60 evidence and source-state certificate are committed with this report. The unrelated R57/R59 changes remain outside the R60 commits.

## 3. What was implemented

- Per-account, period-scoped Free entitlement and reservations in the shared SQLite/PostgreSQL database APIs: 500,000 weighted credits per UTC calendar month, no rollover; 50,000 per task; one active top-level hosted task per account.
- Reservation before inference admission, actual-use settlement, release of unused credits on cancellation/failure/recovery, and idempotent request/settlement handling.
- Additive authenticated `/v1/usage` Free fields; identity comes from the CodeForge session.
- Authenticated OpenAI-compatible `/v1/models` and `/v1/chat/completions` logical interface; packaged hosted model discovery now returns only `codeforge/forgeauto-free`, and the desktop hides that implementation sentinel beside its ForgeAuto selector.
- Incrementally persisted hosted event streaming, durable queue concurrency, cancellation propagation, and worker capacity snapshots.
- First-party Qwen fleet admission protocol, server-side per-worker credentials, readiness/metrics/model identity checks, qualification gating, draining exclusion, and pre-generation peer failover.
- Deployable vLLM worker wrapper and pinned candidate manifest for Qwen3-Coder 30B-A3B FP8.
- Provider-neutral autoscaling decision logic and injected orchestration callback seam; it reports scale-out/in decisions, reasons, queue and serving metrics, warmup state, and idle worker drain candidates.
- Evidence directory distinguishes code/control-plane tests from physical inference and packaged application proof.

## 4. Allowance/accounting evidence

Local SQLite tests pass for allowance creation, UTC month identity, no rollover, exact-boundary admission, task cap, reservation race protection, settlement/replay, failure/cancellation release, stale reservation recovery, account isolation, usage reporting, and historical retention. The latest focused run passed 95 tests in 9 files. See [usage-accounting-tests.json](usage-accounting-tests.json) and [utc-reset-tests.json](utc-reset-tests.json).

**PostgreSQL live parity was not verified.** A live Render Postgres resource exists, but no dedicated writable test URL is configured. The connector exposes read-only SQL and the existing resource is in the same workspace/region as an active CodeForge cloud service. Its cloud migration history ends at v9 while this source tree defines migrations through v18. No migration or write test was run against it. See [postgres-parity.json](postgres-parity.json).

## 5. Gateway evidence

The latest Cloud API/provider/desktop-catalog/gateway/fleet/autoscaling regression run passed 106 tests in 10 files. A prior focused desktop/provider/gateway/fleet/autoscaling run passed 75 tests in 6 files. The accounting/auth/admission suite passed 95 tests in 9 files. `tsc -b --force`, `node --check scripts/r60-cost-model.mjs`, and `git diff --check` pass. These are local tests; they do not establish deployed service behavior or real streaming latency. See [gateway-tests.json](gateway-tests.json).

## 6. Qwen/worker evidence

Pinned candidate: `Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8`, revision `dcaee4d4dfc5ee71ad501f01f530e5652438fde0`, Apache-2.0, vLLM 0.30.0. Exact license/provenance links and serving assumptions are in [source-certification.json](source-certification.json) and [model-manifest.json](model-manifest.json).

The worker is staged and **not qualified or serving**. The available Quadro T2000 has 4 GiB VRAM versus a 48 GiB planning minimum. The Docker CLI is present but its daemon pipe is unavailable. Cloudflare account credentials exist, but no authorized first-party GPU worker or custom-model deployment capacity was identified; the Cloudflare-hosted Qwen3 model is a different paid model and is not used. There is no real Qwen response, throughput, KV/prefix cache result, or physical worker benchmark. Static checks pass, including Python syntax and the corrected vLLM `qwen3_xml` tool parser. See [worker-tests.json](worker-tests.json), [worker-deployment.json](worker-deployment.json), and [real-inference-results.json](real-inference-results.json).

## 7. Multi-user evidence

A local durable-queue test proves two distinct test accounts can execute concurrently at configured capacity two. It is a control-plane test using a mock executor. Zero physical sessions were served. The required four simultaneous independent real sessions are not demonstrated. See [concurrency-results.json](concurrency-results.json).

## 8. External federation evidence

Existing external provider discovery and health/routing work remains in place; discovered zero-cost candidates are classified separately from the new `CODEFORGE_OWNED` route. No live outage/failover campaign against Groq, OpenRouter, or Cloudflare was performed in this round. Routing is only partially verified; see [routing-tests.json](routing-tests.json).

## 9. Fault-recovery evidence

Mocked first-party tests cover worker identity mismatch, draining exclusion, capacity saturation, and a pre-generation failed worker yielding to a healthy peer. Local durable queue tests cover provider error terminalization and cancellation. No worker was killed during real active inference and no live external provider fault injection was run. See [fault-injection-results.json](fault-injection-results.json).

## 10. Packaged dogfood results

No qualifying packaged ForgeAuto Free task was run. Dogfood runs 1, 2, and 3 are recorded as `NOT_RUN`, with no inferred success, charge, edits, tests, review, or receipts. See [dogfood-run-1.json](dogfood-run-1.json), [dogfood-run-2.json](dogfood-run-2.json), and [dogfood-run-3.json](dogfood-run-3.json).

## 11. ForgeVerify results

No R60 packaged dogfood reached ForgeVerify. Existing completion-gate and verification safeguards were preserved. The required end-to-end verification gate remains open.

## 12. Actual end-user cost

No R60 dogfood requests occurred, so an actual end-user charge for a coding task is **not established**. The implemented Free allowance is a zero-dollar product entitlement with weighted usage accounting; real first-party inference and its $0 end-user cost have not been demonstrated.

## 13. Actual CodeForge infrastructure cost

No worker was deployed, so actual R60 infrastructure cost is unknown. The calculator and [cost-model.json](cost-model.json) contain only a public A100 hourly price reference and explicitly leave throughput-dependent economics null. The one-worker monthly arithmetic is a price reference, not a deployment estimate.

## 14. Remaining risks and closure matrix

| Gate | State | Evidence / remaining work |
|---|---|---|
| Per-account Free entitlement | PASS in SQLite tests | PostgreSQL live integration still needed |
| UTC accounting parity | PARTIAL | SQLite tests pass; PostgreSQL not live-tested |
| Reservation safety | PASS in SQLite tests | Distributed PostgreSQL races unverified |
| Usage API | PASS in local tests | No deployed account-session test |
| Authenticated logical gateway | PARTIAL | Local endpoint tests pass; deployed route not exercised |
| First-party Qwen | NOT PASS | Worker not loaded; no GPU capacity |
| Packaged ForgeAuto Free | PARTIAL | Client identity changed; no real packaged task |
| 8-Bit first-party qualification | NOT PASS | Receipt schema/gate exists; candidate has no qualification evidence |
| External federation | PARTIAL | Existing paths retained; live peer fault test absent |
| No paid/BYOK contamination | PARTIAL | Existing firewall gates preserved; no deployment fault campaign |
| Fairness | PARTIAL | Two-account control test only; broad weighted fairness load absent |
| Autoscaling seam | PARTIAL | Decision/callback API implemented; no provider orchestrator or action credentials |
| Four-user real concurrency | NOT PASS | Zero real sessions served |
| Failure recovery | PARTIAL | Mock pre-generation failover only |
| ForgeVerify | NOT PASS | No packaged task completed |
| Three packaged dogfoods | NOT PASS | 0/3 |
| $0 end-user cost proof | NOT PASS | No dogfood inference to inspect |
| Truthful evidence | PASS | Simulation and physical inference are explicitly separated |

Additional non-GPU work remains: gateway-scale harness at 1–1,000 accounts, production abuse/admin controls review, live PostgreSQL parity, deployment-specific autoscaling actions, broad compatibility/security campaigns, and packaged dogfood preparation.

## 15. Exact remaining blockers

1. **Physical serving:** no authorized first-party GPU capacity was identified in the configured CodeForge infrastructure. The Render workspace has CPU/RAM service plans and no GPU worker; Cloudflare Workers AI offers a paid hosted Qwen3 model, not this pinned Qwen3-Coder worker; no RunPod deployment credential is configured. The current local Docker daemon is unavailable. See [worker-deployment.json](worker-deployment.json).
2. **Live PostgreSQL:** no writable dedicated R60 test endpoint is configured. The existing Render database is not marked as a test database, has only read-only connector access, and is behind this source tree's schema migrations. A dedicated `CODEFORGE_TEST_POSTGRES_URL` or equivalent isolated test database is required.
3. **Physical qualification and product proof:** the pinned model still needs a real qualification receipt, CodeForge gateway inference, four simultaneous independent sessions, real batching/cache and fault measurements, and three packaged ForgeAuto Free coding tasks that pass ForgeVerify with $0 user charge.
4. **Broad regression:** the complete repository test run was interrupted after multiple wall-clock-sensitive failures. The R60 accounting and gateway suites pass; one reported orchestrator timeout passes in isolation. Remaining broad-run failures are not attributed to R60 and are recorded in [broad-regression-results.json](broad-regression-results.json).

R60 is **not closed**. This report does not use the GPU-blocked terminal state because non-GPU implementation and verification gates also remain.

## 16. Continuation execution — 2026-10-01

The R60 code changes were committed separately from unrelated R57/R59 work. Verification passed: SQLite-backed accounting/auth/admission (95 tests across 9 files); logical gateway, fleet, autoscaling, and desktop catalog (106 tests across 10 files); all 8-Bit and workflow/ForgeVerify suites (576 tests passed, 3 skipped across 58 files); the desktop package suite (348 tests across 40 files); and selected ForgeAuto, failover, and completion-gate server paths (58 tests across 8 files). A focused authenticated usage API rerun passed all 8 tests after adding assertions for unauthenticated 401 behavior and the one-active-task/50,000-credit limits. TypeScript project build, Python AST parsing, manifest parsing, parser consistency, and staged diff checks passed.

The complete repository Vitest run was interrupted after wall-clock-sensitive failures; one reported orchestrator timeout passed in isolation. The other observed full-run failures remain unisolated and are not attributed to R60. The PostgreSQL harness could not start local WSL Postgres; no dedicated writable `CODEFORGE_TEST_POSTGRES_URL` was configured. The available Render SQL interface was read-only, and its CodeForge cloud resource was not a dedicated test database, so no migration/write was attempted.

The pinned model provenance and serving configuration were checked against official sources. vLLM 0.30 documentation requires `qwen3_xml` for Qwen3-Coder, and the worker now uses that parser. This is a corrected configuration check, not worker qualification. No authorized first-party GPU capacity was identified, the local 4-GiB accelerator is below the 48-GiB planning minimum, and Docker cannot reach a daemon. No real inference, four-user physical sessions, worker qualification, live autoscaling action, packaged coding dogfood, ForgeVerify receipt, or actual end-user charge occurred.

The R60 source-state certificate binds the committed R60 code and evidence files, excluding only its own certificate file to avoid a self-referential hash. The existing repository ForgeGreen certificate protects 96 files, with no overlap with the R60 changed files, and was left unchanged. R60 remains incomplete and is not reported as closed.

## 17. Current closure matrix

| Gate | State | Current evidence |
|---|---|---|
| A — SQLite/PostgreSQL accounting parity | PARTIAL | SQLite vectors pass; writable PG parity not run. |
| B — Authentication and usage API | PASS | Local HTTP integration proves unauthenticated rejection, auth-derived identity, allowance/used/reserved/remaining/reset fields, and published limits; a deployment session was not exercised. |
| C — Packaged logical product path | PARTIAL | Logical selector/catalog tests pass; packaged task not run. |
| D — Real pinned Qwen worker | NOT PASS | Image/config staged; no worker deployed or model loaded. |
| E — Real CodeForge gateway inference | NOT PASS | No real response through the authenticated logical gateway. |
| F — Real worker qualification | NOT PASS | No physical qualification receipt. |
| G — 8-Bit participation | NOT PASS | Mocked qualification/routing tests only. |
| H — External free federation | PARTIAL | Existing routes retained; no live provider-failure campaign. |
| I — No paid/BYOK contamination | PARTIAL | Local firewall tests pass; no physical end-to-end rescue/failover campaign. |
| J — Fair multi-user serving | PARTIAL | Two-account control-plane test only. |
| K — Four real concurrent sessions | NOT PASS | Zero physical sessions. |
| L — Real batching | NOT MEASURED | Runtime configuration only. |
| M — Prefix/KV cache | PARTIAL | Setting enabled; hit rate and benefit unmeasured. |
| N — Worker failure recovery | PARTIAL | Mock peer failover only. |
| O — Provider failure recovery | PARTIAL | No live provider outage/failover test. |
| P — Deployment autoscaling action | PARTIAL | Decision seam passes local tests; no provider action occurred. |
| Q — Three packaged coding completions | NOT PASS | 0/3. |
| R — ForgeVerify | NOT PASS | No qualifying dogfood input. |
| S — $0 end-user charge evidence | NOT PROVEN | No real packaged task was charged or settled. |
| T — Source certification | PASS | R60 code/evidence source-state digest is recorded and reproducible; physical receipts remain separate open gates. |
| U — Repository hygiene | PASS | R60 implementation and evidence/certificate are committed separately; unrelated R57/R59 dirty and untracked work is preserved. |
