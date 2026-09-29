#!/usr/bin/env node
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve("docs/evidence/r58-progress-aware-autonomy");
const patterns = [
  ["openrouter_key", /\bsk-or-v1-[a-f0-9]{32,}\b/i],
  ["groq_key", /\bgsk_[A-Za-z0-9]{20,}\b/],
  ["github_token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/],
  ["bearer_token", /\bBearer\s+[A-Za-z0-9._-]{24,}\b/i],
  ["private_key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["provider_organization_id", /\borg_[a-z0-9]{12,}\b/i],
];

const files = (await readdir(root)).filter((name) => /\.(?:json|log|md)$/.test(name));
const findings = [];
for (const name of files) {
  const contents = await readFile(path.join(root, name), "utf8");
  for (const [kind, pattern] of patterns) {
    if (pattern.test(contents)) findings.push({ file: name, kind });
  }
}
const result = {
  schema: "r58-evidence-privacy-scan/v1",
  scannedFiles: files.length,
  findings,
  status: findings.length === 0 ? "PASS" : "FAIL",
};
await writeFile(path.join(root, "final-evidence-privacy-scan.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result));
if (findings.length > 0) process.exitCode = 2;
