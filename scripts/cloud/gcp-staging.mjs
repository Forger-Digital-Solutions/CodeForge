#!/usr/bin/env node
/**
 * Google Cloud staging planner for CodeForge Cloud.
 *
 * Default mode is read-only: it prints the exact commands required to create a small,
 * isolated staging topology. `--check` performs read-only gcloud checks. `--apply` is
 * intentionally explicit and is the only mode that mutates a Google Cloud project.
 * Secret values are never accepted as arguments or printed.
 */
import { spawnSync } from "node:child_process";
import { execFileSync } from "node:child_process";

function value(flag, fallback) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const apply = process.argv.includes("--apply");
const check = process.argv.includes("--check");
const project = value("--project", process.env.GCP_PROJECT_ID ?? process.env.GOOGLE_CLOUD_PROJECT);
const region = value("--region", process.env.GCP_REGION ?? "us-east1");
const repository = value("--repository", process.env.GCP_ARTIFACT_REPOSITORY ?? "codeforge");
const service = value("--service", process.env.GCP_CLOUD_RUN_SERVICE ?? "codeforge-cloud-staging");
const sqlInstance = value("--sql-instance", process.env.GCP_CLOUD_SQL_INSTANCE ?? "codeforge-staging");
const sqlTier = value("--sql-tier", process.env.GCP_CLOUD_SQL_TIER);
const publicUrl = value("--public-url", process.env.CODEFORGE_PUBLIC_URL);
const imageTag = value("--tag", process.env.GCP_IMAGE_TAG ?? (() => {
  try { return execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { encoding: "utf8" }).trim(); } catch { return "staging"; }
})());

const secretNames = {
  databaseUrl: "codeforge-staging-database-url",
  jwtSecret: "codeforge-staging-jwt-secret",
};

