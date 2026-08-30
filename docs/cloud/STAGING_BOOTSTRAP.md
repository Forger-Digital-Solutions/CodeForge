# CodeForge Cloud — Staging Bootstrap

The minimum human work required to launch and certify CodeForge Cloud staging. Everything after step 3
is automated by the repository.

**Cost policy:** every resource below must be a genuinely free tier. Do not enter payment details, do
not upgrade a plan, and do not enable live Stripe. The Cloud refuses live Stripe keys at boot.

---

## The OAuth callback architecture (read this first)

CodeForge has **three** distinct callbacks. Registering the wrong one is the single most common way a
staging launch fails, so they are named apart everywhere in the code:

| # | Concept | Value | Registered with GitHub? |
|---|---------|-------|-------------------------|
| A | **GitHub authorization callback** | `https://<CODEFORGE_PUBLIC_URL>/v1/auth/github/callback` | **Yes — this exact URL** |
| B | **Cloud OAuth callback endpoint** | `GET /v1/auth/github/callback` on the Cloud | Same as A |
| C | **Desktop loopback callback** | `http://127.0.0.1:<ephemeral port>/auth/callback` | **No — never** |

Only **A** goes in the GitHub OAuth App. It is one fixed HTTPS URL.

The desktop loopback (**C**) is deliberately *not* registered, and is never sent to GitHub. GitHub
matches a registered callback by scheme, host **and port** — and the desktop binds a fresh ephemeral
port for every login attempt, so it could never be registered in advance. Instead:

```
Desktop (generates its own PKCE pair, opens 127.0.0.1:<port>/auth/callback)
   │  POST /v1/auth/start { redirectUri, codeChallenge }
   ▼
CodeForge Cloud  ── generates a SEPARATE, server-owned GitHub PKCE pair ──┐
   │  returns the GitHub authorize URL                                     │
   ▼                                                                       │
GitHub  ── user approves ──────────────────────────────────────────────────┘
   │  302 to  https://<public url>/v1/auth/github/callback?code&state
   ▼
CodeForge Cloud
   • consumes the OAuth transaction (single-use)
   • exchanges the code using the SERVER-HELD client secret
   • mints a single-use, PKCE-bound desktop authorization code (120s)
   │  302 to  http://127.0.0.1:<port>/auth/callback?code=<one-time code>
   ▼
Desktop
   │  POST /v1/auth/exchange { code, codeVerifier }
   ▼
CodeForge Cloud → session tokens
```

Consequences worth stating explicitly:

- The **GitHub client secret exists only on the server**. The desktop never receives it.
- The server-owned **GitHub PKCE verifier never leaves the server**.
- **No reusable credential is ever placed in a URL.** The browser only ever carries a single-use,
  120-second, PKCE-bound code that is worthless without the verifier held by the desktop process.
- The redirect destination comes from the server-side transaction record, never from callback request
  input, so the callback endpoint cannot be turned into an open redirector.

---

## 1. Obtain a $0 HTTPS container runtime

CodeForge Cloud ships as a container. The deployment contract is deliberately minimal:

> **A Docker image + environment variables + a PostgreSQL `DATABASE_URL`.**

Any platform that can run a container, terminate TLS, and stream responses without buffering will
work. What the platform must provide:

- HTTPS with a valid certificate on a stable hostname
- HTTP/1.1 response streaming **without buffering** (Server-Sent Events must arrive progressively)
- an inbound port from `PORT`, with the process bound to `0.0.0.0`
- persistent enough uptime for a login to complete

[`render.yaml`](../../render.yaml) is the canonical Render Blueprint. It creates only the free Web
Service; supply a durable Neon or Supabase connection string as `DATABASE_URL` during the initial
Blueprint prompt. On Render, the server uses the actual runtime-assigned `RENDER_EXTERNAL_URL` for
its OAuth origin, so no hostname is predicted during Blueprint creation. Confirm Render's current
free-tier terms yourself before applying it.

## 2. Obtain persistent PostgreSQL

PostgreSQL 13 or newer, reachable over TLS. SQLite is not a cloud deployment target — the Cloud
refuses to boot in staging/production on an ephemeral database.

You need the connection string in the form:

```
postgresql://USER:PASSWORD@HOST:5432/DATABASE
```

Do not append `sslmode=disable`, `allow`, `prefer`, or `no-verify`; the Cloud refuses all four in
staging and production.

## 3. Configure environment secrets

Set these in your platform's secret store. Never commit them, and never bake them into the image.

**Required**

| Variable | Notes |
|----------|-------|
| `NODE_ENV` | `production` |
| `CODEFORGE_CLOUD_ENV` | `staging` |
| `CODEFORGE_PUBLIC_URL` | the deployment's public HTTPS origin, e.g. `https://cloud.example.com`; Render uses its runtime `RENDER_EXTERNAL_URL` when this is unset |
| `HOST` | `0.0.0.0` |
| `CODEFORGE_TRUST_PROXY` | `true` behind a platform proxy, `false` otherwise — must be explicit |
| `CODEFORGE_CLOUD_DB_DRIVER` | `postgres` |
| `DATABASE_URL` | from step 2 — **secret** |
| `CODEFORGE_CLOUD_DB_SSL` | `true` |
| `JWT_SECRET` | 32+ random characters — **secret**. Rotating it signs everyone out |
| `GITHUB_CLIENT_ID` | from step 5 |
| `GITHUB_CLIENT_SECRET` | from step 5 — **secret** |
| `STRIPE_SECRET_KEY` | optional — **`sk_test_…` only**, and only when Stripe test billing is deliberately enabled — **secret** |
| `STRIPE_WEBHOOK_SECRET` | optional companion to `STRIPE_SECRET_KEY` — **secret** |

