#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSessionPersistence } from "@codeforge/sessions";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixture = path.join(root, "packages/server/test/fixtures/run-recovery-worker.mjs");
const output = path.join(root, "docs/evidence/r66-everyday-free-readiness/R66-KILL-RESUME.json");
const scenarios = [
  { id: "model_then_write", steps: ["kill-before-first-call", "recover:kill-after-write", "recover:healthy"] },
  { id: "write_then_response", steps: ["kill-after-write", "recover:kill-after-write", "recover:healthy"] },
];

async function runProcess(args) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, [fixture, ...args], {
      cwd: root, env: { ...process.env, NODE_ENV: "test", CODEFORGE_ALLOW_TEST_PROVIDERS: "1" },
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => { stdout += String(data); });
    child.stderr.on("data", (data) => { stderr += String(data); });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`fixture timeout: ${args[0]}`)); }, 90_000);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ step: args[0], exitCode: code, signal, elapsedMs: Date.now() - started, stderrSample: stderr.slice(-500), stdoutBytes: stdout.length });
    });
  });
}

async function makeRepo(dir) {
  await mkdir(path.join(dir, "test"), { recursive: true });
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "r57-kill-resume", private: true, type: "module" }));
  await writeFile(path.join(dir, "math.mjs"), "export function multiply(a, b) { return 0; }\n");
  await writeFile(path.join(dir, "test/math.test.mjs"), "import test from 'node:test'; import assert from 'node:assert/strict'; import { multiply } from '../math.mjs'; test('multiply', () => assert.equal(multiply(6,7),42));\n");
  for (const args of [["init", "-b", "main"], ["config", "user.name", "CodeForge Agent"], ["config", "user.email", "agent@codeforge.local"], ["add", "."], ["commit", "-m", "Initial commit"]]) {
    execFileSync("git", args, { cwd: dir, stdio: "ignore", windowsHide: true });
  }
}

async function main() {
  const startedAt = new Date().toISOString();
  const campaignDir = await mkdtemp(path.join(root, "benchmarks/r66/tmp/kill-resume-"));
  const results = [];
  try {
    for (const scenario of scenarios) {
      const repoDir = path.join(campaignDir, scenario.id);
      await makeRepo(repoDir);
      const dbPath = path.join(repoDir, "session.db");
      const steps = [];
      for (const step of scenario.steps) {
        if (step === "recover:healthy") await new Promise((resolve) => setTimeout(resolve, 61_000));
        const result = await runProcess([step, dbPath, repoDir]);
        steps.push(result);
        if (step !== "recover:healthy") assert.ok(result.signal === "SIGKILL" || (process.platform === "win32" && result.exitCode !== 0 && !result.stderrSample.includes("Error:")), `${scenario.id}/${step} did not crash at the injected boundary: ${JSON.stringify(result)}`);
        else assert.equal(result.exitCode, 0, `${scenario.id} did not recover: ${result.stderrSample}`);
      }
      const db = createSessionPersistence({ dbPath });
      const workerItems = await db.getWorkItemsByKind("subagent_run");
      const journalItems = await db.getWorkItemsByKind("agent_run_journal");
      const writes = (await db.getWorkItemsByKind("agent_tool_execution")).filter((item) => item.toolName === "write_file" && item.state === "observation_recorded");
      const shillings = await db.getWorkItemsByKind("shilling_entry");
      const content = await readFile(path.join(repoDir, "math.mjs"), "utf8");
      await db.close();
      const correct = content.includes("return a * b");
      assert.equal(correct, true);
      assert.equal(workerItems.length, 1);
      assert.equal(workerItems[0].status, "completed");
      assert.equal(journalItems[0].state, "completed");
      assert.equal(writes.length, 1);
      results.push({ scenario: scenario.id, steps, restartCount: 2, killCount: 2, recoveryLeaseExpiryWaitMs: 61000, finalWorkerState: workerItems[0].status, finalJournalState: journalItems[0].state, observedWriteCount: writes.length, shillingEntryCount: shillings.length, correct, pass: true });
    }
    const result = {
      schema: "r66-worker-kill-resume-campaign/v1", startedAt, finishedAt: new Date().toISOString(),
      scope: "real process SIGKILL, production worker journal and SQLite, scripted test provider", evidenceClass: "ACTUAL_PROCESS_KILL_SCRIPTED_PROVIDER_WORKER_ONLY", parentEndToEndRecovery: "UNPROVEN", limitations: ["Worker recovery is not autonomous parent verification/integration recovery.", "This campaign reads the byte-preserved preexisting worker fixture without modifying it."],
      tasks: results, killCount: results.reduce((sum, row) => sum + row.killCount, 0),
      restartCount: results.reduce((sum, row) => sum + row.restartCount, 0),
      successfulResumptions: results.filter((row) => row.pass).length,
      duplicateObservedWrites: results.reduce((sum, row) => sum + Math.max(0, row.observedWriteCount - 1), 0),
      pass: results.length === scenarios.length && results.every((row) => row.pass),
    };
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify({ output, pass: result.pass, kills: result.killCount, restarts: result.restartCount, duplicateObservedWrites: result.duplicateObservedWrites }));
  } finally {
    // Preserve owned crash fixtures for review.
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
