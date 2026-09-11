#!/usr/bin/env node
// R1 legal remediation (LEG-P2-02 / ENG-P2-02): every workspace package.json declares a
// "license" field consistent with the repository's already-declared MIT policy (root
// package.json, README.md, CONTRIBUTING.md — see docs/legal/remediation/r1-issue-disposition.md
// for the evidence trail). Reproduces the package inventory itself each run rather than trusting
// a hardcoded count, per the R1 spec's explicit instruction not to hardcode "~38-39 packages".
//
// Usage:
//   node scripts/legal/normalize-package-licenses.mjs           # apply fixes
//   node scripts/legal/normalize-package-licenses.mjs --check   # report only, exit 1 if any missing

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO_LICENSE = "MIT";
const CHECK_ONLY = process.argv.includes("--check");

function listWorkspacePackageJsonPaths() {
  const roots = ["apps", "packages"];
  const paths = [];
  for (const root of roots) {
    const rootDir = join(REPO_ROOT, root);
    let entries;
    try {
      entries = readdirSync(rootDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const pkgJsonPath = join(rootDir, entry, "package.json");
      try {
        if (statSync(pkgJsonPath).isFile()) paths.push(pkgJsonPath);
      } catch {
        // no package.json in this directory — not a real workspace package, skip.
      }
    }
  }
  return paths.sort();
}

function insertLicenseField(raw, license) {
  // Preserve formatting/key order by inserting textually right after "private" (or, absent that,
  // right after "version") rather than JSON.stringify-round-tripping the whole file, which would
  // reformat every package.json in the monorepo as an unrelated side effect.
  const licenseLine = `\n  "license": "${license}",`;
  const privateMatch = raw.match(/^(\s*"private"\s*:\s*(?:true|false),?)/m);
  if (privateMatch) {
    const idx = raw.indexOf(privateMatch[0]) + privateMatch[0].length;
    return raw.slice(0, idx) + licenseLine + raw.slice(idx);
  }
  const versionMatch = raw.match(/^(\s*"version"\s*:\s*"[^"]*",?)/m);
  if (versionMatch) {
    const idx = raw.indexOf(versionMatch[0]) + versionMatch[0].length;
    return raw.slice(0, idx) + licenseLine + raw.slice(idx);
  }
  throw new Error("Could not find an anchor (\"private\" or \"version\" field) to insert \"license\" near");
}

function main() {
  const pkgPaths = listWorkspacePackageJsonPaths();
  const missing = [];
  const alreadyOk = [];

  for (const pkgPath of pkgPaths) {
    const raw = readFileSync(pkgPath, "utf8");
    const parsed = JSON.parse(raw);
    if (Object.prototype.hasOwnProperty.call(parsed, "license")) {
      alreadyOk.push({ path: pkgPath, name: parsed.name, license: parsed.license });
      continue;
    }
    missing.push({ path: pkgPath, name: parsed.name, raw });
  }

  console.log(`[normalize-package-licenses] ${pkgPaths.length} workspace package(s) found (apps/* + packages/*).`);
  console.log(`[normalize-package-licenses] ${alreadyOk.length} already declare a license; ${missing.length} missing.`);

  if (missing.length === 0) {
    console.log("[normalize-package-licenses] Nothing to do.");
    return;
  }

  if (CHECK_ONLY) {
    for (const m of missing) console.log(`  MISSING license: ${m.name} (${m.path})`);
    console.error(`[normalize-package-licenses] FAIL: ${missing.length} package(s) missing "license". Run without --check to fix.`);
    process.exitCode = 1;
    return;
  }

  for (const m of missing) {
    const updated = insertLicenseField(m.raw, REPO_LICENSE);
    writeFileSync(m.path, updated, "utf8");
    console.log(`  fixed: ${m.name} -> "license": "${REPO_LICENSE}" (${m.path})`);
  }
  console.log(`[normalize-package-licenses] Added "license": "${REPO_LICENSE}" to ${missing.length} package(s).`);
}

main();
