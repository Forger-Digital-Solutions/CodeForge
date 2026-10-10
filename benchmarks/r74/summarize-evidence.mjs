import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const directory = 'docs/evidence/r74-autonomous-completion-and-free-reliability';
const files = ['R74-FIRST-COMPLETION.json', 'R74-STREAK-CONTINUATION.json', 'R74-FEATURE-REPAIR.json', 'R74-CORRECTED-CATEGORY-CAMPAIGN.json', 'R74-CONFIGURATION-COMPLETION.json'];
const tasks = [], frames = [], sources = [];
for (const file of files) {
  const bytes = await readFile(`${directory}/${file}`), document = JSON.parse(bytes);
  if (document.status === 'RUNNING') throw new Error(`UNFINISHED_CAMPAIGN:${file}`);
  sources.push({ file, sha256: createHash('sha256').update(bytes).digest('hex') });
  for (const task of document.tasks) tasks.push({ ...task, receipt: file });
  for (const frame of document.inferenceFrames) frames.push({ ...frame, receipt: file });
}
const recovery = JSON.parse(await readFile(`${directory}/R74-PARENT-RECOVERY-LIVE.json`));
if (recovery.status === 'RUNNING') throw new Error('RECOVERY_STILL_RUNNING');
tasks.push({ id: 'R74-live-process-recovery', taskClass: recovery.taskClass, status: recovery.recover?.result?.status ?? 'blocked', startedAt: recovery.startedAt, finishedAt: recovery.finishedAt, result: recovery.recover?.result, workers: recovery.workers ?? recovery['kill-reviewer']?.workers ?? [], turns: recovery.turns ?? [], parentStates: recovery.parentStates ?? [], testsAfter: recovery.testsAfter, receipt: 'R74-PARENT-RECOVERY-LIVE.json', recoveryAssertion: recovery.status, recordedMutationReplays: recovery.recordedMutationReplays });
for (const mode of ['kill-reviewer', 'recover']) {
  const phase = recovery[mode];
  if (!phase) continue;
  for (const [index, frame] of phase.inferenceFrames.entries()) {
    if (mode === 'kill-reviewer' && phase.crashBoundary && index === phase.inferenceFrames.length - 1 && frame.events.length === 0 && !frame.finishedAt) continue;
    frames.push({ ...frame, receipt: 'R74-PARENT-RECOVERY-LIVE.json', phase: mode });
  }
}
tasks.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
let streak = 0, longest = 0;
const outcomes = { completed: 0, failed: 0, blocked: 0, cancelled: 0 };
let falseCompletions = 0;
for (const task of tasks) {
  const status = String(task.status).toLowerCase();
  outcomes[status in outcomes ? status : 'failed']++;
  streak = status === 'completed' ? streak + 1 : 0; longest = Math.max(longest, streak);
  if (status === 'completed' && !(task.result?.completion?.outcome === 'completed' && task.result.review?.passed && task.result.verification?.length > 0 && task.result.verification.every(item => item.passed) && task.result.integration?.status === 'integrated' && task.testsAfter?.exitCode === 0 && task.parentStates.some(state => state.runId === task.result.runId && state.phase === 'completed'))) falseCompletions++;
}
const workers = [...new Map(tasks.flatMap(task => task.workers).map(worker => [worker.id, worker])).values()];
const sum = property => workers.reduce((total, worker) => total + (worker.telemetry?.[property] ?? 0), 0);
const failures = frames.filter(frame => frame.error || frame.events?.some(event => event.type === 'error')).map(frame => ({ at: frame.at, providerId: frame.providerId, modelId: frame.request.model, error: frame.error ?? frame.events.find(event => event.type === 'error') }));
const capacityPings = frames.filter(frame => frame.transport === 'chat' && frame.request.messages?.some(message => message.content === 'ping')).length;
const qualificationRequests = [];
for (const file of await readdir(directory)) {
  if (!/^(?:reviewer|planner)-.+-\d+\.json$/.test(file)) continue;
  const document = JSON.parse(await readFile(`${directory}/${file}`));
  qualificationRequests.push({ file, requests: document.frames?.length ?? 0, status: document.status });
}
const heldout = JSON.parse(await readFile(`${directory}/held-out-review-1791628701674.json`));
const report = {
  generatedAt: new Date().toISOString(), evidenceClass: 'AGGREGATE_OF_DISTINCT_CURRENT_LIVE_PARENTS_ONLY', sources,
  attempts: tasks.length, ...outcomes, completionPercentage: outcomes.completed * 100 / tasks.length, longestCompletionStreak: longest, falseCompletions,
  logicalWorkerModelRequests: sum('modelRequests'), workerExecutedTools: sum('toolCalls'), workerRetries: sum('retryCount'), workerReportedProviderFailures: sum('providerFailures'),
  externalPhysicalParentRequests: frames.length, capacityPingsIncludedInExternalCount: capacityPings, externalTaskRequestsExcludingCapacityPings: frames.length - capacityPings,
  excludedPreDispatchInterruptionFrames: 1,
  reviewerPasses: tasks.filter(task => task.result?.review?.passed).length,
  reviewerFailures: workers.filter(worker => worker.agentId === 'reviewer' && ['failed', 'blocked'].includes(worker.status)).length,
  forgeVerifyExecutions: tasks.reduce((total, task) => total + (task.result?.verification?.length ?? 0), 0), integrations: tasks.filter(task => task.result?.integration?.status === 'integrated').length,
  plannerCorrections: tasks.reduce((total, task) => total + Math.max(0, task.workers.filter(worker => worker.agentId === 'planner').length - 1), 0),
  reviewRepairRounds: tasks.reduce((total, task) => total + (task.result?.counters?.reviewRounds ?? 0), 0), successfulReviewRepairParents: tasks.filter(task => task.status === 'completed' && (task.result?.counters?.reviewRounds ?? 0) > 0).length,
  externalProviderFailures: failures.length, rateLimits: failures.filter(failure => failure.error.status === 429 || failure.error.code === 'RATE_LIMITED').length, failures,
  externalRequestsPerSuccessfulCompletionIncludingFailedParentsAndPings: frames.length / outcomes.completed,
  separateQualificationRequests: qualificationRequests.reduce((total, item) => total + item.requests, 0), qualificationRequests,
  separateHeldoutReviewerRequests: heldout.cases.length,
  sourceGateways: ['kilo-free-direct', 'blockrun-free-direct'], quotaOwnership: 'Finite source-IP gateway pools; no per-registered-user or per-role quota multiplication; shared underlying NVIDIA independence unproved',
  moneySpentUsd: 0, purchasedCreditRequests: 0, estimatedMarginalCostUsd: 0, economicsEvidence: 'Only freshly authorized exact-zero anonymous catalogs and endpoints; Kilo cost telemetry when returned; no payment credentials or paid fallback',
  recovery: { actualProcessInterruption: recovery.status === 'PASS', recordedMutationReplays: recovery.recordedMutationReplays, coderReplayedOnResume: recovery.recover?.workers?.some(worker => worker.agentId === 'coder' && worker.startedAt >= recovery.recover.startedAt) ?? false },
  tasks: tasks.map(task => ({ id: task.id, taskClass: task.taskClass, startedAt: task.startedAt, status: task.status, receipt: task.receipt, summary: task.result?.summary ?? task.error, changedFiles: task.result?.changedFiles ?? [], completionGate: task.result?.completion?.outcome, reviewPassed: task.result?.review?.passed, forgeVerify: task.result?.verification?.length ?? 0, integration: task.result?.integration?.status, workerRequests: task.workers.reduce((total, worker) => total + (worker.telemetry?.modelRequests ?? 0), 0), executedTools: task.workers.reduce((total, worker) => total + (worker.telemetry?.toolCalls ?? 0), 0) })),
};
await writeFile(`${directory}/R74-LIVE-STATISTICS.json`, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ attempts: report.attempts, completed: report.completed, failed: report.failed, blocked: report.blocked, streak: longest, falseCompletions, externalRequests: report.externalPhysicalParentRequests, workerRequests: report.logicalWorkerModelRequests, tools: report.workerExecutedTools }));
if (falseCompletions) process.exitCode = 1;