function quote(arg) {
  return /[\s"']/u.test(arg) ? JSON.stringify(arg) : arg;
}

function command(args, options = {}) {
  console.log(`$ gcloud ${args.map(quote).join(" ")}`);
  if (!apply || options.planOnly) return true;
  const result = spawnSync(process.platform === "win32" ? "gcloud.cmd" : "gcloud", args, { stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) {
    console.error(`gcloud command failed with exit code ${result.status ?? "unknown"}.`);
    process.exitCode = result.status ?? 1;
    return false;
  }
  return true;
}

if (!project) {
  console.error("Set GCP_PROJECT_ID or pass --project PROJECT_ID. No Google Cloud resource was changed.");
  process.exit(2);
}

if (apply && !sqlTier) {
  console.error("--apply requires --sql-tier. OAuth is optional for infrastructure-only staging. No Google Cloud resource was changed.");
  process.exit(2);
}

if (check) {
  const executable = process.platform === "win32" ? "gcloud.cmd" : "gcloud";
  try {
    const account = execFileSync(executable, ["auth", "list", "--filter=status:ACTIVE", "--format=value(account)"], { encoding: "utf8", shell: process.platform === "win32" }).trim();
    const configuredProject = execFileSync(executable, ["config", "get-value", "project"], { encoding: "utf8", shell: process.platform === "win32" }).trim();
    console.log(`gcloud authenticated account: ${account || "none"}`);
    console.log(`gcloud configured project: ${configuredProject || "unset"}`);
    if (!account || configuredProject !== project) {
      console.error("USER_GOOGLE_CLOUD_AUTHORIZATION_REQUIRED: authenticate and select the intended staging project.");
      process.exit(3);
    }
    console.log(`Read-only gcloud identity check passed for project ${project}.`);
  } catch (error) {
    console.error("USER_GOOGLE_CLOUD_AUTHORIZATION_REQUIRED: gcloud is missing, unauthenticated, or cannot read its configuration.");
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(3);
  }
}

console.log(`CodeForge Cloud Google staging plan: project=${project} region=${region} service=${service}`);
console.log(`Mode: ${apply ? "APPLY (mutating)" : "PLAN (read-only)"}`);
console.log("No source repositories are uploaded to Cloud Storage by this plan.");
console.log("");

command(["services", "enable", "run.googleapis.com", "sqladmin.googleapis.com", "artifactregistry.googleapis.com", "secretmanager.googleapis.com", "--project", project]);
command(["artifacts", "repositories", "create", repository, "--repository-format=docker", "--location", region, "--description=CodeForge Cloud staging images", "--project", project]);
command(["iam", "service-accounts", "create", "codeforge-cloud-staging", "--display-name=CodeForge Cloud staging runtime", "--project", project]);
command(["projects", "add-iam-policy-binding", project, "--member=serviceAccount:codeforge-cloud-staging@" + project + ".iam.gserviceaccount.com", "--role=roles/cloudsql.client"]);
for (const name of Object.values(secretNames)) {
  command(["secrets", "create", name, "--replication-policy=automatic", "--project", project], { planOnly: false });
}
for (const name of Object.values(secretNames)) {
  command(["secrets", "add-iam-policy-binding", name, "--member=serviceAccount:codeforge-cloud-staging@" + project + ".iam.gserviceaccount.com", "--role=roles/secretmanager.secretAccessor", "--project", project]);
}

if (sqlTier) {
  command(["sql", "instances", "create", sqlInstance, "--database-version=POSTGRES_16", "--edition=enterprise", "--tier", sqlTier, "--region", region, "--storage-type=SSD", "--storage-size=10GB", "--no-storage-auto-increase", "--availability-type=zonal", "--deletion-protection", "--project", project]);
} else {
  console.log("# Choose the smallest shared-core Cloud SQL tier currently offered for the project, then rerun with --sql-tier TIER.");
  command(["sql", "instances", "create", sqlInstance, "--database-version=POSTGRES_16", "--edition=enterprise", "--tier=<SMALLEST_SHARED_CORE_TIER>", "--region", region, "--storage-type=SSD", "--storage-size=10GB", "--no-storage-auto-increase", "--availability-type=zonal", "--deletion-protection", "--project", project], { planOnly: true });
}
command(["sql", "databases", "create", "codeforge", "--instance", sqlInstance, "--project", project]);
console.log("# Create the database user through the protected secret-generation workflow; no password is accepted by this planner.");

console.log("");
console.log("# Add secret versions interactively or from a protected CI secret store; never pass values as CLI arguments:");
for (const name of Object.values(secretNames)) {
  console.log(`$ gcloud secrets versions add ${name} --data-file=- --project ${project}`);
}
console.log("");
console.log("# Build and publish an immutable image:");
console.log(`$ docker build -f Dockerfile.cloud -t ${region}-docker.pkg.dev/${project}/${repository}/cloud-api:${imageTag} .`);
console.log(`$ gcloud auth configure-docker ${region}-docker.pkg.dev`);
console.log(`$ docker push ${region}-docker.pkg.dev/${project}/${repository}/cloud-api:${imageTag}`);

if (!publicUrl) console.log("# Set CODEFORGE_PUBLIC_URL to the HTTPS staging origin before deployment.");
const image = `${region}-docker.pkg.dev/${project}/${repository}/cloud-api:${imageTag}`;
const publicOrigin = publicUrl ?? "<STAGING_HTTPS_ORIGIN>";
command([
  "run", "deploy", service,
  "--image", image,
  "--region", region,
  "--platform=managed",
  "--allow-unauthenticated",
  "--service-account", `codeforge-cloud-staging@${project}.iam.gserviceaccount.com`,
  "--port=3220",
  "--min=0",
  "--max=2",
  "--cpu=1",
  "--memory=512Mi",
  "--concurrency=20",
  "--timeout=300s",
  "--execution-environment=gen2",
  "--add-cloudsql-instances", `${project}:${region}:${sqlInstance}`,
  "--set-env-vars", `NODE_ENV=production,CODEFORGE_CLOUD_ENV=staging,CODEFORGE_GITHUB_OAUTH_ENABLED=false,HOST=0.0.0.0,PORT=3220,CODEFORGE_TRUST_PROXY=true,CODEFORGE_CLOUD_DB_DRIVER=postgres,CODEFORGE_CLOUD_DB_SSL=false,CODEFORGE_HOSTED_INFERENCE_ENABLED=true,CODEFORGE_HOSTED_FREE_ENABLED=true,CODEFORGE_MAX_REQUESTS_PER_MINUTE=60,CODEFORGE_REQUEST_TIMEOUT_MS=60000,CODEFORGE_MAX_REQUEST_COST_USD=0,CODEFORGE_GLOBAL_DAILY_SPEND_LIMIT_USD=0,CODEFORGE_LOG_LEVEL=info`,
  "--set-secrets", `DATABASE_URL=${secretNames.databaseUrl}:latest,JWT_SECRET=${secretNames.jwtSecret}:latest`,
  "--project", project,
]);

console.log("");
console.log("# Verify liveness/readiness after the revision becomes ready:");
console.log(`$ curl -fsS ${publicOrigin}/health/live`);
console.log(`$ curl -fsS ${publicOrigin}/health/ready`);
console.log(`$ npm run cloud:remote:probe -- --url ${publicOrigin}`);
if (!apply) console.log("PLAN COMPLETE: no Google Cloud resource was changed. Use --apply only after reviewing cost, project, and isolation settings.");
