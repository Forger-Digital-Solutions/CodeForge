#!/usr/bin/env node
/**
 * R23 corpus validation (protocol §4.3): for every task the unmodified fixture must FAIL its hidden
 * verifier (the defect is real and detected) and a reference solution must PASS (the verifier is
 * satisfiable and the task is well-posed). Investigation tasks are read-only: the fixture passes
 * the tree-intact verifier and the reference answer must satisfy the answer key.
 *
 *   node benchmarks/r23/validate-tasks.mjs
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const TASKS_ROOT = path.join(here, "tasks");

function copyTree(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  fs.cpSync(source, destination, { recursive: true, force: true });
}

function edit(root, relative, from, to) {
  const file = path.join(root, relative);
  const source = fs.readFileSync(file, "utf8");
  if (!source.includes(from)) throw new Error(`reference edit: ${relative} does not contain ${JSON.stringify(from)}`);
  fs.writeFileSync(file, source.replace(from, to));
}

function write(root, relative, content) {
  fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  fs.writeFileSync(path.join(root, relative), content);
}

import { REFERENCE_ANSWERS, REFERENCE_STEPS } from "./reference-solutions.mjs";

/** Apply a task's declarative reference steps to a workspace copy. */
function applyReference(taskId, root) {
  for (const step of REFERENCE_STEPS[taskId] ?? []) {
    if (step.kind === "edit") edit(root, step.path, step.from, step.to);
    else if (step.kind === "write") write(root, step.path, step.content);
    else throw new Error(`unknown reference step kind ${String(step.kind)}`);
  }
}

function answerMatches(summary, key) {
  const haystack = key.caseInsensitive === false ? summary : summary.toLowerCase();
  if (key.mode === "all_substrings") return key.values.every((value) => haystack.includes(key.caseInsensitive === false ? value : value.toLowerCase()));
  return key.values.every((value) => new RegExp(value, key.caseInsensitive === false ? "" : "i").test(summary));
}

function runVerifier(task, workspace) {
  const verifyRoot = fs.mkdtempSync(path.join(os.tmpdir(), `r23-validate-${task.taskId}-`));
  copyTree(workspace, verifyRoot);
  copyTree(path.join(TASKS_ROOT, task.taskId, task.hidden ?? "hidden"), path.join(verifyRoot, task.hidden ?? "hidden"));
  const result = spawnSync(task.verifier.command, { cwd: verifyRoot, shell: true, encoding: "utf8", timeout: task.verifier.timeoutMs ?? 120_000, windowsHide: true });
  fs.rmSync(verifyRoot, { recursive: true, force: true });
  const summaryLine = (result.stdout ?? "").trim().split(/\r?\n/).pop() ?? "";
  let counts;
  try { counts = JSON.parse(summaryLine); } catch { counts = undefined; }
  return { status: result.status, counts, stderr: (result.stderr ?? "").trim().slice(-600) };
}

const taskIds = fs.readdirSync(TASKS_ROOT).filter((name) => fs.statSync(path.join(TASKS_ROOT, name)).isDirectory()).sort();
let failures = 0;
const rows = [];
for (const taskId of taskIds) {
  const task = JSON.parse(fs.readFileSync(path.join(TASKS_ROOT, taskId, "task.json"), "utf8"));
  const fixtureRoot = path.join(TASKS_ROOT, taskId, task.fixture ?? "fixture");
  const investigation = task.class === "investigation";

  const untouched = fs.mkdtempSync(path.join(os.tmpdir(), `r23-fixture-${taskId}-`));
  copyTree(fixtureRoot, untouched);
  const before = runVerifier(task, untouched);
  fs.rmSync(untouched, { recursive: true, force: true });
  const beforeOk = investigation ? before.status === 0 : before.status !== 0;

  const solved = fs.mkdtempSync(path.join(os.tmpdir(), `r23-solved-${taskId}-`));
  copyTree(fixtureRoot, solved);
  let afterOk = false;
  let after = { status: null, counts: undefined, stderr: "" };
  let answerOk = true;
  try {
    applyReference(taskId, solved);
    after = runVerifier(task, solved);
    afterOk = after.status === 0 && (!after.counts || after.counts.failed === 0);
    if (task.answerKey) answerOk = answerMatches(REFERENCE_ANSWERS[taskId] ?? "", task.answerKey);
  } catch (error) {
    after = { status: null, counts: undefined, stderr: String(error.message) };
  }
  fs.rmSync(solved, { recursive: true, force: true });

  const ok = beforeOk && afterOk && answerOk;
  if (!ok) failures += 1;
  rows.push({ taskId, class: task.class, fixtureFailsAsShipped: investigation ? "n/a (read-only; tree-intact verifier passes)" : beforeOk, referencePasses: afterOk, answerKeySatisfied: task.answerKey ? answerOk : "n/a", beforeCounts: before.counts, afterCounts: after.counts, ok });
  console.log(`${ok ? "OK  " : "FAIL"} ${taskId.padEnd(40)} as-shipped=${before.status} (${before.counts ? `${before.counts.passed}/${before.counts.passed + before.counts.failed}` : "-"}) reference=${after.status} (${after.counts ? `${after.counts.passed}/${after.counts.passed + after.counts.failed}` : "-"})${task.answerKey ? ` answer=${answerOk}` : ""}`);
  if (!ok) console.log(`     before.stderr: ${before.stderr}\n     after.stderr: ${after.stderr}`);
}
const outDir = path.resolve(here, "../../docs/evidence/r23-efficiency-proof/pilot");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "corpus-validation.json"), `${JSON.stringify({ validatedAt: new Date().toISOString(), tasks: rows, failures }, null, 2)}\n`);
console.log(`\n${taskIds.length - failures}/${taskIds.length} tasks valid; report → ${path.relative(process.cwd(), path.join(outDir, "corpus-validation.json"))}`);
process.exit(failures === 0 ? 0 : 1);
