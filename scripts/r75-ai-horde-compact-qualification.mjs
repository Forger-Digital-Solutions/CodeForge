import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createAiHordeCommunityAdapter, quotaHeadersOf } from '../packages/providers/dist/index.js';
import { runCompactQualification } from '../packages/eight-bit/dist/index.js';

const modelId = 'google/gemma-4-31b';
const evidenceDirectory = resolve('docs/evidence/r75-reliable-free-autonomous-coding');
const evidenceId = Date.now();
const requestBudget = 8;
const windowBudget = 8;
const minimumPostIntervalMs = 8_000;
const suiteDeadlineMs = 300_000;
const suiteSignal = AbortSignal.timeout(suiteDeadlineMs);
const startedAt = new Date().toISOString();
const observations = [];
const frames = [];
let inferenceRequests = 0;
let windowStartedAt = Date.now();
let requestsInWindow = 0;
let lastPostStartedAt = 0;
const observationFile = `ai-horde-compact-observations-${evidenceId}.json`;
const evidenceFile = `ai-horde-compact-${evidenceId}.json`;
const result = {
  startedAt,
  providerId: 'ai-horde',
  modelId,
  requestBudget,
  windowBudget,
  minimumPostIntervalMs,
  suiteDeadlineMs,
  publicSyntheticCodeOnly: true,
  anonymousDocumentedAccess: true,
  paidCredentialsUsed: false,
  purchasedKudosUsed: false,
  privateWorkspaceDataSent: false,
  billing: 'AI Horde anonymous community workers; no monetary billing rail or purchasable kudos',
  privacy: 'Community worker hosts can technically see prompts; synthetic public fixture only',
  inferenceRequests: 0,
};

await mkdir(evidenceDirectory, { recursive: true });
const flush = async () => writeFile(resolve(evidenceDirectory, observationFile), JSON.stringify({
  modelId, inferenceRequests, requestBudget, windowBudget, minimumPostIntervalMs,
  publicSyntheticCodeOnly: true, observations, frames,
}, null, 2));
const adapter = createAiHordeCommunityAdapter({ timeoutMs: 60_000, fetchFn: async (target, init = {}) => {
  suiteSignal.throwIfAborted();
  const method = init.method ?? 'GET';
  if (method.toUpperCase() === 'POST') {
    if (inferenceRequests >= requestBudget) throw new Error('R75_BOUND: total inference request budget reached');
    const delay = minimumPostIntervalMs - (Date.now() - lastPostStartedAt);
    if (lastPostStartedAt > 0 && delay > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
    suiteSignal.throwIfAborted();
    const now = Date.now();
    if (now - windowStartedAt >= 60_000) {
      windowStartedAt = now;
      requestsInWindow = 0;
    }
    if (requestsInWindow >= windowBudget) throw new Error('R75_BOUND: anonymous shared RPM budget reached');
    lastPostStartedAt = now;
    requestsInWindow++;
    inferenceRequests++;
  }
  const response = await fetch(target, {
    ...init,
    signal: init.signal ? AbortSignal.any([init.signal, suiteSignal]) : suiteSignal,
  });
  observations.push({
    requestedAt: new Date().toISOString(),
    url: String(target),
    method,
    status: response.status,
    headers: quotaHeadersOf(response),
  });
  await flush();
  return response;
} });

const observedAdapter = {
  streamChat: async function* (request, signal) {
    const frame = { requestedAt: new Date().toISOString(), request, events: [] };
    frames.push(frame);
    try {
      for await (const event of adapter.streamChat(request, signal)) {
        frame.events.push(event);
        yield event;
      }
    } catch (error) {
      frame.error = {
        message: String(error),
        code: error.code,
        status: error.status,
        retryable: error.retryable,
      };
      throw error;
    } finally {
      await flush();
    }
  },
};

try {
  const statusResponse = await fetch('https://aihorde.net/api/v2/status/models?type=text', {
    headers: { apikey: '0000000000', 'Client-Agent': 'CodeForge:0.4.0:https://github.com/Forger-Digital-Solutions/CodeForge' },
    signal: suiteSignal,
  });
  result.statusEndpoint = { url: 'https://aihorde.net/api/v2/status/models?type=text', status: statusResponse.status };
  observations.push({ requestedAt: new Date().toISOString(), url: result.statusEndpoint.url, method: 'GET', status: statusResponse.status, headers: quotaHeadersOf(statusResponse) });
  await flush();
  if (!statusResponse.ok) throw new Error(`AI Horde status preflight failed with HTTP ${statusResponse.status}`);
  const liveRows = await statusResponse.json();
  const liveModel = Array.isArray(liveRows) ? liveRows.find((row) => row?.name === modelId) : undefined;
  result.liveStatus = liveModel ? {
    name: liveModel.name,
    count: liveModel.count,
    jobs: liveModel.jobs,
    queued: liveModel.queued,
    eta: liveModel.eta,
    performance: liveModel.performance,
  } : null;
  if (!liveModel || !(liveModel.count > 0) || liveModel.jobs !== 0 || liveModel.queued !== 0) {
    throw new Error('Candidate no longer has an active worker with an empty queue; no inference sent');
  }

  result.catalog = await adapter.listModels();
  const model = result.catalog.find((candidate) => candidate.modelId === modelId);
  if (!model) throw new Error('Exact candidate is absent from AI Horde native text model catalog');
  const verifiedAt = new Date().toISOString();
  const freeModel = {
    providerId: adapter.providerId,
    modelId,
    displayName: model.displayName,
    tier: 'free',
    freeStatus: 'verified_free',
    freeStatusVerifiedAt: verifiedAt,
    capabilities: model.capabilities,
    contextWindow: model.contextWindow,
    isRemote: true,
    isCloudHosted: true,
    accessClass: 'COMMUNITY_ANONYMOUS_FREE',
    privacyClass: 'permissive',
    costProfile: {
      inputCostPerMillion: 0,
      outputCostPerMillion: 0,
      isFree: true,
      freeTierVerifiedAt: verifiedAt,
      paidFallbackPossible: false,
      paidFallbackDisabled: true,
      source: 'AI Horde official anonymous access and current community worker policy',
    },
    verificationSource: 'AI Horde official anonymous access; no paid fallback or purchased kudos',
    health: { status: 'available', lastCheckedAt: verifiedAt },
  };
  result.compactSuiteBuildSha256 = createHash('sha256')
    .update(await readFile(resolve('packages/eight-bit/dist/qualification/compact.js')))
    .digest('hex');
  result.receipt = await runCompactQualification(freeModel, observedAdapter, { timeoutMs: 60_000, signal: suiteSignal });
} catch (error) {
  result.error = {
    message: String(error),
    code: error.code,
    status: error.status,
    retryable: error.retryable,
    causeCode: error.cause?.code,
    causeMessage: error.cause?.message,
  };
} finally {
  result.inferenceRequests = inferenceRequests;
  result.observationFile = observationFile;
  result.completedAt = new Date().toISOString();
  await flush();
  await writeFile(resolve(evidenceDirectory, evidenceFile), JSON.stringify(result, null, 2));
}

console.log(JSON.stringify({
  evidenceFile,
  observationFile,
  modelId,
  liveStatus: result.liveStatus,
  inferenceRequests,
  error: result.error,
  qualificationState: result.receipt?.qualificationState,
  transient: result.receipt?.metadata?.transient,
  roles: result.receipt ? Object.fromEntries(Object.entries(result.receipt.roleResults).map(([role, outcome]) => [role, outcome.status])) : undefined,
}, null, 2));
