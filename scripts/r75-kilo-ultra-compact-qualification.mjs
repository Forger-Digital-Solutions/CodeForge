import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createKiloFreeDirectAdapter, quotaHeadersOf } from '../packages/providers/dist/index.js';
import { reverifyKiloPolicy } from '../packages/model-registry/dist/index.js';
import { runCompactQualification } from '../packages/eight-bit/dist/index.js';

const providerId = 'kilo-free-direct';
const modelId = 'nvidia/nemotron-3-ultra-550b-a55b:free';
const evidenceDirectory = resolve('docs/evidence/r75-reliable-free-autonomous-coding');
const evidenceId = Date.now();
const requestBudget = 6;
const suiteSignal = AbortSignal.timeout(180_000);
const startedAt = new Date().toISOString();
const observations = [];
const frames = [];
let inferenceRequests = 0;
const result = { startedAt, providerId, modelId, requestBudget, publicSyntheticCodeOnly: true, noCredentials: true, inferenceRequests: 0 };
const evidenceFile = `kilo-ultra-compact-${evidenceId}.json`;
const observationFile = `kilo-ultra-compact-observations-${evidenceId}.json`;
const persist = async () => writeFile(resolve(evidenceDirectory, observationFile), `${JSON.stringify({ providerId, modelId, requestBudget, inferenceRequests, publicSyntheticCodeOnly: true, observations, frames }, null, 2)}\n`);

await mkdir(evidenceDirectory, { recursive: true });
const adapter = createKiloFreeDirectAdapter({ timeoutMs: 45_000, fetchFn: async (target, init = {}) => {
  suiteSignal.throwIfAborted();
  if ((init.method ?? 'GET').toUpperCase() === 'POST') {
    if (inferenceRequests >= requestBudget) throw new Error('R75_BOUND: Kilo qualification request budget reached');
    inferenceRequests++;
  }
  const requestedAt = new Date().toISOString();
  const response = await fetch(target, { ...init, signal: init.signal ? AbortSignal.any([init.signal, suiteSignal]) : suiteSignal });
  observations.push({ requestedAt, url: String(target), method: init.method ?? 'GET', status: response.status, headers: quotaHeadersOf(response) });
  await persist();
  return response;
} });

try {
  result.policy = await reverifyKiloPolicy(startedAt, { fetcher: (target, init) => fetch(target, { ...init, signal: init.signal ? AbortSignal.any([init.signal, suiteSignal]) : suiteSignal }) });
  if (result.policy.status !== 'VERIFIED') throw new Error(`Policy ${result.policy.status}: ${result.policy.source}`);
  const catalog = await adapter.listModels();
  const model = catalog.find(candidate => candidate.modelId === modelId && candidate.isFree && candidate.freeStatus === 'verified_free' && candidate.capabilities.toolCalling);
  result.catalogModel = model;
  if (!model) throw new Error('Exact Kilo Ultra model is not currently available as verified Free tool-capable supply');
  const checkedAt = new Date().toISOString();
  const freeModel = {
    providerId,
    modelId,
    displayName: model.displayName,
    tier: 'free',
    freeStatus: 'verified_free',
    freeStatusVerifiedAt: checkedAt,
    capabilities: model.capabilities,
    contextWindow: model.contextWindow,
    isRemote: true,
    isCloudHosted: true,
    accessClass: 'FREE_ROUTED',
    privacyClass: 'permissive',
    costProfile: { inputCostPerMillion: 0, outputCostPerMillion: 0, isFree: true, freeTierVerifiedAt: checkedAt, paidFallbackPossible: false, paidFallbackDisabled: true, source: 'Kilo exact live zero-price model catalog' },
    verificationSource: 'Kilo current exact model catalog and reverified official policy',
    health: { status: 'available', lastCheckedAt: checkedAt },
  };
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
        frame.error = { message: String(error), code: error.code, status: error.status, retryable: error.retryable, rateLimitScope: error.rateLimitScope };
        throw error;
      } finally {
        await persist();
      }
    },
  };
  result.receipt = await runCompactQualification(freeModel, observedAdapter, { timeoutMs: 45_000, signal: suiteSignal });
} catch (error) {
  result.error = { message: String(error), code: error.code, status: error.status, retryable: error.retryable, rateLimitScope: error.rateLimitScope };
}

result.inferenceRequests = inferenceRequests;
result.observationFile = observationFile;
result.completedAt = new Date().toISOString();
await persist();
await writeFile(resolve(evidenceDirectory, evidenceFile), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ evidenceFile, observationFile, inferenceRequests, policy: result.policy?.status, error: result.error, qualificationState: result.receipt?.qualificationState, roles: result.receipt ? Object.fromEntries(Object.entries(result.receipt.roleResults).map(([role, outcome]) => [role, outcome.status])) : undefined }, null, 2));
