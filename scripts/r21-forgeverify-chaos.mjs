// R21 ForgeVerify crash-chaos and multi-instance campaign.
//
// For every kill point the campaign requires, a real worker process (A) runs a real verification
// with durable persistence, is SIGKILLed at exactly that lifecycle marker, and a fresh gate
// process (C) — sharing only the database — performs production restart recovery and asks the
// completion authority for a verdict. Invariant under test: zero false completion. A passing and
// a failing verifier are both swept; a completion is legitimate only when a genuine PASS record
// was durably persisted before the kill and the workspace is unchanged.
//
// With `--pg` the shared database is real PostgreSQL, which makes A and C independent processes
// with independent connections: the multi-instance proof (agent work → worker verification →
// PostgreSQL evidence → gate on another instance).
//
// Usage: node scripts/r21-forgeverify-chaos.mjs [--pg] [--out <dir>]
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const args = process.argv.slice(2);
const usePg = args.includes("--pg");
const outDir = args.includes("--out") ? args[args.indexOf("--out") + 1] : path.join(root, "docs", "evidence", "r21-intelligence-closure", "01-forgeverify");
const pgUrl = process.env.CODEFORGE_TEST_POSTGRES_URL;
if (usePg && !pgUrl) throw new Error("--pg requires CODEFORGE_TEST_POSTGRES_URL");

const KILL_POINTS = [
  ["before_verification_starts", "WORKER_READY"],
  ["after_process_spawn", "ATTEMPT_STARTED"],
  ["during_tests", "ATTEMPT_STARTED+600ms"],
  ["after_tests_exit", "TESTS_EXITED"],
  ["before_receipt_persistence", "TESTS_EXITED"],
  ["after_receipt_persistence", "EVIDENCE_PERSISTED"],
  ["before_completion_gate", "GATE_START"],
  ["during_completion_gate", "GATE_START+5ms"],
  ["no_kill_control", null],
];

const GIT = ["-c", "user.email=r21@codeforge.test", "-c", "user.name=r21", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false"];
function makeWorkspace(passing) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r21-chaos-ws-"));
  fs.writeFileSync(path.join(dir, "src.js"), "module.exports = { value: 1 };\n");
  fs.writeFileSync(path.join(dir, "test.cjs"), `const m = require('./src.js'); setTimeout(() => { if (m.value !== 1 || ${passing ? "false" : "true"}) { console.log('Tests: 1 failed, 0 passed, 1 total'); process.exit(1); } console.log('Tests: 0 failed, 1 passed, 1 total'); process.exit(0); }, 1500);`);
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "r21-chaos", version: "0.0.0", private: true }));
  execFileSync("git", [...GIT, "init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", [...GIT, "add", "-A"], { cwd: dir });
  execFileSync("git", [...GIT, "commit", "-q", "-m", "base"], { cwd: dir });
  return dir;
}

function runProcess(script, argv, { killAt } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(here, script), ...argv], { cwd: root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const markers = [];
    let stdout = "";
    let stderr = "";
    let killed = false;
    let killedAt = null;
    const startedAt = Date.now();
    const kill = (marker) => {
      if (killed) return;
      killed = true;
      killedAt = { marker, atMs: Date.now() - startedAt };
      child.kill("SIGKILL");
    };
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      for (const line of chunk.toString().split(/\r?\n/)) {
        const match = /^R21_MARK (\S+)/.exec(line);
        if (!match) continue;
        markers.push({ marker: match[1], atMs: Date.now() - startedAt });
        if (!killAt) continue;
        const [wanted, delay] = killAt.split("+");
        if (match[1] === wanted) {
          if (delay) setTimeout(() => kill(`${wanted}+${delay}`), Number.parseInt(delay, 10));
          else kill(wanted);
        }
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("exit", (code, signal) => resolve({ code, signal, killed, killedAt, markers, stdout, stderr: stderr.slice(-2000), durationMs: Date.now() - startedAt }));
  });
}

function parse(prefix, stdout) {
  const line = stdout.split(/\r?\n/).find((entry) => entry.startsWith(`${prefix} `));
  return line ? JSON.parse(line.slice(prefix.length + 1)) : null;
}

