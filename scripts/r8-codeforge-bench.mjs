#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const value = args.find((arg) => arg.startsWith(`--${name}=`));
  return value ? value.slice(name.length + 3) : fallback;
};
const attemptsPath = option("attempts", null);
const output = resolve(option("out", "docs/evidence/r8-intelligence-benchmark/results/codeforge-bench-r1-pre-optimization.json"));
const benchmark = await import(pathToFileURL(resolve("packages/benchmark/dist/index.js")).href);

const attempts = attemptsPath ? JSON.parse(await readFile(resolve(attemptsPath), "utf8")) : [];
if (!Array.isArray(attempts)) throw new Error("--attempts must reference a JSON array of CodeForgeBench attempts");

const result = {
  schemaVersion: 1,
  benchmarkVersion: benchmark.CODEFORGE_BENCH_R1_VERSION,
  generatedAt: new Date().toISOString(),
  phase: "CODEFORGE_R8_PRE_OPTIMIZATION_BASELINE",
  executionStatus: attempts.length === 0 ? "NO_MODEL_EXECUTIONS_RECORDED" : "ATTEMPTS_RECORDED",
  evidencePolicy: "Only independently verified, non-rejected attempts count as successes. Empty or blocked live-route evidence is preserved rather than imputed.",
  liveExecutionLimitation: attempts.length === 0
    ? "No R8 model execution is recorded by this manifest. R7's Groq managed-free run ended blocked and paid routes were not authorised; use --attempts only with sanitised, independently verified records."
    : null,
  cases: benchmark.CODEFORGE_BENCH_R1_CASES,
  summary: benchmark.summarizeCodeForgeBenchR1(attempts),
  attempts,
};
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
process.stdout.write(`${output}\n`);
