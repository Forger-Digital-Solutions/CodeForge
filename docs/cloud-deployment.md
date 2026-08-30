# CodeForge Cloud — Deployment Guide (Staging)

CodeForge Cloud is the optional hosted lane that lets a user run AI inference with **zero setup** — no
provider account, no provider API key, no local model. It is an *additional* execution lane: Direct /
BYOK provider paths remain fully functional whether the cloud is reachable or not.

This guide covers running the cloud API (`apps/cloud-api`) for **staging**. It does not authorize a
production launch, live Stripe, public DNS, or public announcement.

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
             CloudDatabase (SQLite)     CloudProviderRegistry ──▶ real provider adapters
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
| `CODEFORGE_CLOUD_DB_DRIVER` | yes | `sqlite` (runnable) \| `postgres` (schema-ready, see §5) |
| `CODEFORGE_CLOUD_DB_PATH` | sqlite | persistent file path — **never `:memory:`** in staging/prod |
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
  CODEFORGE_CLOUD_DB_DRIVER=sqlite CODEFORGE_CLOUD_DB_PATH=./data/codeforge.db \
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

[`deploy/render.yaml`](../deploy/render.yaml) is a ready blueprint (free web service + free Postgres,
no credit card). Note the free-tier cold-start caveat and the Postgres status in §5.

---

## 4. GitHub OAuth (desktop loopback flow)

CodeForge Cloud is the OAuth transaction authority (PKCE `state` + `code_challenge` are minted and
consumed server-side). The desktop uses an ephemeral loopback redirect
(`http://127.0.0.1:<port>/auth/callback`). Configure the GitHub OAuth app's callback to the cloud's
public callback and keep redirect binding strict. Access tokens are short-lived JWTs; refresh tokens
rotate on every use and are stored by the desktop in the OS keychain (SafeStorage) — never in the
renderer.

---

## 5. Database status (important)

- **SQLite (`node:sqlite`) is the runtime-wired driver.** Use a **persistent** `CODEFORGE_CLOUD_DB_PATH`
  in staging/production (a persistent volume/disk). `:memory:` is refused for prod-like envs.
- **PostgreSQL is schema-ready but not yet runtime-wired.** The migration layer is real and verified
  (checksummed migrations, `init()` runs them before serving). However, the request-handling services
  use the **synchronous** database interface, and the Postgres driver implements those methods as
  async-only (the sync methods throw). A Postgres-backed server therefore initializes its schema and
  then fails on the first request. Selecting `CODEFORGE_CLOUD_DB_DRIVER=postgres` prints a loud startup
  warning. **Do not** run staging on Postgres until the request path is converted to async and tested
  against a real Postgres instance (set `CODEFORGE_TEST_POSTGRES_URL` to run the gated integration
  test in `packages/cloud-db/test/postgres.test.ts`).

---

## 6. Health & readiness

| Endpoint | Meaning |
| --- | --- |
| `GET /health/live` | process is up (no DB/provider dependency) — use for platform liveness |
| `GET /health/ready` | `hostedInferenceReady`, `availableFreeCount`, per-provider `providerCapacity`, kill-switch state |
| `GET /v1/meta` | API version, server version, feature flags |
| `GET /v1/hosted/models` | live catalog derived from discovered capacity (`isEligibleFree`, `accessClass`, provider) |

`/health/ready` truthfully reports `hostedInferenceReady: false` when no eligible free capacity exists;
it never claims capacity it does not have.

---

## 7. Zero-secret logging

Logs never contain prompt content, provider keys, JWT secrets, or refresh tokens. Errors are sanitized
(`sk_*`, `ghp_*`, `cfr_*` patterns redacted). The startup summary is redacted. Keep `CODEFORGE_LOG_LEVEL`
at `info` in staging.

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
