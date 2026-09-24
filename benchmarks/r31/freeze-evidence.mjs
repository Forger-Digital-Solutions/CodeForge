#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const evidenceRoot = "docs/evidence/r31-production-release-closure";
const manifestPath = `${evidenceRoot}/R31-EVIDENCE-FREEZE.json`;
const artifactReceiptPath = `${evidenceRoot}/16-final-package/artifacts.json`;
const certificationPath = "docs/certification/codeforge-r31-production-release-closure-2026-09-24.md";
const r30ProductCommit = "999d41683da9b6eb5fa2059e28f46f8b1d3dc576";
const r30AsarSha256 = "768b6557819dd527f50dcb3e3e12c09adfcd0f586cd2db19a04e3279986777bd";
const verdicts = new Set([
  "CODEFORGE_R31_RELEASE_BLOCKED",
  "CODEFORGE_R31_SOFTWARE_RELEASE_READY_EXTERNAL_BLOCKERS_ONLY",
  "CODEFORGE_R31_PRODUCTION_RELEASE_CERTIFIED",
]);

function git(...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function resolveInside(relative) {
  if (path.isAbsolute(relative)) throw new Error(`Absolute path is not allowed: ${relative}`);
  const absolute = path.resolve(root, relative);
  if (!absolute.startsWith(`${root}${path.sep}`)) throw new Error(`Path escaped repository: ${relative}`);
  return absolute;
}

async function hashFile(relative) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(resolveInside(relative))) {
    bytes += chunk.length;
    hash.update(chunk);
  }
  return { path: relative, bytes, sha256: hash.digest("hex") };
}

function checkEvidencePath(relative) {
  const segments = relative.toLowerCase().split("/");
  if (segments.some((segment) => segment.startsWith("profile-") || ["smoke-user-data", "smoke-workspace", "sterile-profile", ".env"].includes(segment)) ||
      /\.(?:db|sqlite|pfx|p12|pem|key)$/i.test(relative)) {
    throw new Error(`Private runtime material is not allowed in the evidence freeze: ${relative}`);
  }
}

async function walk(relative) {
  const found = [];
  for (const item of await readdir(resolveInside(relative), { withFileTypes: true })) {
    const child = `${relative}/${item.name}`;
    if (item.isSymbolicLink()) throw new Error(`Evidence symlink is not allowed: ${child}`);
    if (item.isDirectory()) found.push(...await walk(child));
    else if (item.isFile() && child !== manifestPath) {
      checkEvidencePath(child);
      found.push(child);
    }
  }
  return found;
}

async function currentEvidenceFiles() {
  const sources = [
    ...await walk(evidenceRoot),
    ...await walk("benchmarks/r31"),
    certificationPath,
  ].sort();
  return Promise.all(sources.map(hashFile));
}

