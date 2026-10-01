# R60 implementation snapshot

**Evidence class:** code and control-plane tests. This document does not certify production capacity.

## Current path

1. The packaged desktop stores and sends a CodeForge session token to the CodeForge Cloud API. Its hosted adapter lists and dispatches the logical model `codeforge/forgeauto-free`; it no longer chooses an upstream provider/model ID.
2. The authenticated Cloud API derives account identity from the session, enqueues durable hosted work, reserves that account's UTC-period Free credits, and streams persisted inference events back to the client.
3. The gateway resolves the logical ForgeAuto Free alias through ForgeZero and its qualified Free route pool. Paid and user-connected supply are not valid Free rescue routes.
4. An optional server-configured Qwen worker fleet can register a pinned first-party logical route after a current authorization/qualification receipt and live identity/readiness checks. Worker credentials stay in server configuration.
5. SQLite and PostgreSQL share period-scoped allowance and reservation APIs. SQLite vectors pass. The existing Render Postgres resource is read-only through the connected SQL tool and is not identified as an R60 test database; it has schema history through v9 while this source tree defines migrations through v18. No live write parity was run.

## Product policy implemented

- 500,000 weighted Free credits per authenticated account per UTC calendar month, no rollover.
- 50,000 weighted credits maximum per task and one active top-level hosted task per account.
- Input 1.0, cached input 0.5, output 2.0 credits.
- Reservation before dispatch; settlement from actual usage; unused reservation release on terminal failure/cancellation/recovery; idempotent request/settlement identifiers.
- `/v1/usage` adds allowance, used, reserved, remaining, period boundaries, reset timestamp, and concurrency/task limits without accepting an account selector.
- `/v1/chat/completions` and `/v1/models` expose the authenticated logical CodeForge contract. The legacy `/v1/hosted/inference` stream remains the desktop transport and supports cancellation by disconnect.

## First-party Qwen path

The deployable vLLM worker wrapper and pinned manifest are under `deploy/inference/qwen-coder-free/`. The wrapper uses the vLLM 0.30 `qwen3_xml` parser for Qwen3-Coder. Gateway discovery, worker-scoped auth, metrics, readiness, drain state, sequence-capacity checks, and pre-generation peer failover are implemented. Admission fails closed unless an unexpired receipt confirms exact model/revision/license, commercial use, multi-user authorization, runtime profile, and coder/tool-agent qualification.

The worker is staged, not qualified or serving. This checkout has a Quadro T2000 with 4 GiB VRAM; the candidate manifest estimates 48 GiB minimum and 80 GiB preferred. Docker CLI exists, but the Docker daemon is unavailable. Cloudflare account variables are configured, but the discovered hosted Qwen3 model is paid and is not the pinned Qwen3-Coder worker; no dedicated GPU deployment credential or real qualification receipt was identified. No inference or cache benchmark was run.

## Remaining architecture gates

- A provider-neutral autoscaling decision and orchestration callback seam now emits worker-count decisions, reasons, and drain candidates. No deployment-specific orchestrator provisions or terminates workers yet.
- No four-account physical gateway concurrency, external-provider fault campaign, worker-kill campaign, or three packaged coding dogfoods were run.
- Broad control-plane load scenarios (1 through 1,000 users), real PostgreSQL parity, and deployment security tests remain outstanding.
- Cost calculations intentionally leave throughput-dependent outputs null until measured values are available.
