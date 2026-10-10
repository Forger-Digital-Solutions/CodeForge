import { ForgeZero, CapacityReservationLedger } from '@codeforge/forge-zero';
import { createKiloFreeDirectAdapter, createBlockRunFreeAdapter, InMemoryProviderCatalog } from '@codeforge/providers';
import { FreeCloudService, NormalizedModelRegistry, reverifyKiloPolicy, reverifyBlockRunPolicy } from '@codeforge/model-registry';
import { createEightBitRouteHealthAuthority, createFreeFabric, roleQualificationStatusFor } from '@codeforge/eight-bit';
import { traceProvider } from '../r73/trace-provider.mjs';

export async function liveSupply(owner, report, persist, beforeRequest) {
  const firewall = new ForgeZero(); firewall.setPrivacyMode('MAXIMUM_FREE');
  const catalog = new InMemoryProviderCatalog();
  const health = createEightBitRouteHealthAuthority();
  const freeCloud = new FreeCloudService({ firewall, providerCatalog: catalog, registry: new NormalizedModelRegistry(), routeHealth: health, useBundledRoleEvidence: true });
  await freeCloud.loadQualification();
  for (const [providerId, modelId] of [['kilo-free-direct', 'cohere/north-mini-code:free'], ['kilo-free-direct', 'nvidia/nemotron-3-ultra-550b-a55b:free'], ['kilo-free-direct', 'nvidia/nemotron-3-super-120b-a12b:free'], ['blockrun-free-direct', 'nvidia/llama-3.2-11b-vision']]) {
    const qualification = freeCloud.getReceipt(providerId, modelId);
    if (!qualification || qualification.metadata?.transient) throw new Error('CURRENT_QUALIFICATION_REQUIRED');
    const blockrun = providerId === 'blockrun-free-direct';
    const base = (blockrun ? createBlockRunFreeAdapter : createKiloFreeDirectAdapter)({ onResponse: freeCloud.onProviderResponse });
    const hooked = new Proxy(base, { get(target, property) {
      if (property === 'streamChat') return async function* (request, signal) {
        if (beforeRequest) await beforeRequest(providerId, request);
        yield* target.streamChat(request, signal);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const adapter = traceProvider(hooked, report, persist);
    const policy = await (blockrun ? reverifyBlockRunPolicy : reverifyKiloPolicy)(new Date().toISOString());
    if (policy.status !== 'VERIFIED') throw new Error(`CURRENT_POLICY_REQUIRED:${providerId}`);
    const model = (await adapter.listModels()).find(item => item.modelId === modelId && item.isFree && item.freeStatus === 'verified_free');
    if (!model) throw new Error(`CURRENT_EXACT_FREE_MODEL_REQUIRED:${providerId}/${modelId}`);
    catalog.register(adapter);
    const now = new Date().toISOString();
    firewall.register({ providerId, modelId, displayName: model.displayName, tier: 'free', accessClass: 'FREE_ROUTED', privacyClass: 'permissive', freeStatus: 'verified_free', freeStatusVerifiedAt: now, capabilities: model.capabilities, contextWindow: model.contextWindow, isRemote: true, isCloudHosted: true, verificationSource: 'Current anonymous catalog and reverified pinned policy', costProfile: { isFree: true, inputCostPerMillion: 0, outputCostPerMillion: 0, freeTierVerifiedAt: now, paidFallbackPossible: false, paidFallbackDisabled: true }, health: { status: 'available', lastCheckedAt: now } });
    freeCloud.setConnection({ providerId, connected: true, credentialSource: 'ANONYMOUS_DIRECT', authState: 'ok', ownerUserId: owner });
    freeCloud.setDirectPolicyReceipt(providerId, policy.receipt);
    freeCloud.applyReceiptToFirewall(qualification);
    report.supply.push({ providerId, modelId, qualificationAt: qualification.completedAt, roles: Object.fromEntries(Object.keys(qualification.roleResults).map(role => [role, roleQualificationStatusFor(qualification, role)])) });
  }
  const reservations = new CapacityReservationLedger({ routes: [], pools: [] });
  const fabric = createFreeFabric({ managedRoutes: () => freeCloud.productionCapacityRoutes().filter(route => route.capacityPoolScope !== 'PER_USER_POOL'), userSources: [freeCloud], health, reservations });
  await persist();
  return { firewall, catalog, health, freeCloud, reservations, fabric };
}
