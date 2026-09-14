# CodeForge RC2 — Deployment and Activation Runbook

This is the RC2 handoff for a four-seat, zero-cash Hosted Free deployment. It is intentionally
operator-driven: the repository contains the server, the fail-closed gates, the client endpoint
stamping, and the certification instruments, but it does not contain or invent provider credentials.
No deployment, OAuth approval, database migration, or external account mutation is performed by the
repository build.

## Target topology

```text
Packaged CodeForge desktop
        │ HTTPS + SSE, server-brokered GitHub OAuth/PKCE
        ▼
CodeForge Cloud API ─── PostgreSQL over verified TLS
        │
        ├── Groq: exact GPT-OSS Free-plan routes
        └── Cloudflare Workers AI: limited reserve route
```

Users do not enter provider keys. Provider credentials remain in the Cloud secret store, are loaded
only into the server process, and are never returned by `/v1/meta`, `/v1/hosted/models`, readiness,
capacity status, logs, or the desktop bundle. The Cloud chooses the provider and model after
authentication and ForgeZero verification; request bodies cannot bypass that choice.

The public truth surface is `GET /v1/hosted/status`:

| State | Meaning | Can route? |
|---|---|---:|
| `active` | exact route was live-listed, live-probed, and is currently ForgeZero-eligible | yes |
| `qualified_but_inactive` | code-reviewed route is allowed, but credentials, discovery, health, or quota are not currently active | no |
| `policy_record_required` | route is deliberately blocked pending the hosted multi-tenant policy/data-use record | no |

The UI must treat `available=false` as a blocked capacity state, never as a successful “free”
simulation. Four seats describe the intended small-team capacity; they do not create provider quota.

## Managed route policy

Only the exact inventory in `packages/cloud-gateway/src/managed-free-inventory.ts` may enter the
managed pool.

| Provider | Exact model(s) | Activation | Operator guard |
|---|---|---|---|
| Groq | `openai/gpt-oss-120b`, `openai/gpt-oss-20b` | approved, then live discovery/probe | key plus `CODEFORGE_GROQ_FREE_PLAN_ONLY=true` |
| Cloudflare Workers AI | `@cf/zai-org/glm-4.7-flash` | approved, then live discovery/probe | account id, token, and `CODEFORGE_CLOUDFLARE_FREE_PLAN_ONLY=true` |
| Z.AI | `glm-4.7-flash` | `policy_record_required` | no activation until policy approval |
| OpenRouter | none in managed pool | excluded | BYOK only; never a server-owned pooled key |

