#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const output = path.join(root, "docs/evidence/r30-release-unblocking/00-recovery/inherited-evidence.json");

async function verify(relativeManifest) {
  const manifest = JSON.parse(await readFile(path.join(root, relativeManifest), "utf8"));
  const mismatches = [];
  for (const entry of manifest.files) {
    const absolute = path.resolve(root, entry.path);
    if (!absolute.startsWith(`${root}${path.sep}`)) throw new Error(`Frozen path escaped repository: ${entry.path}`);
    try {
      const bytes = await readFile(absolute);
      const hash = createHash("sha256").update(bytes).digest("hex");
      if (bytes.length !== entry.bytes || hash !== entry.sha256) {
        mismatches.push({ path: entry.path, expectedBytes: entry.bytes, actualBytes: bytes.length, expectedSha256: entry.sha256, actualSha256: hash });
      }
    } catch (error) {
      mismatches.push({ path: entry.path, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return {
    manifest: relativeManifest,
    declared: manifest.fileCount,
    listed: manifest.files.length,
    matched: manifest.files.length - mismatches.length,
    mismatches,
    passed: manifest.fileCount === manifest.files.length && mismatches.length === 0,
  };
}

const receipt = {
  schema: "r30-inherited-evidence-check-1",
  checkedAt: new Date().toISOString(),
  sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  r29: await verify("docs/evidence/r29-release-closure/R29-EVIDENCE-FREEZE.json"),
  r28: await verify("docs/evidence/r28-capability-completion/R28-EVIDENCE-FREEZE.json"),
};
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify({ r29: receipt.r29.matched, r28: receipt.r28.matched, passed: receipt.r29.passed && receipt.r28.passed }));
if (!receipt.r29.passed || !receipt.r28.passed) process.exitCode = 1;
