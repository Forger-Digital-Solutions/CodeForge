#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const evidenceRoot = path.join(root, "docs/evidence/r30-release-unblocking");
const manifestPath = path.join(evidenceRoot, "R30-EVIDENCE-FREEZE.json");

async function walk(directory) {
  const result = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, item.name);
    if (item.isDirectory()) result.push(...await walk(absolute));
    else if (item.isFile()) result.push(absolute);
  }
  return result;
}

async function fileRecord(absolute) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(absolute)) {
    bytes += chunk.length;
    hash.update(chunk);
  }
  return {
    path: path.relative(root, absolute).replaceAll("\\", "/"),
    bytes,
    sha256: hash.digest("hex"),
  };
}

async function verify() {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const mismatches = [];
  for (const expected of [...manifest.files, ...manifest.artifacts]) {
    const absolute = path.resolve(root, expected.path);
    if (!absolute.startsWith(`${root}${path.sep}`)) throw new Error(`Evidence path escaped repository: ${expected.path}`);
    try {
      const actual = await fileRecord(absolute);
      if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) mismatches.push(expected.path);
    } catch {
      mismatches.push(expected.path);
    }
  }
  const passed = manifest.fileCount === manifest.files.length && mismatches.length === 0;
  console.log(JSON.stringify({ passed, evidenceFiles: manifest.files.length, artifacts: manifest.artifacts.length, mismatches }));
  if (!passed) process.exitCode = 1;
}

async function freeze() {
  const verdict = process.argv.find((arg) => arg.startsWith("--verdict="))?.slice("--verdict=".length);
  if (verdict !== "CODEFORGE_R30_RELEASE_BLOCKED" && verdict !== "CODEFORGE_R30_RELEASE_CANDIDATE_CERTIFIED") {
    throw new Error("An explicit R30 verdict is required.");
  }
  const certification = path.join(root, "docs/certification/codeforge-r30-release-unblocking-2026-09-24.md");
  const sources = [
    ...await walk(evidenceRoot),
    ...await walk(path.join(root, "benchmarks/r30")),
    certification,
  ].filter((file) => path.resolve(file) !== manifestPath);
  const files = await Promise.all(sources.sort().map(fileRecord));
  const artifactPaths = [
    "apps/desktop/release/win-unpacked/resources/app.asar",
    "apps/desktop/release/win-unpacked/CodeForge.exe",
    "apps/desktop/release/CodeForge-Setup-0.4.0.exe",
    "apps/desktop/release/CodeForge-Portable.exe",
  ];
  const artifacts = [];
  for (const relative of artifactPaths) {
    const absolute = path.join(root, relative);
    if (await stat(absolute).catch(() => null)) artifacts.push(await fileRecord(absolute));
  }
  const manifest = {
    schema: "r30-evidence-freeze-1",
    frozenAt: new Date().toISOString(),
    verdict,
    sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    certification: path.relative(root, certification).replaceAll("\\", "/"),
    fileCount: files.length,
    files,
    artifacts,
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify({ verdict, evidenceFiles: files.length, artifacts: artifacts.length }));
}

if (process.argv.includes("--verify")) await verify();
else await freeze();
