#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const r30Head = "fe4248c4c8dc664ef88cdb80acf5e91ae99961fb";
const manifestPaths = [
  "docs/evidence/r28-capability-completion/R28-EVIDENCE-FREEZE.json",
  "docs/evidence/r29-release-closure/R29-EVIDENCE-FREEZE.json",
  "docs/evidence/r30-release-unblocking/R30-EVIDENCE-FREEZE.json",
];
const r30ArtifactReceipt = "docs/evidence/r30-release-unblocking/14-release-artifacts/artifacts.json";
const outputPath = "docs/evidence/r31-production-release-closure/00-recovery/inherited-baseline.json";

function git(...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function resolveInside(relative) {
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

async function verifyEntry(entry) {
  try {
    const actual = await hashFile(entry.path);
    return actual.bytes === entry.bytes && actual.sha256 === entry.sha256
      ? null
      : { path: entry.path, expectedBytes: entry.bytes, actualBytes: actual.bytes, expectedSha256: entry.sha256, actualSha256: actual.sha256 };
  } catch (error) {
    return { path: entry.path, error: error instanceof Error ? error.message : String(error) };
  }
}

async function verifyManifest(relative) {
  const manifest = JSON.parse(await readFile(resolveInside(relative), "utf8"));
  const entries = [...manifest.files, ...(manifest.artifacts ?? [])];
  const mismatches = (await Promise.all(entries.map(verifyEntry))).filter(Boolean);
  return {
    path: relative,
    manifestSha256: (await hashFile(relative)).sha256,
    verdict: manifest.verdict,
    declaredEvidenceFiles: manifest.fileCount,
    listedEvidenceFiles: manifest.files.length,
    listedArtifacts: manifest.artifacts?.length ?? 0,
    checked: entries.length,
    mismatches,
    passed: manifest.fileCount === manifest.files.length && mismatches.length === 0,
  };
}

const head = git("rev-parse", "HEAD");
const ancestry = execFileSync("git", ["merge-base", "--is-ancestor", r30Head, head], { cwd: root, stdio: "ignore" });
void ancestry;
const freezes = await Promise.all(manifestPaths.map(verifyManifest));
const receipt = JSON.parse(await readFile(resolveInside(r30ArtifactReceipt), "utf8"));
const artifacts = await Promise.all(receipt.Artifacts.map(async (artifact) => {
  const actual = await hashFile(artifact.Path);
  return {
    ...actual,
    matchesR30Receipt: actual.bytes === artifact.Bytes && actual.sha256 === artifact.Sha256,
  };
}));
const preEditCleanObserved = process.argv.includes("--pre-edit-clean-observed");
const result = {
  schema: "r31-inherited-baseline-1",
  checkedAt: new Date().toISOString(),
  repositoryRoot: root.replaceAll("\\", "/"),
  branch: git("branch", "--show-current"),
  head,
  r30Head,
  r30HeadIsAncestor: true,
  preEditCleanObserved,
  currentWorkingTreeClean: git("status", "--porcelain=v1", "--untracked-files=all") === "",
  recentCommits: git("log", "-4", "--format=%H %s").split(/\r?\n/),
  historicalFreezes: freezes,
  r30ProductSourceCommit: receipt.SourceCommit,
  r30Artifacts: artifacts,
  environment: {
    platform: process.platform,
    release: os.release(),
    arch: process.arch,
    logicalProcessors: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    nodeVersion: process.version,
  },
};
const passed = freezes.every((freeze) => freeze.passed) && artifacts.length === 4 && artifacts.every((artifact) => artifact.matchesR30Receipt);
if (process.argv.includes("--output")) {
  const absolute = resolveInside(outputPath);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, `${JSON.stringify(result, null, 2)}\n`);
}
console.log(JSON.stringify({ passed, head, freezes: freezes.map(({ listedEvidenceFiles, listedArtifacts, passed: freezePassed }) => ({ evidenceFiles: listedEvidenceFiles, artifacts: listedArtifacts, passed: freezePassed })), r30ArtifactsMatched: artifacts.filter((artifact) => artifact.matchesR30Receipt).length }));
if (!passed) process.exitCode = 1;
