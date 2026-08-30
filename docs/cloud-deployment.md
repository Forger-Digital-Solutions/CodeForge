# CodeForge Cloud — Deployment-Readiness Guide

CodeForge Cloud is the optional hosted lane that lets a user run AI inference with **zero setup** — no
provider account, no provider API key, no local model. It is an *additional* execution lane: Direct /
BYOK provider paths remain fully functional whether the cloud is reachable or not.

This guide describes the deployment configuration and checks required before creating a staging
environment. It is not evidence that a remote staging environment has been deployed or certified.
It does not authorize a production launch, live Stripe, public DNS, or public announcement.

---

## 1. Architecture at a glance

```
Desktop (HostedProviderAdapter) ──HTTPS──▶ CodeForge Cloud API (apps/cloud-api)
                                              │
                    ┌─────────────────────────┼───────────────────────────────┐
                    ▼                         ▼                                ▼
             AuthService (GitHub        GatewayService + ForgeZero      StripeBillingService
             OAuth+PKCE, JWT,           (server-side model verify,      (TEST mode: subscriptions,
             refresh rotation)          Auto routing, metering)         webhooks, credit packs)
                    │                         │
                    ▼                         ▼
             CloudDatabase (PostgreSQL) CloudProviderRegistry ──▶ real provider adapters
                                        (server-owned keys:        (OpenRouter / Groq / Z.AI /
                                         discovers verified-free    Cloudflare / Gemini …)
                                         models at startup)
```

- **Hosted Free capacity is real and discovered at startup.** `CloudProviderRegistry`
  (`packages/cloud-gateway/src/provider-registry.ts`) builds an adapter for each provider whose
  server-owned key is present, lists its live catalog, and runs the ForgeZero discovery engine
  (`discoverAndVerifyFree` for $0 routes, `verifyAllowanceViaProbe` for free allowances). Only
  ForgeZero-verified free models enter the pool.
- **Owner-spend firewall.** Paid-only providers (OpenAI) are never registered as Hosted Free capacity.
  A model that flips free→paid upstream is reconciled out of the pool on the next discovery pass.
  Global daily / per-request spend limits fail closed.
- **Auto vs exact.** `modelId: "auto"` lets ForgeZero + the router pick the best eligible free model;
  an exact model id is verified and never silently substituted.

---

## 2. Environment variables

See [`.env.example`](../.env.example) for the full annotated list. Server-side essentials:

| Variable | Required (staging) | Purpose |
| --- | --- | --- |
| `CODEFORGE_CLOUD_ENV` | yes | `development` \| `staging` \| `production` (enables fail-closed checks) |
| `HOST` / `PORT` | no | bind address / port (default `127.0.0.1:3220`; use `0.0.0.0` in a container) |
| `CODEFORGE_CLOUD_DB_DRIVER` | yes | `postgres` for staging; `sqlite` is only suitable for local single-process development |
| `CODEFORGE_CLOUD_DB_PATH` | local sqlite only | persistent file path — **never `:memory:`** in staging/prod |
| `DATABASE_URL` | postgres | Postgres connection string |
| `JWT_SECRET` | yes | ≥ 32 strong chars (not the dev default) |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | yes | GitHub OAuth app |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | yes | **TEST mode only** — live keys are refused at boot |
| `OPENROUTER_API_KEY`, `GROQ_API_KEY`, … | ≥ 1 for Hosted Free | server-owned provider keys (never sent to clients) |
| `CODEFORGE_HOSTED_INFERENCE_ENABLED` / `CODEFORGE_HOSTED_FREE_ENABLED` | no | operator kill switches (default on) |
| `CODEFORGE_MAX_REQUEST_COST_USD` / `CODEFORGE_GLOBAL_DAILY_SPEND_LIMIT_USD` | no | owner-spend firewall caps |

Configuration is validated **once** at startup by `loadCloudRuntimeConfig`
(`apps/cloud-api/src/config.ts`); an invalid or unsafe production config fails the boot with a clear
error rather than degrading silently. A redacted, secret-free summary is logged on start.

---

## 3. Run it

### Local production dry-run (compiled dist)

