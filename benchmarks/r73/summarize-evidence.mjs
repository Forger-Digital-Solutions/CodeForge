import { readdir, readFile, writeFile } from 'node:fs/promises';

const directory = 'docs/evidence/r73-free-supply-and-completion';
const campaigns = [];
for (const file of await readdir(directory)) {
  if (!file.endsWith('.json')) continue;
  let receipt;
  try { receipt = JSON.parse(await readFile(`${directory}/${file}`, 'utf8')); } catch { continue; }
  if (receipt.evidenceClass === 'LIVE_ANONYMOUS_FREE_PUBLIC_FIXTURES' && Array.isArray(receipt.tasks)) campaigns.push({ file, ...receipt });
}
campaigns.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
const tasks = campaigns.flatMap(campaign => campaign.tasks.map(task => ({ campaign: campaign.file, ...task })));
const counts = Object.fromEntries(['completed', 'failed', 'blocked', 'parked', 'cancelled', 'running'].map(status => [status, tasks.filter(task => task.status.toLowerCase() === status).length]));
let streak = 0;
let longestSuccessfulStreak = 0;
for (const task of tasks) { streak = task.status === 'completed' ? streak + 1 : 0; longestSuccessfulStreak = Math.max(streak, longestSuccessfulStreak); }
const workers = tasks.flatMap(task => task.workers ?? []);
const frames = campaigns.flatMap(campaign => campaign.inferenceFrames ?? []);
const providerRequests = {};
for (const frame of frames) providerRequests[frame.providerId] = (providerRequests[frame.providerId] ?? 0) + 1;
const errors = frames.filter(frame => frame.error || frame.events?.some(event => event.type === 'error'));
const summary = {
  generatedAt: new Date().toISOString(), campaigns: campaigns.map(campaign => campaign.file), attempts: tasks.length, ...counts,
  completionPercentage: tasks.length ? 100 * counts.completed / tasks.length : 0, longestSuccessfulStreak,
  modelRequests: workers.reduce((sum, worker) => sum + (worker.telemetry?.modelRequests ?? 0), 0),
  observedInferenceCallsIncludingCapacityProbes: frames.length,
  toolCalls: workers.reduce((sum, worker) => sum + (worker.telemetry?.toolCalls ?? 0), 0),
  duplicateWorkReportedByRuntime: workers.reduce((sum, worker) => sum + (worker.telemetry?.duplicateWorkCount ?? 0), 0),
  observedProviderFailures: workers.reduce((sum, worker) => sum + (worker.telemetry?.providerFailures ?? 0), 0),
  providerFailureUnknownWorkers: workers.filter(worker => worker.telemetry?.providerFailures === null).length,
  providerRequests, providerErrorFrames: errors.length,
  providerRateLimits: errors.filter(frame => frame.error?.code === 'RATE_LIMITED' || frame.events?.some(event => event.code === 'RATE_LIMITED')).length,
  reviewerFailedWorkers: workers.filter(worker => worker.agentId === 'reviewer' && worker.status !== 'completed').length,
  forgeVerifyFailures: tasks.flatMap(task => task.result?.verification ?? []).filter(result => !result.passed).length,
  falseCompletions: tasks.filter(task => task.status === 'completed' && (task.result?.completion?.outcome !== 'completed' || !task.result?.review?.passed || !task.result?.verification?.length || !task.result.verification.every(item => item.passed) || task.result?.integration?.status !== 'integrated' || task.testsAfter?.exitCode !== 0)).length,
  averageObservedInferenceCallsPerCompletedTask: counts.completed ? frames.length / counts.completed : null,
  taskOutcomes: tasks.map(task => ({ id: task.id, taskClass: task.taskClass, campaign: task.campaign, status: task.status, reason: task.result?.summary ?? task.error, workers: (task.workers ?? []).map(worker => ({ agentId: worker.agentId, status: worker.status, model: worker.model, telemetry: worker.telemetry })), review: task.result?.review, verification: task.result?.verification, integration: task.result?.integration, completion: task.result?.completion, testsAfterExitCode: task.testsAfter?.exitCode })),
  interpretation: 'Qualification calls are separate from coding attempts. Runtime duplicate-work classification is not a count of every repeated read. An unavailable roster is not a provider inference failure. Requests per completion include failed attempts and capacity probes.',
};
await writeFile(`${directory}/reliability-summary.json`, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify({ attempts: summary.attempts, completed: summary.completed, blocked: summary.blocked, modelRequests: summary.modelRequests, toolCalls: summary.toolCalls, falseCompletions: summary.falseCompletions }));