async function readArtifactReceipt() {
  let receipt;
  try {
    receipt = JSON.parse(await readFile(resolveInside(artifactReceiptPath), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const sourceCommit = receipt.sourceCommit ?? receipt.SourceCommit;
  const rawArtifacts = receipt.artifacts ?? receipt.Artifacts;
  if (!/^[0-9a-f]{40}$/.test(sourceCommit ?? "") || !Array.isArray(rawArtifacts)) {
    throw new Error(`Invalid R31 artifact receipt: ${artifactReceiptPath}`);
  }
  const paths = new Set();
  const artifacts = [];
  for (const item of rawArtifacts) {
    const relative = item.path ?? item.Path;
    const expectedBytes = item.bytes ?? item.Bytes;
    const expectedHash = item.sha256 ?? item.Sha256;
    if (typeof relative !== "string" || !relative.startsWith("apps/desktop/release/") || paths.has(relative) ||
        !Number.isSafeInteger(expectedBytes) || expectedBytes <= 0 || !/^[0-9a-f]{64}$/.test(expectedHash ?? "")) {
      throw new Error(`Invalid R31 artifact entry: ${String(relative)}`);
    }
    paths.add(relative);
    const actual = await hashFile(relative);
    if (actual.bytes !== expectedBytes || actual.sha256 !== expectedHash) {
      throw new Error(`R31 artifact receipt does not match file: ${relative}`);
    }
    artifacts.push(actual);
  }
  artifacts.sort((left, right) => left.path.localeCompare(right.path));
  return { sourceCommit, artifacts };
}

function hasRequiredArtifacts(artifacts) {
  const paths = artifacts.map((artifact) => artifact.path);
  return artifacts.some((artifact) => artifact.path.endsWith("/resources/app.asar") && artifact.sha256 !== r30AsarSha256) &&
    paths.some((value) => value.endsWith("/win-unpacked/CodeForge.exe")) &&
    paths.some((value) => /\/CodeForge-Setup-[^/]+\.exe$/.test(value)) &&
    paths.some((value) => value.endsWith("/CodeForge-Portable.exe"));
}

function isAncestor(commit) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", commit, "HEAD"], { cwd: root, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function freeze() {
  const verdict = process.argv.find((arg) => arg.startsWith("--verdict="))?.slice("--verdict=".length);
  if (!verdicts.has(verdict)) throw new Error(`Explicit R31 verdict required: ${[...verdicts].join(", ")}`);
  if (await stat(resolveInside(manifestPath)).catch(() => null)) throw new Error("R31 freeze exists; refusing to overwrite it.");
  const files = await currentEvidenceFiles();
  const packageReceipt = await readArtifactReceipt();
  const ready = verdict !== "CODEFORGE_R31_RELEASE_BLOCKED";
  if (ready && (!packageReceipt || !hasRequiredArtifacts(packageReceipt.artifacts) || packageReceipt.sourceCommit === r30ProductCommit)) {
    throw new Error("A ready verdict requires four fresh R31 package artifacts and a new source commit.");
  }
  if (packageReceipt && !isAncestor(packageReceipt.sourceCommit)) {
    throw new Error("R31 artifact source commit is not an ancestor of HEAD.");
  }
  const manifest = {
    schema: "r31-evidence-freeze-1",
    frozenAt: new Date().toISOString(),
    verdict,
    sourceHead: git("rev-parse", "HEAD"),
    artifactSourceCommit: packageReceipt?.sourceCommit ?? null,
    artifactReceipt: packageReceipt ? artifactReceiptPath : null,
    certification: certificationPath,
    environment: {
      platform: process.platform,
      release: os.release(),
      arch: process.arch,
      logicalProcessors: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
      nodeVersion: process.version,
    },
    fileCount: files.length,
    files,
    artifacts: packageReceipt?.artifacts ?? [],
  };
  await writeFile(resolveInside(manifestPath), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify({ frozen: true, verdict, sourceHead: manifest.sourceHead, evidenceFiles: files.length, artifacts: manifest.artifacts.length }));
}

async function verify() {
  const manifest = JSON.parse(await readFile(resolveInside(manifestPath), "utf8"));
  const files = await currentEvidenceFiles();
  const packageReceipt = await readArtifactReceipt();
  const mismatches = [];
  if (!verdicts.has(manifest.verdict)) mismatches.push("verdict");
  if (manifest.schema !== "r31-evidence-freeze-1" || manifest.certification !== certificationPath) mismatches.push("metadata");
  if (!isAncestor(manifest.sourceHead)) mismatches.push("sourceHead");
  if (manifest.fileCount !== files.length || JSON.stringify(manifest.files) !== JSON.stringify(files)) mismatches.push("evidenceFiles");
  if (manifest.artifactSourceCommit !== (packageReceipt?.sourceCommit ?? null) ||
      manifest.artifactReceipt !== (packageReceipt ? artifactReceiptPath : null) ||
      JSON.stringify(manifest.artifacts) !== JSON.stringify(packageReceipt?.artifacts ?? [])) mismatches.push("artifacts");
  if (manifest.verdict !== "CODEFORGE_R31_RELEASE_BLOCKED" &&
      (!packageReceipt || !hasRequiredArtifacts(packageReceipt.artifacts) || packageReceipt.sourceCommit === r30ProductCommit)) mismatches.push("readyArtifactGate");
  const passed = mismatches.length === 0;
  console.log(JSON.stringify({ passed, evidenceFiles: files.length, artifacts: manifest.artifacts.length, mismatches }));
  if (!passed) process.exitCode = 1;
}

if (process.argv.includes("--freeze")) await freeze();
else await verify();
