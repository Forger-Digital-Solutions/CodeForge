# CodeForge Cloud — Operator Runbook

Concise operational procedures for the staging cloud API. All controls are **environment / config
based** — there is no unauthenticated admin HTTP surface. Restart the service after changing env.

> Secrets never appear in examples below. Never paste real keys into logs, tickets, or chat.

---

## Kill switches (owner-spend firewall)

| Goal | Env | Effect |
| --- | --- | --- |
| Disable **all** hosted inference | `CODEFORGE_HOSTED_INFERENCE_ENABLED=false` | every hosted request is refused before any provider call |
| Disable **Hosted Free** only | `CODEFORGE_HOSTED_FREE_ENABLED=false` | Free-plan hosted requests refused; paid lanes (future) unaffected |
| Cap per-request cost | `CODEFORGE_MAX_REQUEST_COST_USD=<usd>` | requests whose estimate exceeds the cap are refused |
| Cap global daily spend | `CODEFORGE_GLOBAL_DAILY_SPEND_LIMIT_USD=<usd>` | once daily provider spend ≥ cap, hosted inference fails closed |

Direct / BYOK on the desktop is **never** affected by these switches.

### Disable a single provider
Remove (or blank) that provider's key env var and restart. The provider is simply not attempted; its
models never enter the pool. Example: unset `GROQ_API_KEY` to drop Groq capacity. Remaining providers
continue to serve. (`GET /health/ready` → `providerCapacity` confirms which providers are active.)

---

## Inspect capacity & health

```bash
curl -s $BASE/health/ready | jq '{ready:.hostedInferenceReady, free:.availableFreeCount, providers:.providerCapacity}'
curl -s $BASE/v1/hosted/models | jq 'map(select(.isEligibleFree)) | length'
```

Per-provider `status` values: `healthy`, `no_free_models`, `auth_required`, `rate_limited`, `offline`,
`misconfigured`, `skipped_paid_only`. A provider marked `auth_required` or `rate_limited` is excluded
from routing automatically and re-evaluated on the next discovery refresh.

---

## Rotate a provider credential

1. Issue a new key in the provider dashboard.
2. Update the env var (`OPENROUTER_API_KEY`, `GROQ_API_KEY`, …) in the platform secret store.
3. Restart the service. Startup discovery re-verifies the provider; `providerCapacity` should return
   `healthy`. Revoke the old key afterward.

No client action is needed — provider keys never leave the server.

## Rotate the JWT secret

Rotating `JWT_SECRET` invalidates all existing **access** tokens immediately. Desktops recover
transparently: the next hosted request 401s, the main process uses its (still-valid) refresh token to
mint a fresh access token, and the request retries once. Refresh tokens are unaffected (they are hashed
in the DB, not signed with `JWT_SECRET`). Rotate during low traffic; expect a brief burst of refreshes.

---

## Database

- **Migrations** run automatically at boot (`init()` before the server listens; checksummed — a
  mismatch aborts start rather than corrupting data).
- **Driver**: SQLite is runtime-wired; keep `CODEFORGE_CLOUD_DB_PATH` on a **persistent** volume.
  Postgres is schema-ready but not yet runtime-wired (see deployment guide §5) — do not switch staging
  to Postgres yet.
- **Backup (staging)**: snapshot the SQLite file / persistent volume on your platform's schedule. The
  file is the single source of truth for users, sessions, subscriptions, credit ledger, reservations,
  usage periods, and webhook history.
- **Restart recovery**: on boot the server reclaims stale credit reservations left by a previous
  process that died mid-inference (older than 10 min, still `reserved`) — credits are refunded so a
  balance is never locked forever. In-memory execution leases vanish on restart, so account concurrency
  is not blocked after a crash. Webhook processing is idempotent (deduped by Stripe event id), so a
  redelivered event has a one-time economic effect.

---

## Incident: provider 429 storm / rate-limit

Symptom: a provider's `status` flips to `rate_limited`; Auto stops selecting it. This is expected and
safe — ForgeZero treats a rate limit as *capacity temporarily unavailable*, **never** as permission to
use paid capacity. If ALL free providers are exhausted, hosted requests return a clear
"Hosted Free temporarily unavailable" state; Direct/BYOK still works. Action: usually none — capacity
recovers automatically. To add headroom, configure an additional free provider key and restart.

## Incident: Stripe TEST webhook not processing

1. Confirm `STRIPE_WEBHOOK_SECRET` matches the endpoint's signing secret (test mode).
2. A bad signature returns `400 Invalid Stripe webhook signature` — re-check the secret.
3. Processing is idempotent: replaying an event is safe (deduped by event id). Inspect the
   `billing_webhook_events` table for `status`.

## Incident: suspected owner spend

1. Set `CODEFORGE_GLOBAL_DAILY_SPEND_LIMIT_USD` to a tiny value (e.g. `0.01`) and restart to halt
   hosted inference immediately.
2. Confirm no paid provider (OpenAI) key is being treated as free capacity — it should show
   `skipped_paid_only` in `providerCapacity`.
3. Review `usage_events` for `providerCostUsd`. Hosted Free routes should be `$0`.

---

## Release-readiness reminder

Staging-ready ≠ production-released. Do **not** enable live Stripe, configure production billing, push
public DNS, or announce a public service without separate authorization.