const results = [];
const sqliteDir = usePg ? null : fs.mkdtempSync(path.join(os.tmpdir(), "r21-chaos-db-"));
for (const passing of [false, true]) {
  for (const [point, killAt] of KILL_POINTS) {
    for (const mutate of point === "no_kill_control" || point === "after_receipt_persistence" ? [false, true] : [false]) {
      const workspace = makeWorkspace(passing);
      const sessionId = `r21-chaos-${passing ? "pass" : "fail"}-${point}-${mutate ? "mutated" : "stable"}-${randomUUID().slice(0, 8)}`;
      const backend = usePg ? "pg" : "sqlite";
      const dbTarget = usePg ? pgUrl : path.join(sqliteDir, `${sessionId}.db`);
      const worker = await runProcess("r21-forgeverify-worker.mjs", [backend, dbTarget, sessionId, workspace], { killAt });
      const gate = await runProcess("r21-forgeverify-gate.mjs", [backend, dbTarget, sessionId, workspace, ...(mutate ? ["--mutate"] : [])]);
      const gateResult = parse("R21_GATE", gate.stdout);
      const workerResult = parse("R21_RESULT", worker.stdout);
      // A completion is legitimate only if a genuine passing record was durably persisted AND the
      // workspace is unchanged since. Anything else that says "completed" is a false completion.
      const genuinePassPersisted = passing && (gateResult?.evidenceStatuses ?? []).includes("passed");
      const legitimateCompletion = genuinePassPersisted && !mutate;
      const falseCompletion = (gateResult?.structuredOutcome === "completed" || gateResult?.legacyOutcome === "completed" || (gateResult?.reuse?.verificationComplete === true && gateResult?.reuse?.freshExecutions === 0)) && !legitimateCompletion;
      results.push({
        verifier: passing ? "passing" : "failing",
        killPoint: point,
        killAt,
        mutatedAfterVerification: mutate,
        worker: { exit: worker.code, signal: worker.signal, killed: worker.killed, killedAt: worker.killedAt, markers: worker.markers.map((m) => m.marker), result: workerResult, durationMs: worker.durationMs },
        gate: gateResult,
        gateProcessExit: gate.code,
        legitimateCompletion,
        falseCompletion,
        ...(gate.code !== 0 ? { gateStderr: gate.stderr } : {}),
      });
      process.stdout.write(`${passing ? "PASS" : "FAIL"} ${point}${mutate ? " (mutated)" : ""}: killed=${worker.killed} evidence=${gateResult?.evidencePersisted} structured=${gateResult?.structuredOutcome} legacy=${gateResult?.legacyOutcome} reuse=${JSON.stringify(gateResult?.reuse)} falseCompletion=${falseCompletion}\n`);
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  }
}
if (sqliteDir) fs.rmSync(sqliteDir, { recursive: true, force: true });

const summary = {
  schemaVersion: 1,
  campaign: "R21 ForgeVerify crash-chaos" + (usePg ? " + multi-instance (PostgreSQL)" : " (SQLite)"),
  recordedAt: new Date().toISOString(),
  backend: usePg ? "postgresql" : "sqlite",
  processes: "worker A (verify + persist) → SIGKILL at marker → gate C (fresh process: production restart recovery, durable reload, completion authority)",
  cases: results.length,
  killedCases: results.filter((r) => r.worker.killed).length,
  falseCompletions: results.filter((r) => r.falseCompletion).length,
  legitimateCompletions: results.filter((r) => r.legitimateCompletion && (r.gate?.structuredOutcome === "completed")).length,
  gateProcessFailures: results.filter((r) => r.gateProcessExit !== 0).length,
  results,
};
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, usePg ? "forgeverify-chaos-multi-instance-postgres.json" : "forgeverify-chaos-sqlite.json");
fs.writeFileSync(outFile, `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`\nR21 chaos: ${summary.cases} cases, ${summary.killedCases} killed, falseCompletions=${summary.falseCompletions}, gateProcessFailures=${summary.gateProcessFailures} → ${outFile}\n`);
process.exit(summary.falseCompletions === 0 && summary.gateProcessFailures === 0 ? 0 : 1);
