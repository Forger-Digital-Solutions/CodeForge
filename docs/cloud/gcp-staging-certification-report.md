# GCP staging certification report

Generated: 2026-09-09

## Verdict

`CODEFORGE_GCP_STAGING_PROVISIONING_IN_PROGRESS`

`FORGEGREEN_CLOUD_DURABILITY_NOT_CERTIFIABLE`

The repository's hosted `apps/cloud-api` has durable Cloud account, authentication, entitlement,
usage, and publication state. It does not expose the desktop workflow, ForgeVerify, or ForgeGreen
authority path. Claiming a Desktop -> Cloud Run -> Cloud SQL ForgeGreen replacement proof would be
false until that existing authority is deliberately hosted in a separate milestone.

## Applied staging plan

- Project: `project-cecfd600-cbad-4750-8b2`
- Region: `us-east1`
- Cloud Run target: `codeforge-cloud-staging`, 1 vCPU, 512 MiB, min 0, max 2, concurrency 20,
  300 second timeout.
- Artifact Registry: regional Docker repository `codeforge`.
- Cloud SQL: `codeforge-staging`, PostgreSQL 16, Enterprise `db-f1-micro`, 10 GB SSD, zonal,
  auto-growth disabled, deletion protection enabled, no HA or replica.
- Runtime identity: `codeforge-cloud-staging` with Cloud SQL Client and secret-level access only to
  the two runtime secrets.
- Secret containers: `codeforge-staging-database-url`, `codeforge-staging-jwt-secret`.

Cloud SQL is the primary recurring cost. Its shared-core instance is priced at $0.0105/hour in
`us-east1` at the time of planning; Cloud Run is request-billed and configured to scale to zero.

## Current evidence

- Billing is enabled for the staging project.
- Enabled APIs: Cloud Run, Cloud SQL Admin, Artifact Registry, Secret Manager.
- The `codeforge` database and `codeforge` built-in database user were created after Cloud SQL reached
  `RUNNABLE`. The database password and JWT were generated in memory and added directly to the two
  staging Secret Manager containers; no values were printed or committed.
- Seven retained daily backups are enabled. Cloud Run, image publication, desktop package, custom DNS,
  storage bucket, provider credential, and production resources remain absent.
- Focused cloud configuration tests: 21 passed.
- Cloud API TypeScript build: passed.
- GCP planner syntax: passed.
- `git diff --check`: passed.
- Docker Desktop/engine was unavailable, so no local container smoke or Artifact Registry publish was
  attempted.

## Remaining sequence

1. Resolve the Google Cloud Build permission denial or use an authorized build identity to publish the
   existing `Dockerfile.cloud` image. Docker Desktop remains unavailable locally.
2. Build and publish the existing `Dockerfile.cloud` image using the authorized build route.
3. Deploy the Cloud API with GitHub OAuth explicitly disabled, then use the Cloud Run URL as the
   stamped desktop staging endpoint for hosted health/database checks.
4. Add real staging GitHub OAuth credentials through Secret Manager and obtain user consent before
   certifying OAuth.
5. Host the workflow/ForgeGreen authority before attempting the mandatory workflow persistence,
   evidence reuse, stale-rejection, duplicate-suppression, and Cloud Run replacement certification.

## Safety

`render.yaml` was not changed. Production DNS, endpoint, database, secrets, and routing remain
untouched. No remote Git operation was performed.