```bash
npm ci
npm run build
NODE_ENV=production CODEFORGE_CLOUD_ENV=staging HOST=127.0.0.1 PORT=3320 \
  CODEFORGE_CLOUD_DB_DRIVER=postgres DATABASE_URL=postgresql://... \
  JWT_SECRET="<32+ char secret>" \
  GITHUB_CLIENT_ID=... GITHUB_CLIENT_SECRET=... \
  STRIPE_SECRET_KEY=sk_test_... STRIPE_WEBHOOK_SECRET=whsec_... \
  OPENROUTER_API_KEY=... GROQ_API_KEY=... \
  node apps/cloud-api/dist/index.js
```

Then verify:

```bash
curl -s localhost:3320/health/live
curl -s localhost:3320/health/ready   # shows hostedInferenceReady + per-provider capacity
curl -s localhost:3320/v1/meta
curl -s localhost:3320/v1/hosted/models
```

### Docker

```bash
docker build -f Dockerfile.cloud -t codeforge-cloud-api .
docker run --rm -p 3220:3220 --env-file .env codeforge-cloud-api
```

The image runs the **compiled dist** as a non-root user with a `/health/live` healthcheck. Secrets are
provided at run time, never baked into the image.

### Platform (Render)

[`deploy/render.yaml`](../deploy/render.yaml) is a staging blueprint, not a completed deployment.
Render currently offers free web and Postgres instances, but the database expires after 30 days and
has no backups or managed connection pooling. Confirm the current plan terms and the workspace's
included-usage policy before deployment; do not create a resource that can bill the owner.

---

## 4. GitHub OAuth (desktop loopback flow)

CodeForge Cloud is the OAuth transaction authority (PKCE `state` + `code_challenge` are minted and
consumed server-side). The desktop uses an ephemeral loopback redirect
(`http://127.0.0.1:<port>/auth/callback`). Configure the GitHub OAuth App callback as
`http://127.0.0.1/auth/callback` — GitHub permits the native-app loopback flow to use a dynamically
assigned port. Do not configure the staging API URL as the GitHub callback for this flow. Access
tokens are short-lived JWTs; refresh tokens rotate on every use and are stored by the desktop in the
OS keychain (SafeStorage) — never in the renderer.

---

## 5. PostgreSQL runtime and migrations

- **PostgreSQL is the staging runtime.** The request path is async end-to-end and `server.start()`
  completes database initialization before accepting traffic. Migrations are checksummed and seed the
  default plans; a checksum mismatch stops boot.
- **SQLite is development-only.** Prod-like configuration rejects `:memory:`, but a persistent local
  SQLite file is not a substitute for remote PostgreSQL persistence or multi-instance authority.
- The current Postgres pool has a maximum of 20 connections per Cloud instance. Keep the total pool
  maximum below the database connection ceiling, including operational headroom.

---

## 6. Health & readiness

| Endpoint | Meaning |
| --- | --- |
| `GET /health/live` | process is up (no DB/provider dependency) — use for platform liveness |
| `GET /health/ready` | database connectivity, `hostedInferenceReady`, `availableFreeCount`, per-provider `providerCapacity`, kill-switch state |
| `GET /v1/meta` | API version, server version, feature flags |
| `GET /v1/hosted/models` | live catalog derived from discovered capacity (`isEligibleFree`, `accessClass`, provider) |

`/health/ready` truthfully reports `hostedInferenceReady: false` when no eligible free capacity exists;
it never claims capacity it does not have.

---

## 7. Zero-secret logging

Logs never contain prompt content, provider keys, JWT secrets, or refresh tokens. Errors are sanitized
(`sk_*`, `ghp_*`, `cfr_*` patterns redacted). The startup summary is redacted. Keep `CODEFORGE_LOG_LEVEL`
at `info` in staging.

The API responds with `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, and
`Referrer-Policy: no-referrer`. CORS is origin-allowlisted and uses bearer tokens rather than cookies;
unauthorized browser origins receive no CORS grant. SSE responses set `X-Accel-Buffering: no` and
`Cache-Control: no-transform`, but a deployed platform proxy must still be tested for progressive
streaming and idle timeout behavior.

---

## 8. Product lanes

| Lane | Status |
| --- | --- |
| **Hosted Free** | real, server-owned $0 capacity via ForgeZero-verified free models |
| **Direct / BYOK** | independent; unaffected by cloud availability |
| **Hosted Premium** | future; not deployed |
| **GEMS** | first-party premium models — **Coming Soon**, offline until a real backend exists |

See the [operator runbook](./cloud-operator-runbook.md) for kill switches, credential rotation, and
incident procedures.
