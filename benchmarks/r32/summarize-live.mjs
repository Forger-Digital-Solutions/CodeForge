#!/usr/bin/env node
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const directory = path.join(root, "docs/evidence/r32-autonomy-perfection/10-live-acceptance");
const entries = [];

for (const name of (await readdir(directory)).filter((name) => /^r32-live-.*\.json$/.test(name)).sort()) {
  const receipt = JSON.parse(await readFile(path.join(directory, name), "utf8"));
  const independentVerifierPassed = receipt.verification.hidden.passed && receipt.verification.answerKeyPassed !== false;
  const autonomousPass = receipt.workflow.status === "completed" && receipt.workflow.completion?.outcome === "completed" && independentVerifierPassed;
  const reviewFindings = receipt.workflow.review?.findings ?? [];
  const inconclusive = reviewFindings.some((finding) => finding.code === "goal_review_inconclusive");
  entries.push({
    receipt: name,
    runId: receipt.runId,
    sourceCommit: receipt.sourceCommit,
    corpus: receipt.task.corpus,
    taskId: receipt.task.sourceTaskId,
    taskClass: receipt.task.taskClass,
    repoSizeClass: receipt.task.repoSizeClass,
    substantial: ["medium", "large"].includes(receipt.task.repoSizeClass) || ["test_fix", "build_config_dependency"].includes(receipt.task.taskClass),
    providerId: receipt.configuration.providerId,
    modelId: receipt.configuration.modelId,
    inferenceBudget: receipt.configuration.inferenceBudget ?? null,
    workflowStatus: receipt.workflow.status,
    completionOutcome: receipt.workflow.completion?.outcome ?? null,
    blockers: (receipt.workflow.completion?.blockers ?? []).map((blocker) => blocker.code),
    goalReviewInconclusive: inconclusive,
    independentVerifierPassed,
    autonomousPass,
    wallClockMs: receipt.timing.wallClockMs,
    modelRequests: receipt.provider.inferenceRequestCount,
    toolCalls: receipt.eventTypes["tool.call_started"] ?? 0,
    failedToolExecutions: receipt.eventTypes["tool.execution_failed"] ?? 0,
    inputTokens: receipt.provider.measuredInputTokens ?? null,
    outputTokens: receipt.provider.measuredOutputTokens ?? null,
    tokenUsageUnknownRequests: receipt.provider.requestsWithoutTokenUsage ?? null,
    changedPaths: receipt.workflow.changedFileSnapshots?.map((snapshot) => snapshot.path) ?? [],
    injected429Count: receipt.provider.injected429Count ?? 0,
    humanTaskIntervention: "none",
  });
}

const bySourceCommit = Object.groupBy(entries.filter((entry) => entry.substantial), (entry) => entry.sourceCommit);
const acceptanceCohorts = Object.entries(bySourceCommit).map(([sourceCommit, attempts]) => {
  const distinctTaskCount = new Set(attempts.map((entry) => `${entry.corpus}/${entry.taskId}`)).size;
  const successes = attempts.filter((entry) => entry.autonomousPass).length;
  const classes = [...new Set(attempts.map((entry) => entry.taskClass))].sort();
  const hasInjected429 = attempts.some((entry) => entry.injected429Count > 0);
  const falseSuccesses = attempts.filter((entry) => entry.workflowStatus === "completed" && !entry.independentVerifierPassed);
  return {
    sourceCommit,
    attemptCount: attempts.length,
    distinctTaskCount,
    autonomousPasses: successes,
    autonomousSuccessRate: attempts.length ? successes / attempts.length : null,
    taskClasses: classes,
    hasInjected429,
    falseSuccessCount: falseSuccesses.length,
    // R32 target: >=9/10 autonomous verified passes on a diversified suite, and zero
    // completed-but-wrong runs (the R31 false-success class must be closed).
    meetsSampleAndReliabilityTarget: attempts.length >= 10 && distinctTaskCount >= 10 && successes >= Math.ceil(attempts.length * 0.9) && hasInjected429 && falseSuccesses.length === 0,
  };
});

const summary = {
  schema: "r32-live-task-summary-1",
  generatedAt: new Date().toISOString(),
  attemptCount: entries.length,
  substantialAttemptCount: entries.filter((entry) => entry.substantial).length,
  autonomousPasses: entries.filter((entry) => entry.autonomousPass).length,
  acceptanceCohorts,
  entries,
};
await writeFile(path.join(directory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify({ attempts: summary.attemptCount, autonomousPasses: summary.autonomousPasses, acceptanceCohorts }));
