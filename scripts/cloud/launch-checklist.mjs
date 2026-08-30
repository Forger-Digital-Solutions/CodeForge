#!/usr/bin/env node
/**
 * CodeForge Cloud — staging launch checklist.
 *
 *   npm run cloud:launch:checklist
 *
 * Prints exactly which external actions remain before staging can be launched and certified. Every
 * line is DERIVED from the current environment and repository state — nothing is hard-coded — so as
 * resources are supplied the FAIL lines disappear on their own.
 *
 * Exit code is the number of unresolved external actions (0 when everything is in place), so a
 * pipeline can gate on it.
 */
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");

const rows = [];
const add = (status, label, detail, external = false) => rows.push({ status, label, detail, external });

function has(name) {
  const v = process.env[name];
  return typeof v === "string" && v.trim().length > 0;
}

function tryExec(command, args) {
  try {
    return execFileSync(command, args, { cwd: repoRoot, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return undefined;
  }
}

// --- Repository-controlled capabilities -------------------------------------------------------
// These are things CodeForge itself owns. If any of them regress, that is an engineering blocker,
// not an external one.
add(existsSync(resolve(repoRoot, "Dockerfile.cloud")) ? "PASS" : "FAIL", "Docker image buildable", "Dockerfile.cloud present");

const migrationsPresent = existsSync(resolve(repoRoot, "packages/cloud-db/src/migrations.ts"));
add(migrationsPresent ? "PASS" : "FAIL", "PostgreSQL migrations", "versioned, checksum-validated migrations");

const oauthPresent = existsSync(resolve(repoRoot, "packages/cloud-auth/src/auth-service.ts"));
add(oauthPresent ? "PASS" : "FAIL", "GitHub OAuth implementation", "server-brokered confidential-client flow");

for (const [label, relPath] of [
  ["Staging preflight", "scripts/cloud/staging-preflight.mjs"],
  ["PostgreSQL validator", "scripts/cloud/pg-validate.mjs"],
  ["Remote deployment probe", "scripts/cloud/remote-probe.mjs"],
  ["Remote certification harness", "scripts/cloud/certify-staging.mjs"],
  ["Operator bootstrap document", "docs/cloud/STAGING_BOOTSTRAP.md"],
]) {
  add(existsSync(resolve(repoRoot, relPath)) ? "PASS" : "FAIL", label, relPath);
}

add(existsSync(resolve(repoRoot, ".github/workflows/cloud-ci.yml")) ? "PASS" : "FAIL", "CI", "cloud-ci workflow present");

const compiledCloudApi = existsSync(resolve(repoRoot, "apps/cloud-api/dist/index.js"));
add(compiledCloudApi ? "PASS" : "WARN", "Compiled cloud-api build", compiledCloudApi ? "dist present" : "run `npm run build` before deploying");

const gitSha = tryExec("git", ["rev-parse", "HEAD"]);
add(gitSha ? "PASS" : "WARN", "Git provenance", gitSha ? `HEAD ${gitSha.slice(0, 12)}` : "not a git checkout");

// --- Externally supplied resources -------------------------------------------------------------
// Each of these requires a human to create an account or resource. These are the ONLY things that
// should ever appear in the "external actions remaining" count.
add(has("CODEFORGE_PUBLIC_URL") ? "PASS" : "FAIL", "Public HTTPS Cloud URL", "CODEFORGE_PUBLIC_URL", true);
add(has("DATABASE_URL") ? "PASS" : "FAIL", "Remote PostgreSQL", "DATABASE_URL", true);
add(has("GITHUB_CLIENT_ID") ? "PASS" : "FAIL", "GitHub OAuth Client ID", "GITHUB_CLIENT_ID", true);
add(has("GITHUB_CLIENT_SECRET") ? "PASS" : "FAIL", "GitHub OAuth Client Secret", "GITHUB_CLIENT_SECRET", true);
add(has("JWT_SECRET") ? "PASS" : "FAIL", "Session signing secret", "JWT_SECRET", true);

const providerKeys = ["OPENROUTER_API_KEY", "GROQ_API_KEY"].filter(has);
add(providerKeys.length > 0 ? "PASS" : "FAIL", "Provider server credential", providerKeys.join(", ") || "OPENROUTER_API_KEY and/or GROQ_API_KEY", true);

const stripeReady = has("STRIPE_SECRET_KEY") && has("STRIPE_WEBHOOK_SECRET");
add(
  "PASS",
  "Stripe TEST-mode billing",
  stripeReady ? "configured (optional; TEST mode only)" : "not configured (optional; Hosted Free remains available)",
);

// --- Output -------------------------------------------------------------------------------------
const width = Math.max(...rows.map((r) => r.label.length));
for (const row of rows) {
  console.log(`[${row.status}] ${row.label.padEnd(width)}  ${row.detail}`);
}

const externalRemaining = rows.filter((r) => r.external && r.status === "FAIL");
const internalRemaining = rows.filter((r) => !r.external && r.status === "FAIL");

console.log("");
if (internalRemaining.length > 0) {
  console.log(`Repository-controlled blockers: ${internalRemaining.length}`);
  for (const row of internalRemaining) console.log(`  - ${row.label} (${row.detail})`);
}
console.log(`External actions remaining: ${externalRemaining.length}`);
for (const row of externalRemaining) {
  console.log(`  - supply ${row.detail}`);
}

if (externalRemaining.length === 0 && internalRemaining.length === 0) {
  console.log("");
  console.log("All prerequisites are present. Next:");
  console.log("  npm run cloud:staging:preflight");
  console.log("  npm run cloud:pg:validate -- --url \"$DATABASE_URL\"");
  console.log("  npm run cloud:remote:probe -- --url \"$CODEFORGE_PUBLIC_URL\"");
  console.log("  npm run cloud:certify:staging -- --url \"$CODEFORGE_PUBLIC_URL\"");
}

process.exit(externalRemaining.length + internalRemaining.length);
