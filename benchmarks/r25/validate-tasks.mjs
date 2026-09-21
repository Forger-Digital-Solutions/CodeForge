#!/usr/bin/env node
/**
 * R25 corpus validation (same rule as r23 §4.3): for every mutating task the unmodified fixture
 * must FAIL its hidden verifier (the defect is real and detected) and a reference solution must
 * PASS (the verifier is satisfiable and the task is well-posed). Read-only roles (reviewer,
 * explorer) keep an intact-tree verifier: the fixture must PASS it, and the reference answer must
 * satisfy the answer key.
 *
 *   node benchmarks/r25/validate-tasks.mjs
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
  const verifyRoot = fs.mkdtempSync(path.join(os.tmpdir(), `r25-validate-${task.taskId}-`));
  copyTree(workspace, verifyRoot);
  copyTree(path.join(TASKS_ROOT, task.taskId, task.hidden ?? "hidden"), path.join(verifyRoot, task.hidden ?? "hidden"));
  const result = spawnSync(task.verifier.command, { cwd: verifyRoot, shell: true, encoding: "utf8", timeout: task.verifier.timeoutMs ?? 120_000, windowsHide: true });
  fs.rmSync(verifyRoot, { recursive: true, force: true });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const READ_ONLY_ROLES = new Set(["explorer", "reviewer"]);
const tasks = fs.readdirSync(TASKS_ROOT, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".") && !e.name.startsWith("_")).map((e) => e.name).sort();
let failures = 0;
for (const taskId of tasks) {
  const task = JSON.parse(fs.readFileSync(path.join(TASKS_ROOT, taskId, "task.json"), "utf8"));
  const readOnly = READ_ONLY_ROLES.has(task.role);
  const fixtureDir = path.join(TASKS_ROOT, taskId, task.fixture ?? "fixture");

  const raw = runVerifier(task, fixtureDir);
  const rawExpectPass = readOnly; // mutating tasks must fail on the unmodified fixture
  const rawOk = rawExpectPass ? raw.status === 0 : raw.status !== 0;

  const refRoot = fs.mkdtempSync(path.join(os.tmpdir(), `r25-ref-${taskId}-`));
  copyTree(fixtureDir, refRoot);
  applyReference(taskId, refRoot);
  const ref = runVerifier(task, refRoot);
  fs.rmSync(refRoot, { recursive: true, force: true });
  const refOk = ref.status === 0;

  let keyOk = true;
  if (task.answerKey) {
    const answer = REFERENCE_ANSWERS[taskId];
    keyOk = typeof answer === "string" && answerMatches(answer, task.answerKey);
  }

  const ok = rawOk && refOk && keyOk;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${taskId} (fixture ${raw.status === 0 ? "pass" : "fail"} expected ${rawExpectPass ? "pass" : "fail"}; reference ${ref.status === 0 ? "pass" : "fail"}; answerKey ${keyOk ? "ok" : "mismatch"})`);
  if (!ok && raw.stderr) console.log(`  fixture stderr: ${raw.stderr.trim().split("\n").pop()}`);
  if (!ok && ref.stderr) console.log(`  reference stderr: ${ref.stderr.trim().split("\n").pop()}`);
}
console.log(failures === 0 ? `all ${tasks.length} tasks well-posed` : `${failures} task(s) failed validation`);
process.exit(failures === 0 ? 0 : 1);
