#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { REFERENCE_STEPS } from "../r23/reference-solutions.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const manifest = JSON.parse(fs.readFileSync(path.join(here, "manifest.json"), "utf8"));
const taskRoot = path.join(repo, "benchmarks/r23/tasks");

function copyTree(source, destination) {
  fs.cpSync(source, destination, { recursive: true, force: true });
}

function edit(root, step) {
  const file = path.join(root, step.path);
  const current = fs.readFileSync(file, "utf8");
  if (!current.includes(step.from)) throw new Error(`reference edit missing in ${step.path}`);
  fs.writeFileSync(file, current.replace(step.from, step.to), "utf8");
}

function applyReference(taskId, root) {
  for (const step of REFERENCE_STEPS[taskId] ?? []) {
    if (step.kind === "edit") edit(root, step);
    else if (step.kind === "write") {
      const file = path.join(root, step.path);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, step.content, "utf8");
    } else throw new Error(`unknown reference step for ${taskId}`);
  }
}

function runVerifier(task, workspace) {
  const result = spawnSync(task.verifier.command, {
    cwd: workspace,
    shell: true,
    encoding: "utf8",
    timeout: task.verifier.timeoutMs ?? 120_000,
    windowsHide: true,
  });
  const summary = (result.stdout ?? "").trim().split(/\r?\n/).pop() ?? "";
  let counts;
  try { counts = JSON.parse(summary); } catch { counts = undefined; }
  const stderr = (result.stderr ?? "").trim().slice(-600);
  const runtimeUnavailable = /not recognized as an internal or external command|command not found|ENOENT/i.test(stderr);
  return { status: result.status, counts, stderr, runtimeUnavailable };
}

const rows = [];
for (const locked of manifest.lockedTasks) {
  const task = JSON.parse(fs.readFileSync(path.join(taskRoot, locked.sourceTaskId, "task.json"), "utf8"));
  const fixture = path.join(taskRoot, locked.sourceTaskId, task.fixture ?? "fixture");
  const untouched = fs.mkdtempSync(path.join(os.tmpdir(), `r27-untouched-${locked.sourceTaskId}-`));
  const solved = fs.mkdtempSync(path.join(os.tmpdir(), `r27-solved-${locked.sourceTaskId}-`));
  let untouchedResult;
  let solvedResult;
  let referenceError;
  try {
    copyTree(fixture, untouched);
    copyTree(path.join(taskRoot, locked.sourceTaskId, task.hidden ?? "hidden"), path.join(untouched, task.hidden ?? "hidden"));
    untouchedResult = runVerifier(task, untouched);
    copyTree(fixture, solved);
    copyTree(path.join(taskRoot, locked.sourceTaskId, task.hidden ?? "hidden"), path.join(solved, task.hidden ?? "hidden"));
    try {
      applyReference(locked.sourceTaskId, solved);
      solvedResult = runVerifier(task, solved);
    } catch (error) {
      referenceError = String(error instanceof Error ? error.message : error);
      solvedResult = { status: null, counts: undefined, stderr: referenceError };
    }
  } finally {
    fs.rmSync(untouched, { recursive: true, force: true });
    fs.rmSync(solved, { recursive: true, force: true });
  }
  const investigation = task.class === "investigation";
  const untouchedExpected = investigation ? untouchedResult.status === 0 : untouchedResult.status !== 0;
  const solvedPasses = solvedResult.status === 0 && (!solvedResult.counts || solvedResult.counts.failed === 0);
  const blockedEnvironment = untouchedResult.runtimeUnavailable || solvedResult.runtimeUnavailable;
  rows.push({
    r27TaskId: locked.r27TaskId,
    sourceTaskId: locked.sourceTaskId,
    category: locked.category,
    untouched: { status: untouchedResult.status, expected: investigation ? "pass" : "fail", observed: untouchedExpected, stderr: untouchedResult.stderr },
    reference: { status: solvedResult.status, expected: "pass", observed: solvedPasses, stderr: solvedResult.stderr, error: referenceError },
    status: blockedEnvironment ? "BLOCKED_ENVIRONMENT" : (untouchedExpected && solvedPasses ? "PASS" : "FAIL"),
    ok: !blockedEnvironment && untouchedExpected && solvedPasses,
  });
}

const failures = rows.filter((row) => !row.ok);
const blocked = rows.filter((row) => row.status === "BLOCKED_ENVIRONMENT");
const report = {
  schemaVersion: "r27-golden-task-validation-1",
  validatedAt: new Date().toISOString(),
  manifestVersion: manifest.manifestVersion,
  taskCount: rows.length,
  failures: failures.length,
  blocked: blocked.length,
  rows,
  status: failures.length > blocked.length ? "FAIL" : (blocked.length > 0 ? "PARTIAL" : "PASS"),
};
const output = path.join(repo, "docs/evidence/r27-intelligence-perfection/R27-GOLDEN-TASK-VALIDATION.json");
fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ status: report.status, taskCount: report.taskCount, failures: report.failures, blocked: report.blocked, output }, null, 2));
process.exitCode = failures.length > blocked.length ? 1 : (blocked.length > 0 ? 2 : 0);
