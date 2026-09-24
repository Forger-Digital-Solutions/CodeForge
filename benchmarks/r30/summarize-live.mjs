#!/usr/bin/env node
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const directory = path.join(root, "docs/evidence/r30-release-unblocking/04-large-task-benchmarks");
const entries = [];
for (const name of (await readdir(directory)).filter((name) => /^r30-live-.*\.json$/.test(name)).sort()) {
  const receipt = JSON.parse(await readFile(path.join(directory, name), "utf8"));
  entries.push({
    receipt: name,
    runId: receipt.runId,
    taskId: receipt.task.sourceTaskId,
    taskClass: receipt.task.taskClass,
    providerId: receipt.configuration.providerId,
    modelId: receipt.configuration.modelId,
    workflowStatus: receipt.workflow.status,
    completionOutcome: receipt.workflow.completion?.outcome ?? null,
    independentVerifierPassed: receipt.verification.hidden.passed,
    autonomousPass: receipt.workflow.status === "completed" && receipt.workflow.completion?.outcome === "completed" && receipt.verification.hidden.passed,
    wallClockMs: receipt.timing.wallClockMs,
    modelRequests: receipt.provider.inferenceRequestCount,
    toolCalls: receipt.eventTypes["tool.call_started"] ?? 0,
    failedToolExecutions: receipt.eventTypes["tool.execution_failed"] ?? 0,
    inputTokens: receipt.provider.measuredInputTokens ?? null,
    outputTokens: receipt.provider.measuredOutputTokens ?? null,
    tokenUsageUnknownRequests: receipt.provider.requestsWithoutTokenUsage ?? null,
    changedPaths: receipt.workflow.changedFileSnapshots?.map((snapshot) => snapshot.path) ?? receipt.workflow.diffs?.map((diff) => diff.path) ?? [],
    injected429Count: receipt.provider.injected429Count ?? 0,
    humanTaskIntervention: "none",
  });
}
const summary = {
  schema: "r30-live-task-summary-1",
  generatedAt: new Date().toISOString(),
  attemptCount: entries.length,
  autonomousPasses: entries.filter((entry) => entry.autonomousPass).length,
  entries,
};
await writeFile(path.join(directory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify({ attempts: summary.attemptCount, autonomousPasses: summary.autonomousPasses }));
