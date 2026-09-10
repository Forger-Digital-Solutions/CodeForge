# CodeForge Cloud — Google Cloud staging readiness

This is the repository-side Google Cloud staging runbook. It contains no secret values. Production remains a separate deployment and must never
reuse staging state, OAuth credentials, session keys, or provider secrets.

## Architecture audit

The repository already provides the core Cloud Run payload:

- `apps/cloud-api` is the HTTP entrypoint with `/health/live` and `/health/ready`.
- `Dockerfile.cloud` builds compiled TypeScript in a multi-stage image and runs as non-root.
- `packages/cloud-db` has checksum-validated SQLite and PostgreSQL migrations for users, identities,
  device sessions, OAuth transactions, account settings, usage, reservations, billing events, and
  hosted requests.
- `apps/cloud-api/src/config.ts` fails closed for PostgreSQL, session signing, and enabled GitHub
  OAuth. Infrastructure-only staging explicitly disables OAuth until a real staging OAuth App exists.
- GitHub OAuth is server-confidential; the desktop receives neither the GitHub client secret nor
  provider master keys.
- `render.yaml`, the Docker image, staging preflight, PostgreSQL validator, remote probe, and
  certification harness already define platform-neutral deployment behavior.
- `apps/desktop/cloud-endpoints.json` and `build:channel` provide an explicit stamped staging
  endpoint. Packaged clients do not accept a runtime URL override.

The Google-specific gap was deployment reproducibility: there was no Artifact Registry, Cloud SQL,
Secret Manager, or Cloud Run command set. `scripts/cloud/gcp-staging.mjs` now supplies that plan.
The hosted Cloud API currently owns the cloud account/auth/usage state above; the local workflow
server's session, ForgeVerify, and ForgeGreen persistence remains a separate server path and is not
silently reclassified as cloud-hosted state.

## Cost-safe staging topology

Use one staging project or a dedicated staging database/secret namespace. The planner defaults to:

- Cloud Run: one vCPU, 512 MiB, concurrency 20, minimum instances 0, maximum instances 2,
  300-second request timeout.
- Cloud SQL: PostgreSQL 16, zonal availability, 10 GB SSD, storage auto-increase disabled, and the
  smallest shared-core tier currently offered for the project. The tier is deliberately required as
  an explicit operator choice because product availability and pricing can change.
- Artifact Registry: one Docker repository in the Cloud Run region.
- Secret Manager: staging-only secret names. No secret values are written to Git, Docker layers,
  desktop bundles, or command-line arguments.
- Cloud Storage: not provisioned by default. If later used for certification evidence or backups,
  create a separate staging bucket with a lifecycle policy; never upload user source repositories
  by default.

No GKE, Compute Engine VM, GPU, BigQuery, Pub/Sub, or always-on worker is part of staging.

## Required Google APIs

The planner enables these only when an operator explicitly runs it with `--apply`:

`run.googleapis.com`, `sqladmin.googleapis.com`, `artifactregistry.googleapis.com`,
`secretmanager.googleapis.com`.

## Read-only checks and plan

```powershell
gcloud --version
node scripts/cloud/gcp-staging.mjs --check --project PROJECT_ID
node scripts/cloud/gcp-staging.mjs --project PROJECT_ID --region us-east1
```

The default invocation is a plan only. It prints commands but does not enable APIs, create databases,
create secrets, publish images, or deploy Cloud Run.

## Provisioning sequence (explicit operator action)

Review the plan first, then run the mutating mode only after confirming project, billing, region,
Cloud SQL tier, and staging isolation:

```powershell
node scripts/cloud/gcp-staging.mjs `
  --apply `
  --project PROJECT_ID `
  --region us-east1 `
  --sql-tier db-f1-micro
```

The script requires `--apply` and an explicit SQL tier. It uses Cloud SQL Enterprise edition because
shared-core tiers require it. It never accepts secret values as arguments. Initial infrastructure
staging has GitHub OAuth explicitly disabled; enabling it later requires a real staging OAuth App.

