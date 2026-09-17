#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const value = args.find((arg) => arg.startsWith(`--${name}=`));
  return value ? value.slice(name.length + 3) : fallback;
};

const phase = option("phase", "PRE");
if (phase !== "PRE" && phase !== "POST") throw new Error("--phase must be PRE or POST");
const split = option("split", "ALL");
const validSplits = new Set(["ALL", "TRAIN", "DEVELOPMENT", "VALIDATION", "PROTECTED_TEST"]);
if (!validSplits.has(split)) throw new Error(`--split must be one of ${[...validSplits].join(", ")}`);

const attemptsPath = option("attempts", null);
const executorPath = option("executor", null);
if (attemptsPath && executorPath) throw new Error("Use either --attempts to score recorded evidence or --executor to execute a campaign, not both");
const output = resolve(option("out", `docs/evidence/r9-capability-campaign/results/codeforge-bench-r2-${phase.toLowerCase()}.json`));
const benchmark = await import(pathToFileURL(resolve("packages/benchmark/dist/index.js")).href);
const gitValue = (args) => {
  try {
    return execFileSync("git", args, { encoding: "utf8" }).trim();
  } catch {
    return "UNAVAILABLE";
  }
};
const repositoryCommit = option("repository-commit", gitValue(["rev-parse", "HEAD"]));
const codeforgeCommit = option("codeforge-commit", gitValue(["rev-parse", "HEAD"]));
const configDigest = option("config-digest", "");
const mode = option("mode", "fixed_route");
const modes = new Set(["default", "best_reasonable", "fixed_route", "auto", "topology"]);
if (!modes.has(mode)) throw new Error(`--mode must be one of ${[...modes].join(", ")}`);
let attempts = attemptsPath ? JSON.parse(await readFile(resolve(attemptsPath), "utf8")) : [];
if (!Array.isArray(attempts)) throw new Error("--attempts must reference a JSON array of CodeForgeBench R2 attempts");

const selectedCases = split === "ALL" ? benchmark.CODEFORGE_BENCH_R2_CASES : benchmark.CODEFORGE_BENCH_R2_CASES.filter((item) => item.split === split);
if (executorPath) {
  if (!configDigest) throw new Error("--config-digest is required when executing a campaign");
  const module = await import(pathToFileURL(resolve(executorPath)).href);
  const executor = module.default ?? module;
  if (typeof executor.executeCase !== "function") {
    throw new Error("--executor must export an executeCase(context) function, either directly or as its default export");
  }
  attempts = await benchmark.runCodeForgeBenchR2Campaign({
    executor,
    repositoryCommit,
    codeforgeCommit,
    configDigest,
    mode,
    split,
  });
}
benchmark.validateCodeForgeBenchR2Attempts(attempts);
const selectedCaseIds = new Set(selectedCases.map((item) => item.id));
const selectedAttempts = attempts.filter((attempt) => selectedCaseIds.has(attempt.caseId));

const result = {
  schemaVersion: 2,
  benchmarkVersion: benchmark.CODEFORGE_BENCH_R2_VERSION,
  generatedAt: new Date().toISOString(),
  phase: `CODEFORGE_R9_${phase}_CAPABILITY_BENCHMARK`,
  evaluatedSplit: split,
  sourceState: {
    repositoryCommit: gitValue(["rev-parse", "HEAD"]),
    branch: gitValue(["branch", "--show-current"]),
  },
  executionStatus: selectedAttempts.length === 0 ? "NO_MODEL_EXECUTIONS_RECORDED" : executorPath ? "EXECUTED_BY_RUNNER" : "ATTEMPTS_RECORDED",
  evidencePolicy: "Only completed, independently verified, non-rejected attempts count as successes. Blocked, failed, unrun, and hidden-test failures remain visible and are never imputed.",
  traceabilityPolicy: "Each attempt must carry a run id, repository commit, CodeForge commit, config digest, timestamp, model/route where applicable, and independent verification evidence.",
  splitPolicy: {
    TRAIN: "Allowed for curriculum and tuning.",
    DEVELOPMENT: "Used during engineering iteration.",
    VALIDATION: "Used for policy/model/router selection.",
    PROTECTED_TEST: "Reserved for final evaluation; do not use for training or routine iteration.",
  },
  cases: selectedCases,
  summary: benchmark.summarizeCodeForgeBenchR2(selectedAttempts, selectedCases),
  attempts: selectedAttempts,
};
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
process.stdout.write(`${output}\n`);
