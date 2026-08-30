#!/usr/bin/env node
/**
 * CodeForge Cloud — staging preflight CLI.
 *
 *   npm run cloud:staging:preflight
 *
 * Reads the process environment, runs the deterministic preflight from the compiled cloud-api build,
 * and exits non-zero when the configuration would not produce a correct, zero-cost deployment.
 * Secret VALUES are never printed — only presence and shape class.
 *
 * Optional: --json <path> writes the machine-readable report alongside the console summary.
 */
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const distEntry = resolve(here, "../../apps/cloud-api/dist/staging-preflight.js");

let mod;
try {
  mod = await import(pathToFileURL(distEntry).href);
} catch (err) {
  console.error("Could not load the compiled cloud-api build. Run `npm run build` first.");
  console.error(String(err?.message ?? err));
  process.exit(2);
}

const { runStagingPreflight, formatPreflightReport } = mod;
const report = runStagingPreflight(process.env);
console.log(formatPreflightReport(report));

const jsonIdx = process.argv.indexOf("--json");
if (jsonIdx !== -1 && process.argv[jsonIdx + 1]) {
  writeFileSync(process.argv[jsonIdx + 1], JSON.stringify(report, null, 2), "utf8");
  console.log(`report written to ${process.argv[jsonIdx + 1]}`);
}

process.exit(report.ok ? 0 : 1);
