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

function applyReference(taskId, root) {
  for (const step of REFERENCE_STEPS[taskId] ?? []) {
    const file = path.join(root, step.path);
    if (step.kind === "edit") {
      const current = fs.readFileSync(file, "utf8");
      if (!current.includes(step.from)) throw new Error(`reference edit missing in ${step.path}`);
      fs.writeFileSync(file, current.replace(step.from, step.to), "utf8");
    } else if (step.kind === "write") {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, step.content, "utf8");
    }
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
  return {
    passed: result.status === 0 && (!counts || counts.failed === 0),
    runtimeUnavailable,
    stderr,
  };
}

const tasks = [];
for (const locked of manifest.lockedTasks) {
  const taskPath = path.join(taskRoot, locked.sourceTaskId);
  const task = JSON.parse(fs.readFileSync(path.join(taskPath, "task.json"), "utf8"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), `r27-forgegreen-preflight-${locked.sourceTaskId}-`));
  try {
    copyTree(path.join(taskPath, task.fixture ?? "fixture"), workspace);
    copyTree(path.join(taskPath, task.hidden ?? "hidden"), path.join(workspace, task.hidden ?? "hidden"));
    applyReference(locked.sourceTaskId, workspace);
    const outcome = runVerifier(task, workspace);
    tasks.push({
      r27TaskId: locked.r27TaskId,
      category: locked.category,
      status: outcome.runtimeUnavailable ? "BLOCKED_ENVIRONMENT" : outcome.passed ? "REFERENCE_VERIFIER_PASS" : "REFERENCE_VERIFIER_FAIL",
      ...(outcome.runtimeUnavailable ? { reason: "Host runtime unavailable", stderr: outcome.stderr } : outcome.passed ? {} : { stderr: outcome.stderr }),
    });
  } catch (error) {
    tasks.push({ r27TaskId: locked.r27TaskId, category: locked.category, status: "PRECONDITION_ERROR", reason: String(error) });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

const summary = {
  total: tasks.length,
  referenceVerifierPassed: tasks.filter((task) => task.status === "REFERENCE_VERIFIER_PASS").length,
  blockedEnvironment: tasks.filter((task) => task.status === "BLOCKED_ENVIRONMENT").length,
  failures: tasks.filter((task) => task.status === "REFERENCE_VERIFIER_FAIL" || task.status === "PRECONDITION_ERROR").length,
};
const evidence = {
  schema: "r27-forgegreen-preflight-evidence-1",
  recordedAt: new Date().toISOString(),
  manifestVersion: manifest.manifestVersion,
  status: "R27_FORGEGREEN_PREFLIGHT_COMPLETE",
  classification: "DETERMINISTIC_PRECONDITION_ONLY",
  purpose: "Golden-fixture preflight only; this command does not create or replace ForgeGreen A/B evidence.",
  correction: "The former runner generated provider, token, context, tool, and wall-time values with hard-coded simulation profiles. Those values were not measured from ForgeGreen or AgentRuntime and cannot support an empirical A/B claim.",
  measured: {
    referenceFixtureVerifierEligibility: true,
    forgeGreenMechanismAB: false,
    adaptiveTopologyAB: false,
    liveModelValue: false,
  },
  requiredForAB: "Run identical production AgentRuntime/orchestrator arms with ForgeGreen OFF and ON, then persist their receipts. A deterministic scripted-provider run can prove mechanism behavior only; a live-model run is additionally required for live value.",
  summary,
  tasks,
};

const evidencePath = path.join(repo, "docs/evidence/r27-intelligence-perfection/R27-FORGREEN-PREFLIGHT-EVIDENCE.json");
const reportPath = path.join(repo, "docs/evidence/r27-intelligence-perfection/R27-FORGREEN-PREFLIGHT-REPORT.md");
fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
fs.writeFileSync(reportPath, `# R27 ForgeGreen Fixture Preflight\n\nStatus: \`R27_FORGEGREEN_PREFLIGHT_COMPLETE\`\n\nThis command verifies that the digest-locked golden-task reference fixtures are usable preconditions for a later A/B campaign. It does not instantiate ForgeGreen, AgentRuntime, or a model arm, and it never writes aggregate A/B evidence.\n\n- Reference verifier passes: ${summary.referenceVerifierPassed}/${summary.total}\n- Environment-blocked tasks: ${summary.blockedEnvironment}\n- Precondition failures: ${summary.failures}\n\nThe blocked Python tasks remain blocked rather than being counted as passes.\n`, "utf8");

console.log(JSON.stringify({ status: evidence.status, classification: evidence.classification, summary }, null, 2));