**Strongly recommended** — without at least one, Hosted Free reports unavailable:

| Variable | Notes |
|----------|-------|
| `OPENROUTER_API_KEY` | server-owned key; supplies verified `$0` (`:free`) capacity — **secret** |
| `GROQ_API_KEY` | server-owned key; supplies free-allowance capacity — **secret** |

The complete contract, including optional operator tuning, is declared once in
[`apps/cloud-api/src/staging-contract.ts`](../../apps/cloud-api/src/staging-contract.ts). The preflight,
the launch checklist, and this document are all checked against it.

## 4. Deploy

```bash
docker build -f Dockerfile.cloud -t codeforge-cloud-api .
```

Push that image to your platform and run it with the environment from step 3. The container:

- runs as a non-root user
- serves the compiled `dist` (never TypeScript through dev tooling)
- exposes `/health/live` (no dependencies) and `/health/ready` (database + capacity)
- **fails to boot** on incomplete or unsafe configuration rather than degrading silently

Before serving traffic, validate the database:

```bash
npm run cloud:pg:validate -- --url "$DATABASE_URL"
```

This checks connectivity, server version, TLS posture, the migration advisory lock, migrations
001–003 with checksum integrity, pool behavior, transactional atomicity, and ledger ordering. It
writes only uniquely-namespaced fixtures and removes them, and refuses a production-looking target
unless `--certification-mode` is passed.

## 5. Create and configure the GitHub OAuth App

At <https://github.com/settings/developers> → **New OAuth App**:

- **Application name:** CodeForge Cloud (Staging)
- **Homepage URL:** your `CODEFORGE_PUBLIC_URL`
- **Authorization callback URL:**

  ```
  https://<CODEFORGE_PUBLIC_URL>/v1/auth/github/callback
  ```

  This exact URL — see the architecture section above. Do **not** register a `127.0.0.1` callback.

Copy the Client ID and generate a Client Secret into `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`.

To confirm the value the server expects, run the preflight (step 6): it prints the callback URL to
register, derived from your actual configuration.

## 6. Run the staging preflight

```bash
npm run cloud:staging:preflight
```

Validates the whole configuration contract before traffic: public URL, database TLS, session secret
strength, OAuth credentials, optional Stripe test-mode, provider capacity, trust-proxy explicitness, and CORS
safety. It prints the exact GitHub callback URL to register, returns non-zero on any unsafe or
incomplete configuration, and **never prints a secret value** — secret variables are reported by
presence and length only.

To see what is still missing at any point:

```bash
npm run cloud:launch:checklist
```

## 7. Run remote certification

Probe the live deployment with no credentials:

```bash
npm run cloud:remote:probe -- --url "$CODEFORGE_PUBLIC_URL" --json remote-probe.json
```

Then run the full certification:

```bash
npm run cloud:certify:staging -- --url "$CODEFORGE_PUBLIC_URL" \
  --interactive \
  --json staging-certification.json \
  --md staging-certification.md
```

`--interactive` is required for the one step that genuinely cannot be automated: a human approving the
GitHub OAuth App in a browser. The harness prints the authorize URL, waits for you to paste back the
single-use code, then resumes on its own. Nothing about that step is ever faked — without a real
session, dependent stages report `BLOCKED`, never `PASS`.

Both artifacts are secret-free by construction: the receipt is schema-validated, redacted, and
scanned before it is written, and the writer refuses rather than emitting a receipt that would carry a
credential.

## 8. Build the staging desktop

```bash
npm run build:channel --workspace=codeforge-desktop -- --channel staging --url "$CODEFORGE_PUBLIC_URL"
npm run dist --workspace=codeforge-desktop
```

The Cloud endpoint is stamped into the build manifest, not read from the environment at runtime: a
packaged staging or production build **ignores `CODEFORGE_CLOUD_URL` entirely**, so privileged
authentication and accounting traffic cannot be redirected by the user, the renderer, or a stray
environment variable. A release-channel build with no configured endpoint refuses to start rather than
falling back to a local address.

## 9. Run first-user acceptance

```bash
node apps/desktop/scripts/first-user-acceptance.mjs --cloud-url "$CODEFORGE_PUBLIC_URL"
```

Starts from an empty app-data directory with no personal provider keys and no existing session, then
drives launch → onboarding → OAuth → catalog refresh → CodeForge Auto → exact model → usage refresh →
logout.

---

## What remains unavoidably human

1. Creating the hosting account and the PostgreSQL instance.
2. Creating the GitHub OAuth App and generating its secret.
3. Pasting those secrets into the platform's secret store.
4. Approving the OAuth App in a browser once, during certification.

Everything else — validation, migration, deployment checks, certification, evidence generation — is
automated by the commands above.

## Related

- [`docs/cloud-deployment.md`](../cloud-deployment.md) — deployment interface details
- [`docs/cloud-operator-runbook.md`](../cloud-operator-runbook.md) — day-2 operations
- [`apps/cloud-api/src/staging-contract.ts`](../../apps/cloud-api/src/staging-contract.ts) — the canonical variable contract
