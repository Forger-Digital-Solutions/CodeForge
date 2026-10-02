import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { ForgeZero, createGenericFreeRecord, freeRouteExclusionReason } from '@codeforge/forge-zero';
import { InMemoryProviderCatalog, createAiHordeCommunityAdapter, createKiloFreeDirectAdapter } from '@codeforge/providers';
import { FreeCloudService, NormalizedModelRegistry, reverifyHordePolicy, reverifyKiloPolicy } from '@codeforge/model-registry';
import { createEightBitRouteHealthAuthority } from '@codeforge/eight-bit';

const directory = 'docs/evidence/free-capacity-fabric/';
const runtimeCommit = process.argv[2];
if (!/^[a-f0-9]{40}$/.test(runtimeCommit ?? '')) throw new Error('VALIDATED_RUNTIME_COMMIT_REQUIRED');
const startedAt = new Date().toISOString();
const live = await fetch('https://codeforge-cloud-va.onrender.com/health/live', { signal: AbortSignal.timeout(30_000) });
const health = await live.json();
if (!live.ok || health.deployment?.commit !== runtimeCommit) throw new Error('DEPLOYED_REVISION_MISMATCH');
const firewall = new ForgeZero();
firewall.setPrivacyMode('MAXIMUM_FREE');
const catalog = new InMemoryProviderCatalog();
const source = new FreeCloudService({ firewall, providerCatalog: catalog, registry: new NormalizedModelRegistry(), routeHealth: createEightBitRouteHealthAuthority() });
const kilo = createKiloFreeDirectAdapter({ onResponse: source.onProviderResponse });
const horde = createAiHordeCommunityAdapter({ onResponse: source.onProviderResponse });
catalog.register(kilo); catalog.register(horde);
const [kiloPolicy, hordePolicy] = await Promise.all([reverifyKiloPolicy(startedAt), reverifyHordePolicy(startedAt)]);
if (kiloPolicy.status !== 'VERIFIED' || hordePolicy.status !== 'VERIFIED') throw new Error('POLICY_UNVERIFIED');
source.setKiloPolicyReceipt(kiloPolicy.receipt); source.setHordePolicyReceipt(hordePolicy.receipt);
for (const [adapter, modelId, supplyClass, receiptFile] of [
  [kilo, 'kilo-auto/free', 'PACKAGED_FREE_DIRECT', 'R64-KILO-QUALIFICATION.json'],
  [horde, 'google/gemma-4-31b', 'COMMUNITY_ANONYMOUS_FREE', 'R65-HORDE-QUALIFICATION-google_gemma-4-31b.json'],
]) {
  const listed = (await adapter.listModels()).find((model) => model.modelId === modelId && model.isFree && model.freeStatus === 'verified_free');
  if (!listed) throw new Error('LIVE_FREE_MODEL_MISSING');
  const base = createGenericFreeRecord({ providerId: adapter.providerId, modelId, displayName: listed.displayName });
  firewall.register({ ...base, accessClass: 'FREE_ROUTED', privacyClass: 'permissive', freeStatusVerifiedAt: startedAt,
    capabilities: listed.capabilities, costProfile: { ...base.costProfile, isFree: true, inputCostPerMillion: 0, outputCostPerMillion: 0, paidFallbackPossible: false, paidFallbackDisabled: true } });
  source.setConnection({ providerId: adapter.providerId, connected: true, credentialSource: 'ANONYMOUS_DIRECT', supplyClass, authState: 'ok', ...(adapter === kilo ? { ownerUserId: 'r65-sanity-owner' } : {}) });
  const receipt = JSON.parse(await readFile(`${directory}${receiptFile}`, 'utf8'));
  await source.recordReceipt(receipt); source.applyReceiptToFirewall(receipt);
}
await source.probeRouteCapacity('ai-horde', 'google/gemma-4-31b');
const routes = source.productionCapacityRoutes().map((route) => ({ providerId: route.providerId, modelId: route.modelId,
  supplyClass: route.supplyClass, quotaDomainType: route.quotaDomainType, quotaDomainId: route.quotaDomainId,
  scope: route.capacityPoolScope, privacy: route.dataPolicyProfile, roles: route.roles,
  publicExclusion: freeRouteExclusionReason(route, undefined, { dataClass: 'PUBLIC_CODE', userConsented: true }) ?? null,
  privateExclusion: freeRouteExclusionReason(route, undefined, { dataClass: 'PRIVATE_CODE', userConsented: true }) ?? null }));
const a = routes.find((route) => route.providerId === 'kilo-free-direct');
const b = routes.find((route) => route.providerId === 'ai-horde');
const files = ['packages/providers/src/ai-horde.ts', 'packages/model-registry/src/free-cloud-service.ts', 'packages/forge-zero/src/capacity-policy.ts'];
const sourceMatchesDeployedCommit = files.every((file) => execFileSync('git', ['hash-object', file], { encoding: 'utf8' }).trim() === execFileSync('git', ['rev-parse', `${runtimeCommit}:${file}`], { encoding: 'utf8' }).trim());
const pass = sourceMatchesDeployedCommit && a?.publicExclusion === null && b?.publicExclusion === null && b?.privacy === 'PUBLIC_CODE_ONLY' && b.privateExclusion !== null && a.quotaDomainType !== b.quotaDomainType;
const report = { startedAt, finishedAt: new Date().toISOString(), status: pass ? 'PASS' : 'FAIL', runtimeCommit,
  scope: 'Compiled production package sanity bound to the deployed commit, with live anonymous catalogs, policy reverification and Horde capacity probe. No model inference or autonomous failover rerun.',
  hostedRouteDecisionSnapshot: 'NOT_EXPOSED', hostedRemoteDirectProviders: ['kilo-free-direct'],
  hostedLimitation: 'The cloud remote-direct host currently admits Kilo. Both domains are available in the client-direct Fabric modules shipped in the same production image; this is not a live hosted Horde assignment claim.',
  sourceMatchesDeployedCommit, routes, policy: { kilo: kiloPolicy.status, horde: hordePolicy.status }, inferenceCalls: 0 };
await writeFile(`${directory}R65-PRODUCTION-DOMAIN-SANITY.json`, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ status: report.status, routes, inferenceCalls: 0 }));
if (!pass) process.exitCode = 1;
