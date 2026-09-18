#!/usr/bin/env node
/**
 * Dependency vulnerability gate (Security R1, Phase 28).
 *
 * Runs `npm audit --json` over the whole workspace and fails on any HIGH or CRITICAL advisory
 * that is not explicitly accepted in scripts/security/dependency-audit-allowlist.json (with an
 * expiry, so accepted risk is re-examined). Moderate/low findings are reported, not blocking.
 * Also writes a CycloneDX-style SBOM summary (name/version/license/resolved) derived from the
 * lockfile so the shipped dependency inventory is auditable without network access.
 *
 *   node scripts/security/audit-dependencies.mjs [--json docs/evidence/security-r1/dependency-audit.json] [--sbom docs/evidence/security-r1/sbom.json]
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const args = process.argv.slice(2);
const jsonOut = args.includes("--json") ? args[args.indexOf("--json") + 1] : "docs/evidence/security-r1/dependency-audit.json";
const sbomOut = args.includes("--sbom") ? args[args.indexOf("--sbom") + 1] : "docs/evidence/security-r1/sbom.json";
const allowlistPath = "scripts/security/dependency-audit-allowlist.json";

const auditArgs = ["audit", "--json", "--no-fund"];
const audit = process.platform === "win32"
  ? spawnSync("cmd.exe", ["/d", "/s", "/c", "npm", ...auditArgs], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true })
  : spawnSync("npm", auditArgs, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const rawOut = `${audit.stdout ?? ""}`;
const start = rawOut.indexOf("{");
let report;
try {
  report = JSON.parse(rawOut.slice(start, rawOut.lastIndexOf("}") + 1));
} catch {
  console.error("npm audit did not return JSON (network or registry failure). stderr:", (audit.stderr ?? "").slice(0, 500));
  process.exit(4);
}

let allowlist = [];
try {
  allowlist = JSON.parse(await fs.readFile(path.resolve(root, allowlistPath), "utf8")).entries ?? [];
} catch {
  allowlist = [];
}
const now = Date.now();
const accepted = (name, advisoryUrl) =>
  allowlist.find((e) => e.package === name && (!e.advisory || e.advisory === advisoryUrl) && Date.parse(e.expires) > now);

const vulnerabilities = Object.entries(report.vulnerabilities ?? {}).map(([name, v]) => {
  const advisories = (v.via ?? []).filter((via) => typeof via === "object").map((via) => ({ title: via.title, url: via.url, severity: via.severity, range: via.range }));
  const acceptedEntry = accepted(name, advisories[0]?.url);
  return { name, severity: v.severity, isDirect: v.isDirect, range: v.range, fixAvailable: Boolean(v.fixAvailable), advisories, accepted: acceptedEntry ? { reason: acceptedEntry.reason, expires: acceptedEntry.expires } : null };
});
const blocking = vulnerabilities.filter((v) => (v.severity === "high" || v.severity === "critical") && !v.accepted);

// SBOM summary from the lockfile (no network).
const lock = JSON.parse(await fs.readFile(path.resolve(root, "package-lock.json"), "utf8"));
const components = Object.entries(lock.packages ?? {})
  .filter(([key]) => key.startsWith("node_modules/"))
  .map(([key, pkg]) => ({
    name: key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length),
    version: pkg.version,
    license: pkg.license ?? null,
    dev: Boolean(pkg.dev),
    optional: Boolean(pkg.optional),
    resolved: pkg.resolved ?? null,
    integrity: pkg.integrity ? pkg.integrity.slice(0, 20) + "…" : null,
    hasInstallScript: Boolean(pkg.hasInstallScript),
  }))
  .sort((a, b) => a.name.localeCompare(b.name) || String(a.version).localeCompare(String(b.version)));

const sbom = {
  bomFormat: "CycloneDX-summary",
  specVersion: "1.5-summary",
  generatedAt: new Date().toISOString(),
  lockfileVersion: lock.lockfileVersion,
  componentCount: components.length,
  installScriptPackages: components.filter((c) => c.hasInstallScript).map((c) => `${c.name}@${c.version}`),
  components,
};

const result = {
  generatedAt: new Date().toISOString(),
  npmAuditExitCode: audit.status,
  summary: report.metadata?.vulnerabilities ?? {},
  blocking,
  accepted: vulnerabilities.filter((v) => v.accepted),
  nonBlocking: vulnerabilities.filter((v) => !(v.severity === "high" || v.severity === "critical")),
  status: blocking.length === 0 ? "PASS" : "FAIL",
};

await fs.mkdir(path.dirname(path.resolve(root, jsonOut)), { recursive: true });
await fs.writeFile(path.resolve(root, jsonOut), `${JSON.stringify(result, null, 2)}\n`, "utf8");
await fs.writeFile(path.resolve(root, sbomOut), `${JSON.stringify(sbom, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ status: result.status, summary: result.summary, blocking: blocking.map((b) => `${b.name} (${b.severity})`), components: components.length, installScriptPackages: sbom.installScriptPackages, report: jsonOut, sbom: sbomOut }, null, 2));
if (blocking.length > 0) process.exitCode = 2;
