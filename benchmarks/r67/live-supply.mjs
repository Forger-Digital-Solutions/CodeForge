import { readFile } from 'node:fs/promises';
import { ForgeZero, CapacityReservationLedger } from '@codeforge/forge-zero';
import { createKiloFreeDirectAdapter, createAiHordeCommunityAdapter, InMemoryProviderCatalog } from '@codeforge/providers';
import { FreeCloudService, NormalizedModelRegistry, reverifyKiloPolicy, reverifyHordePolicy } from '@codeforge/model-registry';
import { createEightBitRouteHealthAuthority, createFreeFabric } from '@codeforge/eight-bit';
export async function liveSupply(owner, beforeRequest = () => {}) {
  const firewall = new ForgeZero(); firewall.setPrivacyMode('MAXIMUM_FREE');
  const catalog = new InMemoryProviderCatalog();
  const health = createEightBitRouteHealthAuthority();
  const freeCloud = new FreeCloudService({ firewall, providerCatalog: catalog, registry: new NormalizedModelRegistry(), routeHealth: health });
  const receipts = [];
  for (const [adapter, verify, receiptPath] of [
    [createKiloFreeDirectAdapter({ onResponse: freeCloud.onProviderResponse }), reverifyKiloPolicy, 'docs/evidence/r66-everyday-free-readiness/R66-KILO-ROLE-QUALITY-final.json'],
    [createAiHordeCommunityAdapter({ onResponse: freeCloud.onProviderResponse }), reverifyHordePolicy, 'docs/evidence/free-capacity-fabric/R65-HORDE-QUALIFICATION-google_gemma-4-31b.json'],
  ]) {
    const now = new Date().toISOString();
    const policy = await verify(now);
    if (policy.status !== 'VERIFIED') throw new Error('UNVERIFIED_FREE_POLICY');
    const refreshPath = `docs/evidence/r67-everyday-completion-reliability/R67-${adapter.providerId === 'ai-horde' ? 'HORDE' : 'KILO'}-ROLE-QUALITY-refresh.json`;
    const refreshed = await readFile(refreshPath, 'utf8').then(JSON.parse).catch(() => undefined);
    const useRefresh = refreshed?.qualification && !refreshed.qualification.metadata?.transient;
    const qualificationSource = useRefresh ? refreshPath : receiptPath;
    const document = useRefresh ? refreshed : JSON.parse(await readFile(receiptPath, 'utf8'));
    const receipt = document.qualification ?? document;
    if (receipt.metadata?.transient || Date.now() - Date.parse(receipt.completedAt) > 86400000) throw new Error('CURRENT_QUALIFICATION_REQUIRED');
    const model = (await adapter.listModels()).find(item => item.modelId === receipt.modelId && item.isFree && item.freeStatus === 'verified_free');
    if (!model) { receipts.push({ providerId: adapter.providerId, modelId: receipt.modelId, qualificationSource, status: 'MODEL_ABSENT' }); continue; }
    catalog.register({ providerId: adapter.providerId, isTestProvider: false, listModels: adapter.listModels.bind(adapter), chat: adapter.chat.bind(adapter), healthCheck: adapter.healthCheck.bind(adapter),
      ...(adapter.probeAccountQuota ? { probeAccountQuota: adapter.probeAccountQuota.bind(adapter) } : {}),
      async *streamChat(request, signal) { await beforeRequest(adapter.providerId, request); yield* adapter.streamChat(request, signal); },
    });
    firewall.register({ providerId: adapter.providerId, modelId: model.modelId, displayName: model.displayName, tier: 'free', accessClass: 'FREE_ROUTED', privacyClass: 'permissive', freeStatus: 'verified_free', freeStatusVerifiedAt: now, capabilities: model.capabilities, contextWindow: model.contextWindow, isRemote: true, isCloudHosted: true, verificationSource: 'R67 live catalog and freshly verified free policy', costProfile: { isFree: true, inputCostPerMillion: 0, outputCostPerMillion: 0, freeTierVerifiedAt: now, paidFallbackPossible: false, paidFallbackDisabled: true }, health: { status: 'available', lastCheckedAt: now } });
    freeCloud.setConnection({ providerId: adapter.providerId, connected: true, credentialSource: 'ANONYMOUS_DIRECT', authState: 'ok', ownerUserId: owner, ...(adapter.providerId === 'ai-horde' ? { supplyClass: 'COMMUNITY_ANONYMOUS_FREE' } : {}) });
    if (adapter.providerId === 'ai-horde') freeCloud.setHordePolicyReceipt(policy.receipt); else freeCloud.setKiloPolicyReceipt(policy.receipt);
    await freeCloud.recordReceipt(receipt); freeCloud.applyReceiptToFirewall(receipt);
    const measured = await freeCloud.probeRouteCapacity(adapter.providerId, model.modelId);
    receipts.push({ providerId: adapter.providerId, modelId: model.modelId, completedAt: receipt.completedAt, qualificationSource, roles: Object.fromEntries(Object.entries(receipt.roleResults).map(([role, value]) => [role, value.status])), measured });
  }
  const reservations = new CapacityReservationLedger({ routes: [], pools: [] });
  const fabric = createFreeFabric({ managedRoutes: () => freeCloud.productionCapacityRoutes().filter(route => route.capacityPoolScope !== 'PER_USER_POOL'), userSources: [freeCloud], health, reservations });
  return { firewall, catalog, health, freeCloud, reservations, fabric, receipts };
}
