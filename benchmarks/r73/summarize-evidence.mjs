import { readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const directory = 'docs/evidence/r73-free-supply-and-completion';
const campaigns = [];
const documents = [];
for (const file of await readdir(directory)) {
  if (!file.endsWith('.json')) continue;
  let receipt;
  try { receipt = JSON.parse(await readFile(`${directory}/${file}`, 'utf8')); } catch { continue; }
  documents.push({ file, receipt });
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
const sumTelemetry = (items, field) => items.reduce((sum, item) => sum + (item.telemetry?.[field] ?? 0), 0);
const canonical = value => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
};
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const workerClassifications = items => {
  const counts = {};
  for (const worker of items) {
    const role = worker.agentId ?? worker.role ?? 'unknown';
    const status = String(worker.status ?? 'unknown').toLowerCase();
    counts[role] ??= {};
    counts[role][status] = (counts[role][status] ?? 0) + 1;
  }
  return counts;
};
const emittedToolRequests = selectedFrames => {
  const groups = new Map();
  let emitted = 0;
  for (const [frameIndex, frame] of selectedFrames.entries()) {
    for (const [eventIndex, event] of (frame.events ?? []).entries()) {
      if (event.type !== 'tool_call_completed') continue;
      emitted++;
      let argumentsValue = event.arguments;
      try { if (typeof argumentsValue === 'string') argumentsValue = JSON.parse(argumentsValue); } catch { /* Invalid arguments remain exact raw evidence. */ }
      const requestSha256 = digest({ toolName: event.toolName, arguments: argumentsValue });
      const group = groups.get(requestSha256) ?? { requestSha256, toolName: event.toolName, occurrences: [] };
      group.occurrences.push({ frameIndex, eventIndex, at: frame.at, providerId: frame.providerId, toolCallId: event.toolCallId });
      groups.set(requestSha256, group);
    }
  }
  const repeats = [...groups.values()].filter(group => group.occurrences.length > 1).map(group => ({ ...group, emittedCount: group.occurrences.length, repeatCount: group.occurrences.length - 1 }));
  return { source: 'immutable inferenceFrames.events tool_call_completed only', emittedRequests: emitted, identicalRepeatedRequests: repeats.reduce((sum, group) => sum + group.repeatCount, 0), repeatedRequestGroups: repeats, interpretation: 'Repeated emissions are not proof of duplicated execution or side effects; request histories and accumulated mutable messages are not counted.' };
};
const routeDecisions = task => (task.decisions ?? []).map(item => item.receipt).filter(receipt => receipt?.selected).map(receipt => ({ receiptId: receipt.receiptId, runId: receipt.runId, agentId: receipt.agentId, role: receipt.role, action: receipt.action, providerId: receipt.selected.providerId, modelId: receipt.selected.modelId, routeId: receipt.evidence?.routeId, capacityPoolId: receipt.evidence?.capacityPoolId, supplyClass: receipt.evidence?.supplyClass, quotaDomainType: receipt.evidence?.quotaDomainType, quotaDomainId: receipt.evidence?.quotaDomainId, independenceKey: receipt.evidence?.independenceKey }));
const taskMetrics = task => {
  const start = Date.parse(task.startedAt);
  const end = Date.parse(task.finishedAt);
  const selectedFrames = (campaigns.find(campaign => campaign.file === task.campaign)?.inferenceFrames ?? []).filter(frame => Date.parse(frame.at) >= start && Date.parse(frame.at) <= end);
  const taskWorkers = task.workers ?? [];
  return { modelRequests: sumTelemetry(taskWorkers, 'modelRequests'), observedInferenceCalls: selectedFrames.length, toolCalls: sumTelemetry(taskWorkers, 'toolCalls'), duplicateWorkReportedByRuntime: sumTelemetry(taskWorkers, 'duplicateWorkCount'), workerOutcomesByRole: workerClassifications(taskWorkers), failedWorkers: taskWorkers.filter(worker => worker.status === 'failed').map(worker => ({ id: worker.id, agentId: worker.agentId, role: worker.role, reason: worker.resultSummary ?? worker.error })), blockedWorkers: taskWorkers.filter(worker => worker.status === 'blocked').map(worker => ({ id: worker.id, agentId: worker.agentId, role: worker.role, reason: worker.resultSummary ?? worker.error })), reviewerNonPassingWorkers: taskWorkers.filter(worker => worker.agentId === 'reviewer' && worker.status !== 'completed').map(worker => ({ id: worker.id, status: worker.status, reason: worker.resultSummary ?? worker.error })), routeDecisions: routeDecisions(task), emittedToolRequests: emittedToolRequests(selectedFrames), observedInferenceMapping: 'Campaign frame.at within persisted task startedAt/finishedAt; excludes pre-task capacity probes. Worker request and executed-tool telemetry is reported separately.' };
};
const qualificationCounts = [];
const duplicateQualificationFiles = [];
const seenQualificationEvidence = new Map();
for (const { file, receipt } of documents.sort((a, b) => a.file.localeCompare(b.file))) {
  let providerId;
  let observations;
  let actualRequests;
  let counter;
  if (receipt.evidenceClass === 'LIVE_REVIEWER_ONLY_PUBLIC_CASES' && ['kilo-free-direct', 'blockrun-free-direct'].includes(receipt.providerId) && /^reviewer-.*\.json$/.test(file)) {
    providerId = receipt.providerId;
    observations = receipt.frames ?? [];
    actualRequests = observations.length;
    counter = receipt.result?.requestCount;
  } else if (/^blockrun-(?:live|compact)-observations(?:-\d+)?\.json$/.test(file) && Array.isArray(receipt.observations)) {
    providerId = 'blockrun-free-direct';
    observations = receipt.observations;
    actualRequests = observations.filter(observation => observation.method === 'POST' && observation.url === 'https://blockrun.ai/api/v1/chat/completions').length;
    counter = receipt.requests;
  } else continue;
  const evidenceSha256 = digest(observations);
  const identity = `${providerId}:${evidenceSha256}`;
  if (actualRequests && seenQualificationEvidence.has(identity)) {
    duplicateQualificationFiles.push({ file, original: seenQualificationEvidence.get(identity), evidenceSha256, excludedRequests: actualRequests });
    continue;
  }
  if (actualRequests) seenQualificationEvidence.set(identity, file);
  qualificationCounts.push({ file, providerId, actualRequests, localReportedRequestCounter: counter, evidenceSha256 });
}
const qualificationRequestsByProvider = {};
for (const receipt of qualificationCounts) qualificationRequestsByProvider[receipt.providerId] = (qualificationRequestsByProvider[receipt.providerId] ?? 0) + receipt.actualRequests;
const metricsByTask = tasks.map(task => ({ campaign: task.campaign, id: task.id, ...taskMetrics(task) }));
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
  workerOutcomesByRole: workerClassifications(workers),
  failedWorkersByRole: workerClassifications(workers.filter(worker => worker.status === 'failed')),
  blockedWorkersByRole: workerClassifications(workers.filter(worker => worker.status === 'blocked')),
  reviewerNonPassingOutputs: metricsByTask.flatMap(task => task.reviewerNonPassingWorkers.map(worker => ({ campaign: task.campaign, taskId: task.id, ...worker }))),
  taskMetrics: metricsByTask,
  qualificationAndSupplyProbeRequests: { actualRequests: qualificationCounts.reduce((sum, receipt) => sum + receipt.actualRequests, 0), byProvider: qualificationRequestsByProvider, sourceFiles: qualificationCounts, excludedDuplicateFiles: duplicateQualificationFiles, interpretation: 'Both providers count owned LIVE_REVIEWER_ONLY_PUBLIC_CASES frames. BlockRun also counts POSTs in unique owned live/compact observation files, including public transport/tool probes. Derived qualification receipts and copied receipt projections are excluded. A locally refused invocation is not an actual POST or an organic outage.' },
  forgeVerifyFailures: tasks.flatMap(task => task.result?.verification ?? []).filter(result => !result.passed).length,
  forgeVerifyExecutions: tasks.flatMap(task => task.result?.verification ?? []).length,
  independentReviewsPassed: tasks.filter(task => task.result?.review?.passed === true).length,
  integratedParents: tasks.filter(task => task.result?.integration?.status === 'integrated').length,
  falseCompletions: tasks.filter(task => task.status === 'completed' && (task.result?.completion?.outcome !== 'completed' || !task.result?.review?.passed || !task.result?.verification?.length || !task.result.verification.every(item => item.passed) || task.result?.integration?.status !== 'integrated' || task.testsAfter?.exitCode !== 0)).length,
  averageObservedInferenceCallsPerCompletedTask: counts.completed ? frames.length / counts.completed : null,
  taskOutcomes: tasks.map(task => ({ id: task.id, taskClass: task.taskClass, campaign: task.campaign, status: task.status, reason: task.result?.summary ?? task.error, workers: (task.workers ?? []).map(worker => ({ agentId: worker.agentId, status: worker.status, model: worker.model, telemetry: worker.telemetry })), review: task.result?.review, verification: task.result?.verification, integration: task.result?.integration, completion: task.result?.completion, testsAfterExitCode: task.testsAfter?.exitCode })),
  interpretation: 'Qualification calls are separate from coding attempts. Runtime duplicate-work classification and identical terminal tool emissions are distinct; repeats do not prove duplicate side effects. Physical quota ownership is taken from decision evidence, never inferred from model/user counts. An unavailable roster or local request ceiling is not an organic provider inference failure. Requests per completion include failed attempts and capacity probes.',
};
await writeFile(`${directory}/reliability-summary.json`, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify({ attempts: summary.attempts, completed: summary.completed, blocked: summary.blocked, modelRequests: summary.modelRequests, toolCalls: summary.toolCalls, falseCompletions: summary.falseCompletions }));