Create secret versions from a protected terminal or CI secret store. The following names are the
only secrets required by the current Cloud API path:

```text
codeforge-staging-database-url
codeforge-staging-jwt-secret
```

The database URL should use the Cloud SQL Unix socket exposed by the Cloud Run integration, for
example `postgresql://codeforge:<password>@localhost/codeforge?host=/cloudsql/PROJECT:REGION:INSTANCE`.
Store that complete value only as the `codeforge-staging-database-url` secret. The service account
needs `roles/cloudsql.client` and `roles/secretmanager.secretAccessor`, scoped to the staging
runtime account.

## Image, migration, and deployment behavior

The image path is:

```text
source → Dockerfile.cloud → Artifact Registry immutable tag → Cloud Run revision
```

The current server initializes and migrates PostgreSQL before accepting traffic. There is no separate
migration binary to maintain. Validate the database before or alongside deployment with:

```powershell
gcloud sql connect INSTANCE --project PROJECT_ID --user codeforge
node scripts/cloud/pg-validate.mjs --url "$env:DATABASE_URL"
```

Do not put `DATABASE_URL` in a desktop environment. Cloud Run receives it through Secret Manager;
the desktop receives only the HTTPS API origin.

After deployment:

```powershell
curl.exe -fsS https://STAGING_CLOUD_RUN_OR_CUSTOM_ORIGIN/health/live
curl.exe -fsS https://STAGING_CLOUD_RUN_OR_CUSTOM_ORIGIN/health/ready
node scripts/cloud/remote-probe.mjs --url https://STAGING_CLOUD_RUN_OR_CUSTOM_ORIGIN
```

The server's readiness endpoint may correctly report Hosted Free unavailable when no server-owned
provider credential is configured. That is capacity absence, not permission to route paid or local
models.

## GitHub OAuth and staging isolation

Create a distinct GitHub OAuth App for staging. Register exactly:

```text
https://STAGING_CLOUD_RUN_OR_CUSTOM_ORIGIN/v1/auth/github/callback
```

Do not register the desktop loopback callback. Production later uses its own OAuth App, public URL,
database, secrets, Cloud Run service, and provider credentials. The production hostname
`cloud.forgerdigitalsolutions.com` is not configured or targeted by this staging plan.

Build an explicit staging desktop only after the endpoint exists:

```powershell
npm run build:channel --workspace=codeforge-desktop -- --channel staging --url https://STAGING_CLOUD_RUN_OR_CUSTOM_ORIGIN
npm run dist --workspace=codeforge-desktop
```

## Health, rollback, and certification

Cloud Run revisions are immutable. Roll back by moving traffic to the last known-good revision:

```powershell
gcloud run revisions list --service codeforge-cloud-staging --region REGION --project PROJECT_ID
gcloud run services update-traffic codeforge-cloud-staging --to-revisions REVISION=100 --region REGION --project PROJECT_ID
```

Do not delete the database during rollback. PostgreSQL migrations are append-only and checksum
validated; a destructive schema rollback is not part of the staging process.

The existing remote harness remains the certification entrypoint:

```powershell
npm run cloud:certify:staging -- --url https://STAGING_CLOUD_RUN_OR_CUSTOM_ORIGIN --json staging-certification.json --md staging-certification.md
```

Its real GitHub authorization step remains `USER_AUTHORIZATION_REQUIRED` when a human must approve
the OAuth App. A future cloud workflow endpoint must be added before claiming that the local
ForgeVerify/ForgeGreen restart proof has become a Desktop → Cloud Run → Cloud SQL proof; this plan
does not make that claim prematurely.

## Current authorization boundary

Google authentication is user-controlled. When no real GitHub OAuth App exists, leave
`CODEFORGE_GITHUB_OAUTH_ENABLED=false`; the hosted service remains usable for health, database, and
non-OAuth infrastructure checks while OAuth routes return a fail-closed 503. Add the OAuth secret
only through Secret Manager, then enable the feature in a separate revision.
