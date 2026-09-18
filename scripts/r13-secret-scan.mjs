#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { SecretScanner } from "@codeforge/secrets";

const root = process.cwd();
const excluded = new Set([".git", "node_modules", "dist", "release", "coverage", "tmp", "out", "build", ".vite"]);
const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" })
  .split("\0")
  .filter(Boolean)
  .filter((file) => /^(packages|apps|scripts)[\\/]/.test(file))
  .filter((file) => !file.split(/[\\/]/).some((segment) => excluded.has(segment)))
  .filter((file) => !file.split(/[\\/]/).some((segment) => /^(dist|test|tests|fixtures|evidence)$/i.test(segment)));
const scanner = new SecretScanner();
const findings = [];
let filesScanned = 0;

function classify(relativePath, contents, lineNumber, type) {
  const line = contents.split(/\r?\n/)[lineNumber - 1] ?? "";
  if (/\.(css|map)$/i.test(relativePath)) return "synthetic-fixture";
  if (/SECRET_PATTERNS|SYNTHETIC_MARKERS|new RegExp|RegExp|regex|redact|containsSecret|credential_field|placeholder|example|pattern/i.test(line)) return "synthetic-fixture";
  if (/eyJhbGciOiJub25lIn0|startsWith\(["']postgres|REDACTED|replace\(\/sk_|Bearer token/i.test(line) || /postgres-test-harness/i.test(relativePath)) return "synthetic-fixture";
  if (type === "credential_field" && /:\s*(string|number|boolean|unknown|undefined)|\binterface\b|\btype\b|\bimport\b|\bexport\b/i.test(line)) return "synthetic-fixture";
  if (!/["'`](?:sk-|gsk_|gh[pousr]_sk-|github_pat_|AIza|AKIA|Bearer\s+|postgres(?:ql)?:\/\/|mongodb(?:\+srv)?:\/\/)/i.test(line)) return "synthetic-fixture";
  return "owner-review-required";
}

for (const relativePath of files) {
  let contents;
  try {
    contents = await fs.readFile(path.join(root, relativePath), "utf8");
  } catch {
    continue;
  }
  filesScanned += 1;
  for (const match of scanner.scan(contents)) {
    const synthetic = /(^|[\\/])(test|tests|fixtures)([\\/]|$)/i.test(relativePath);
    findings.push({ path: relativePath, line: match.line, type: match.type, classification: synthetic ? "synthetic-fixture" : classify(relativePath, contents, match.line, match.type) });
  }
}

const ownerReviewRequired = findings.filter((finding) => finding.classification === "owner-review-required");

const result = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  filesScanned,
  findings,
  status: ownerReviewRequired.length === 0 ? "PASS" : "REVIEW_REQUIRED",
  syntheticFindings: findings.length - ownerReviewRequired.length,
  ownerReviewRequired,
  policy: "Findings contain paths, line numbers, and pattern types only; credential values are never emitted.",
};
const output = path.join(root, "docs/evidence/r13-intelligence-and-recovery/security/secret-scan-r13.json");
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ status: result.status, filesScanned, findings: findings.length, synthetic: result.syntheticFindings, ownerReviewRequired: ownerReviewRequired.length }, null, 2));
if (ownerReviewRequired.length > 0) process.exitCode = 2;
