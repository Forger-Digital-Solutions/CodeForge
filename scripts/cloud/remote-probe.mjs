#!/usr/bin/env node
/**
 * CodeForge Cloud — remote deployment probe CLI.
 *
 *   npm run cloud:remote:probe -- --url https://your-cloud.example.com [--json remote-probe.json]
 *
 * Verifies a live deployment from the outside with no credentials: TLS, health/readiness, security
 * headers, authentication enforcement, OAuth readiness, CORS, payload limits, error normalization,
 * and secret leakage. Exits non-zero on any failed check.
 */
import { writeFileSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const url = argValue("--url") ?? process.env.CODEFORGE_STAGING_URL;
if (!url) {
  console.error("usage: remote-probe.mjs --url https://your-cloud.example.com [--json out.json] [--allow-insecure]");
  console.error("       (or set CODEFORGE_STAGING_URL)");
  process.exit(2);
}

const here = dirname(fileURLToPath(import.meta.url));
const distEntry = resolve(here, "../../apps/cloud-api/dist/remote-probe.js");

let mod;
try {
  mod = await import(pathToFileURL(distEntry).href);
} catch (err) {
  console.error("Could not load the compiled cloud-api build. Run `npm run build` first.");
  console.error(String(err?.message ?? err));
  process.exit(2);
}

const { probeRemoteDeployment, formatProbeReport } = mod;
const report = await probeRemoteDeployment(url, { allowInsecure: process.argv.includes("--allow-insecure") });
console.log(formatProbeReport(report));

const jsonPath = argValue("--json");
if (jsonPath) {
  writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf8");
  console.log(`receipt written to ${jsonPath}`);
}

process.exit(report.ok ? 0 : 1);