The provider records are intentionally conservative. Groq publishes organization-level RPM/TPM/RPD
limits and 429 retry behavior in its [rate-limit documentation](https://console.groq.com/docs/rate-limits).
Cloudflare Workers AI documents a Free allocation of 10,000 Neurons per day and paid usage above
that in its [pricing documentation](https://developers.cloudflare.com/workers-ai/platform/pricing/),
so the reserve must remain explicitly Free-guarded and must fail closed on exhaustion. Z.AI's
[pricing documentation](https://docs.z.ai/guides/overview/pricing) does not by itself provide the
hosted multi-tenant data-use approval required by this product, so the route remains inactive.

## Environment provisioning

The canonical variable list is
[`apps/cloud-api/src/staging-contract.ts`](../../apps/cloud-api/src/staging-contract.ts). Provision
it in the platform secret/config store, never in Git, `.env` files committed to the repository,
Docker build arguments, or desktop artifacts.

Required deployment values:

- `NODE_ENV=production`, `CODEFORGE_CLOUD_ENV=staging` or `production`, `HOST=0.0.0.0`.
- `CODEFORGE_PUBLIC_URL` as a stable HTTPS origin, or the platform's documented
  `RENDER_EXTERNAL_URL` fallback.
- `CODEFORGE_TRUST_PROXY=true` only when the platform terminates the trusted proxy hop.
- `CODEFORGE_CLOUD_DB_DRIVER=postgres`, `DATABASE_URL`, and `CODEFORGE_CLOUD_DB_SSL=true` for a
  remote database.
- A fresh 32+ character `JWT_SECRET` and server-owned GitHub OAuth client id/secret.
- No live Stripe key. Stripe is optional and, if enabled, must be a complete test-mode pair.

To activate managed capacity, provision at least one complete guarded provider pair from the table
above. A Z.AI key alone is not an activation. A provider key with a false or missing Free-plan guard
is a preflight failure. Do not configure a paid fallback, a billing card, or a provider credential
on the desktop.

## Staging sequence

1. Create the HTTPS service and durable PostgreSQL database. Do not use ephemeral SQLite for staging
   or production.
2. Create the GitHub OAuth App. Register exactly:
   `https://<public-origin>/v1/auth/github/callback`. Do not register a loopback desktop callback.
3. Add the environment values in the platform secret store.
4. Run the deterministic preflight before exposing traffic:

   ```powershell
   npm run cloud:staging:preflight
   ```

5. Validate the remote database with the certification flag required by the harness:

   ```powershell
   npm run cloud:pg:validate -- --url "$env:DATABASE_URL" --certification-mode
   ```

6. Deploy the already-built Cloud image or run the platform build. Confirm `/health/live`,
   `/health/ready`, and `/v1/hosted/status`. If no exact route is active, stop here: this is a
   blocked-capacity result, not a passing inference test.
7. Run the unauthenticated remote probe and the interactive first-user certification. The one human
   step is approving GitHub in a browser; the harness must use a real session and must not be replaced
   with a fixture.

   ```powershell
   npm run cloud:remote:probe -- --url "$env:CODEFORGE_PUBLIC_URL" --json remote-probe.json
   npm run cloud:certify:staging -- --url "$env:CODEFORGE_PUBLIC_URL" --interactive `
     --json staging-certification.json --md staging-certification.md
   ```

8. Stamp the desktop endpoint into the requested release channel and build the installers:

   ```powershell
   npm run build:channel --workspace=codeforge-desktop -- --channel staging --url "$env:CODEFORGE_PUBLIC_URL"
   npm run dist --workspace=codeforge-desktop
   ```

   Packaged staging/production builds ignore `CODEFORGE_CLOUD_URL` and do not fall back to localhost.
9. Run the fresh-user acceptance from an empty app-data directory with no user provider keys:

   ```powershell
   node apps/desktop/scripts/first-user-acceptance.mjs --cloud-url "$env:CODEFORGE_PUBLIC_URL"
   ```

   The acceptance must prove launch, GitHub OAuth/PKCE, account provisioning, hosted catalog, Auto,
   exact-model selection, tool-call round trip, usage refresh, logout, and relaunch persistence.

## Production promotion gates

Promote only when all of these are true:

- staging preflight passes with the actual production-shaped secret store;
- database migration and TLS receipts are clean;
- `/v1/hosted/status` reports at least one `active` managed route;
- fresh-user acceptance passes without a personal provider key;
- tool-call, 401 refresh, 429 cooldown, and restart/recovery checks pass;
- packaged endpoint audit finds no development or localhost dependency;
- installer and portable hashes are recorded in the RC2 certification receipt;
- signing identity and update feed are intentionally configured, or the release is explicitly marked
  unsigned and withheld from public distribution.

Do not call a deployment “ready” merely because the service boots. A deployment with no active
managed route is operationally healthy but capacity-blocked, and a deployment with an unverified
provider route is never success.

## Day-2 operations

- Watch `/health/ready` and `/v1/hosted/status`; provider state is global, not per-user.
- A provider 429 marks every route for that provider rate-limited and releases the user's reservation;
  the next Auto request may use another active managed route.
- A provider 401/403 removes its models from eligibility until credentials are corrected and the next
  discovery pass succeeds.
- Keep the managed inventory and policy records under code review. Do not add a provider because its
  public model list happens to contain a free-looking model.
- If Free allocation is exhausted, disable the route or let the hard-stop fire. Never attach paid
  fallback billing to preserve apparent availability.

## External activation still required

The repository cannot complete these without operator authority and real external resources:

1. create the hosting and PostgreSQL resources;
2. create the GitHub OAuth App and register the callback;
3. provision the managed provider credentials and explicit Free-plan guards;
4. approve the real OAuth browser flow;
5. authorize any deployment, DNS, signing, or public release action.

Until those steps are performed, the correct RC2 verdict is implemented and locally verified, with
external activation required.
