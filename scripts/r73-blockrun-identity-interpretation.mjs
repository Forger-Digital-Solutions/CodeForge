import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { ProviderError } from '../packages/providers/dist/index.js';
import { runCompactQualification } from '../packages/eight-bit/dist/index.js';

const directory = resolve('docs/evidence/r73-free-supply-and-completion');
const sourceFile = 'blockrun-compact-1791538496172.json';
const sourceBytes = await readFile(resolve(directory, sourceFile));
const source = JSON.parse(sourceBytes.toString('utf8'));
const observationBytes = await readFile(resolve(directory, source.observationFile));
const observations = JSON.parse(observationBytes.toString('utf8'));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
let replayInvocations = 0;
const replayAdapter = { providerId: source.providerId, isTestProvider: true, async *streamChat() {
  const recorded = observations.frames[replayInvocations++];
  if (!recorded) throw new Error('Offline replay attempted a request absent from original evidence');
  for (const event of recorded.events) yield event;
  if (recorded.error) throw new ProviderError('Recorded transport model identity rejection', recorded.error.code, recorded.error.retryable);
} };
const model = { providerId: source.providerId, modelId: source.modelId, displayName: source.receipt.modelDisplayName,
  freeStatus: source.receipt.freeStatus, accessClass: source.receipt.accessClass, isRemote: true, isCloudHosted: true,
  capabilities: source.catalog.find(candidate => candidate.modelId === source.modelId).capabilities,
  costProfile: { inputCostPerMillion: 0, outputCostPerMillion: 0, isFree: true, paidFallbackPossible: false, paidFallbackDisabled: true, source: 'original-catalog-evidence' } };
const receipt = await runCompactQualification(model, replayAdapter);
const result = { interpretedAt: new Date().toISOString(), sourceFile, sourceSha256: digest(sourceBytes),
  observationFile: source.observationFile, observationSha256: digest(observationBytes),
  compactBuildSha256: digest(await readFile(resolve('packages/eight-bit/dist/qualification/compact.js'))),
  compatibilityBuildSha256: digest(await readFile(resolve('packages/eight-bit/dist/qualification/provider-compatibility.js'))),
  interpretation: 'INCONCLUSIVE_PROVIDER_COMPATIBILITY', historicalReceiptPreserved: true,
  originalInferenceRequests: source.inferenceRequests, additionalInferenceRequests: 0,
  replayInvocations, replayUsesRecordedFramesOnly: true, noNewModelQualification: true,
  qualifiedRoles: [], productionAdmissionEnabled: false,
  originalOutcome: { qualificationState: source.receipt.qualificationState, transient: source.receipt.metadata.transient },
  correctedReplayOutcome: { qualificationState: receipt.qualificationState, metadata: receipt.metadata,
    roleStatuses: Object.fromEntries(Object.entries(receipt.roleResults).map(([role, outcome]) => [role, outcome.status])),
    hardFailureRoles: receipt.hardFailureRoles },
  reason: 'The first exact-model stream was empty; subsequent responses explicitly served NVIDIA Llama instead of the requested Laguna XS. Structured identity rejection is provider compatibility evidence, not a coding competence verdict. Current classification stops further compact probes after that rejection.' };
const outputFile = `blockrun-laguna-identity-interpretation-${Date.now()}.json`;
await writeFile(resolve(directory, outputFile), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ outputFile, replayInvocations, additionalInferenceRequests: 0, interpretation: result.interpretation, correctedReplayOutcome: result.correctedReplayOutcome }, null, 2));
