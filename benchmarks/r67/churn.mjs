import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { ForgeZero } from '@codeforge/forge-zero';
import { InMemoryProviderCatalog } from '@codeforge/providers';
import { FreeCloudService, NormalizedModelRegistry } from '@codeforge/model-registry';

process.env.NODE_ENV = 'test';
const now = new Date().toISOString();
const providerId = 'ai-horde';
const old = 'simulated/old-qualified';
const alternate = 'simulated/new-candidate';
const baseReceipt = JSON.parse(await readFile('docs/evidence/free-capacity-fabric/R65-HORDE-QUALIFICATION-google_gemma-4-31b.json', 'utf8'));
const fixtureReceipt = (modelId) => ({ ...structuredClone(baseReceipt), modelId, modelDisplayName: modelId, startedAt: now, completedAt: now });
const record = (modelId) => ({ providerId, modelId, displayName: modelId, freeStatus: 'verified_free', freeStatusVerifiedAt: now, tier: 'free', capabilities: { text: true, coding: true, toolCalling: true, structuredOutput: true, vision: false, longContext: false }, contextWindow: 32768, costProfile: { inputCostPerMillion: 0, outputCostPerMillion: 0, isFree: true, freeTierVerifiedAt: now, paidFallbackPossible: false, paidFallbackDisabled: true }, isRemote: true, isCloudHosted: true, accessClass: 'FREE_ROUTED', privacyClass: 'permissive', lastVerified: now, verificationSource: 'SIMULATED catalog identity churn', health: { status: 'available', lastCheckedAt: now } });
const firewall = new ForgeZero();
firewall.register(record(old));
const catalog = new InMemoryProviderCatalog();
const calls = [];
const service = new FreeCloudService({ firewall, providerCatalog: catalog, registry: new NormalizedModelRegistry(), qualificationCycleIntervalMs: 0, qualificationRequestsPerCycle: 1, qualificationDailyBudgetPerProvider: 2,
  qualificationRunner: async (model) => { calls.push({ modelId: model.modelId, at: new Date().toISOString(), evidence: 'SCRIPTED qualification result, not real alternate-model quality' }); return fixtureReceipt(model.modelId); } });
catalog.register({ providerId, isTestProvider: true, listModels: async () => [], healthCheck: async () => ({ status: 'available' }),
  chat: async () => { throw new Error('UNEXPECTED_INFERENCE'); }, streamChat: async function* () {},
  probeAccountQuota: async () => { service.onProviderResponse({ providerId, status: 200, headers: [['x-capacity-limit-concurrency', '500'], ['x-capacity-remaining-concurrency', '498']], observedAt: Date.now() }); return true; } });
service.setConnection({ providerId, connected: true, credentialSource: 'ANONYMOUS_DIRECT', supplyClass: 'COMMUNITY_ANONYMOUS_FREE', authState: 'ok' });
service.setHordePolicyReceipt({ sourceDocumentation: 'https://raw.githubusercontent.com/Haidra-Org/AI-Horde/main/README.md', termsEvidence: 'https://raw.githubusercontent.com/Haidra-Org/haidra-assets/main/docs/definitions.md', priceEvidence: 'https://raw.githubusercontent.com/Haidra-Org/haidra-assets/main/docs/kudos.md', privacyEvidence: 'https://raw.githubusercontent.com/Haidra-Org/AI-Horde/main/FAQ.md', verifiedAt: now, recheckAt: new Date(Date.now() + 86400000).toISOString(), qualificationAt: now });
await service.recordReceipt(fixtureReceipt(old));
service.applyReceiptToFirewall(fixtureReceipt(old));
await service.probeRouteCapacity(providerId, old);
assert.equal(service.isForgeAutoEligible(providerId, old), true);
firewall.unregister(providerId, old);
assert.ok(!service.productionCapacityRoutes().some((route) => route.modelId === old));
firewall.register(record(alternate));
assert.equal(service.isForgeAutoEligible(providerId, alternate), false);
const before = service.pendingQualification().map((route) => route.providerModelId);
assert.ok(before.includes(alternate));
await service.qualifyPending({ providerId });
assert.equal(service.isForgeAutoEligible(providerId, alternate), true);
await service.qualifyPending({ providerId });
assert.equal(calls.length, 1);
const output = { generatedAt: new Date().toISOString(), status: 'PASS_SIMULATED_LIFECYCLE', evidenceClass: 'DETERMINISTIC_MODEL_IDENTITY_CHURN_NO_LIVE_ALTERNATE_QUALIFICATION', oldRemoved: true, newInitiallyInert: true, pendingBefore: before, qualificationCalls: calls, admittedAfterScriptedQualification: true, repeatRefreshQualificationCalls: 0, qualificationSummary: service.qualificationSummary(), privacy: 'PUBLIC_CODE_ONLY', limitations: ['Catalog pruning is exercised through the same ForgeZero.unregister used by desktop discovery.', 'Cheap transport and text-tool semantics are covered by provider contracts and the live R65/R66 model evidence. They are not re-earned for this scripted alternate.', 'Capability churn under an unchanged model ID remains unproven.'] };
await writeFile('docs/evidence/r67-everyday-completion-reliability/R67-HORDE-MODEL-CHURN.json', `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify({ status: output.status, calls: calls.length }));
