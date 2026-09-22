#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const manifest = JSON.parse(fs.readFileSync(path.join(here, "manifest.json"), "utf8"));
const sourceManifest = JSON.parse(fs.readFileSync(path.join(repo, "benchmarks/r23/manifest.json"), "utf8"));
const sourceById = new Map(sourceManifest.tasks.map((task) => [task.taskId, task]));

function listFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else files.push(path.relative(root, absolute).replaceAll(path.sep, "/"));
    }
  };
  visit(root);
  return files;
}

function treeDigest(root) {
  const digest = crypto.createHash("sha256");
  for (const relative of listFiles(root)) {
    digest.update(relative);
    digest.update("\0");
    digest.update(fs.readFileSync(path.join(root, relative)));
    digest.update("\0");
  }
  return digest.digest("hex");
}

const rows = [];
for (const locked of manifest.lockedTasks) {
  const source = sourceById.get(locked.sourceTaskId);
  const taskRoot = path.join(repo, "benchmarks/r23/tasks", locked.sourceTaskId);
  const taskFile = path.join(taskRoot, "task.json");
  const actualTask = fs.existsSync(taskFile) ? JSON.parse(fs.readFileSync(taskFile, "utf8")) : undefined;
  const actualDigest = fs.existsSync(taskRoot) ? treeDigest(taskRoot) : undefined;
  const checks = {
    sourceManifestEntry: Boolean(source),
    sourceManifestDigest: source?.digest === locked.sourceManifestDigest,
    taskId: actualTask?.taskId === locked.sourceTaskId,
    fixturePresent: Boolean(actualTask?.fixture && fs.existsSync(path.join(taskRoot, actualTask.fixture))),
    hiddenVerifierPresent: Boolean(actualTask?.hidden && fs.existsSync(path.join(taskRoot, actualTask.hidden))),
    treeDigest: actualDigest === locked.treeDigest,
  };
  rows.push({
    r27TaskId: locked.r27TaskId,
    sourceTaskId: locked.sourceTaskId,
    category: locked.category,
    actualTreeDigest: actualDigest,
    checks,
    ok: Object.values(checks).every(Boolean),
  });
}

const failures = rows.filter((row) => !row.ok);
const report = {
  schemaVersion: "r27-golden-manifest-validation-1",
  validatedAt: new Date().toISOString(),
  manifestVersion: manifest.manifestVersion,
  sourceManifestVersion: sourceManifest.manifestVersion,
  taskCount: rows.length,
  failures: failures.length,
  rows,
  status: failures.length === 0 ? "PASS" : "FAIL",
};
const output = path.join(repo, "docs/evidence/r27-intelligence-perfection/R27-GOLDEN-MANIFEST-VALIDATION.json");
fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ status: report.status, taskCount: report.taskCount, failures: report.failures, output }, null, 2));
process.exitCode = failures.length === 0 ? 0 : 1;
