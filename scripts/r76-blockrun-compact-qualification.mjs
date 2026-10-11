import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createBlockRunFreeAdapter, quotaHeadersOf } from '../packages/providers/dist/index.js';
import { reverifyBlockRunPolicy } from '../packages/model-registry/dist/index.js';
import { runCompactQualification } from '../packages/eight-bit/dist/index.js';

const evidenceDirectory = resolve('docs/evidence/r76-free-supply-recovery-and-reliability');
const modelId = process.argv[2] ?? 'poolside/laguna-xs-2.1';
const evidenceId = Date.now();
const requestBudget = 12;
const suiteDeadlineMs = 180_000;
const suiteSignal = AbortSignal.timeout(suiteDeadlineMs);
const startedAt = new Date().toISOString();
const observations = [];
const frames = [];
let requests = 0;
const result = { startedAt, providerId: 'blockrun-free-direct', modelId, requestBudget, suiteDeadlineMs,
  publicSyntheticCodeOnly: true, noPaymentCredentials: true, inferenceRequests: 0 };
const observationFile = `blockrun-compact-observations-${evidenceId}.json`;
const flush = async () => writeFile(resolve(evidenceDirectory, observationFile), JSON.stringify({ modelId, requests, requestBudget, publicSyntheticCodeOnly: true, noPaymentCredentials: true, observations, frames }, null, 2));
await mkdir(evidenceDirectory, { recursive: true });
result.compactSuiteBuildSha256 = createHash('sha256').update(await readFile(resolve('packages/eight-bit/dist/qualification/compact.js'))).digest('hex');
const adapter = createBlockRunFreeAdapter({ timeoutMs: 45_000, fetchFn: async (target, init) => {
  suiteSignal.throwIfAborted();
  if (init?.method === 'POST') {
    if (requests >= requestBudget) throw new Error('R76_BOUND: qualification request budget reached');
    requests++;
  }
  const requestStartedAt = new Date().toISOString();
  const response = await fetch(target, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, suiteSignal]) : suiteSignal });
  observations.push({ requestStartedAt, url: String(target), method: init?.method ?? 'GET',
    ...(init?.method === 'POST' ? { publicSyntheticRequest: JSON.parse(init.body) } : {}),
    status: response.status, headers: quotaHeadersOf(response), body: await response.clone().text() });
  await flush();
  return response;
} });
const observedAdapter = { streamChat: async function* (request, signal) {
  const invocation = { requestedAt: new Date().toISOString(), request, events: [] };
  frames.push(invocation);
  try {
    for await (const event of adapter.streamChat(request, signal)) {
      invocation.events.push(event);
      yield event;
    }
  } catch (error) {
    invocation.error = { message: String(error), code: error.code, status: error.status, retryable: error.retryable, rateLimitScope: error.rateLimitScope };
    throw error;
  } finally { await flush(); }
} };
try {
  result.policy = await reverifyBlockRunPolicy(startedAt, { fetcher: (target, init) => fetch(target, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, suiteSignal]) : suiteSignal }) });
  if (result.policy.status !== 'VERIFIED') throw new Error(`Policy ${result.policy.status}: ${result.policy.source}`);
  result.catalog = await adapter.listModels();
  const model = result.catalog.find(candidate => candidate.modelId === modelId);
  if (!model) throw new Error('Requested model is not currently available with explicit Free billing');
  const now = new Date().toISOString();
  const freeModel = { providerId: adapter.providerId, modelId, displayName: model.displayName,
    tier: 'free', freeStatus: 'verified_free', freeStatusVerifiedAt: now, capabilities: model.capabilities,
    contextWindow: model.contextWindow, isRemote: true, isCloudHosted: true, accessClass: 'FREE_ROUTED',
    privacyClass: 'permissive', costProfile: { inputCostPerMillion: 0, outputCostPerMillion: 0, isFree: true,
      freeTierVerifiedAt: now, paidFallbackPossible: false, paidFallbackDisabled: true, source: 'blockrun:live-free-catalog' },
    verificationSource: 'BlockRun explicit zero-price free billing', health: { status: 'available', lastCheckedAt: now } };
  const receipt = await runCompactQualification(freeModel, observedAdapter, { timeoutMs: 45_000, signal: suiteSignal });
  result.receipt = { ...receipt, metadata: { ...receipt.metadata, requests, measuredProviderRequests: requests,
    compactOnly: true, publicSyntheticCodeOnly: true, noPaymentCredentials: true, observationFile,
    compactSuiteBuildSha256: result.compactSuiteBuildSha256 } };
} catch (error) {
  result.error = { message: String(error), code: error.code, retryable: error.retryable, status: error.status, rateLimitScope: error.rateLimitScope };
}
result.inferenceRequests = requests;
result.observationFile = observationFile;
result.completedAt = new Date().toISOString();
await flush();
const file = `blockrun-compact-${evidenceId}.json`;
await writeFile(resolve(evidenceDirectory, file), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ file, inferenceRequests: requests, policy: result.policy?.status, error: result.error,
  qualificationState: result.receipt?.qualificationState, transient: result.receipt?.metadata?.transient,
  roles: result.receipt ? Object.fromEntries(Object.entries(result.receipt.roleResults).map(([role, outcome]) => [role, outcome.status])) : undefined }, null, 2));
