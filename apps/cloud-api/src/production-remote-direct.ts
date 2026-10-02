import { ForgeZero, type FreeAdmissionReceipt } from "@codeforge/forge-zero";
import { InMemoryProviderCatalog, createKiloFreeDirectAdapter } from "@codeforge/providers";
import { FreeCloudService, NormalizedModelRegistry, reverifyKiloPolicy } from "@codeforge/model-registry";
import { createEightBitRouteHealthAuthority, SqliteQualificationPersistence } from "@codeforge/eight-bit";
import { createRemoteDirectHost } from "./remote-direct-host.js";
import type { CodeForgeCloudServerConfig } from "./server.js";

export function createProductionRemoteDirectHost(cloud: CodeForgeCloudServerConfig) {
  const firewall = new ForgeZero();
  firewall.setPrivacyMode("MAXIMUM_FREE");
  const catalog = new InMemoryProviderCatalog();
  const adapter = createKiloFreeDirectAdapter();
  catalog.register(adapter);
  const health = createEightBitRouteHealthAuthority();
  const registry = new NormalizedModelRegistry();
  const source = new FreeCloudService({ firewall, providerCatalog: catalog, registry, routeHealth: health });
  source.setConnection({ providerId: adapter.providerId, connected: true, credentialSource: "ANONYMOUS_DIRECT", authState: "ok" });
  const owned = new Map<string, FreeCloudService>();
  let currentPolicy: FreeAdmissionReceipt | undefined;
  const host = createRemoteDirectHost({ cloud, freeCloud: source, health,
    privacyForWorkspace: () => ({ dataClass: "PRIVATE_CODE" }),
    freeCloudForAccount: (accountId) => {
      let service = owned.get(accountId);
      if (!service) {
        service = new FreeCloudService({ firewall, providerCatalog: catalog, registry, routeHealth: health });
        service.setConnection({ providerId: adapter.providerId, connected: true, credentialSource: "ANONYMOUS_DIRECT", authState: "ok", ownerUserId: accountId });
        service.setKiloPolicyReceipt(currentPolicy);
        const receipt = source.getReceipt(adapter.providerId, "kilo-auto/free");
        if (receipt) void service.recordReceipt(receipt);
        owned.set(accountId, service);
      }
      return service;
    },
  });
  const refresh = async () => {
    const checkedAt = new Date().toISOString();
    const policy = await reverifyKiloPolicy(checkedAt);
    currentPolicy = policy.status === "VERIFIED" ? policy.receipt : undefined;
    source.setKiloPolicyReceipt(policy.status === "VERIFIED" ? policy.receipt : undefined);
    for (const service of owned.values()) service.setKiloPolicyReceipt(policy.status === "VERIFIED" ? policy.receipt : undefined);
    if (policy.status !== "VERIFIED") return;
    const models = await adapter.listModels();
    const live = models.find((model) => model.modelId === "kilo-auto/free" && model.isFree && model.freeStatus === "verified_free");
    if (!live) { firewall.unregister(adapter.providerId, "kilo-auto/free"); return; }
    firewall.register({ providerId: adapter.providerId, modelId: live.modelId, displayName: live.displayName, tier: "free",
      accessClass: "FREE_ROUTED", freeStatus: "verified_free", freeStatusVerifiedAt: checkedAt,
      verificationSource: "https://kilo.ai/docs/gateway/models-and-providers + live /models zero pricing",
      isRemote: true, isCloudHosted: true, contextWindow: live.contextWindow, capabilities: live.capabilities, privacyClass: "permissive",
      costProfile: { inputCostPerMillion: 0, outputCostPerMillion: 0, isFree: true, freeTierVerifiedAt: checkedAt,
        paidFallbackPossible: false, paidFallbackDisabled: true, source: "kilo:anonymous-free-catalog" },
      health: { status: "available", lastCheckedAt: checkedAt } });
    await source.qualifyPending({ providerId: adapter.providerId });
    const receipt = source.getReceipt(adapter.providerId, live.modelId);
    if (receipt) {
      source.applyReceiptToFirewall(receipt);
      for (const service of owned.values()) { await service.recordReceipt(receipt); service.setKiloPolicyReceipt(policy.receipt); }
    }
  };
  // Owner projections carry capability evidence, never another owner's credentials or measured allowance.
  let timer: ReturnType<typeof setInterval> | undefined;
  return { ...host, startSupply: async () => {
    source.attachQualificationStore(new SqliteQualificationPersistence(host.cloud.sessionPersistence));
    await source.loadQualification();
    await refresh();
    timer = setInterval(() => { void refresh().catch(() => { currentPolicy = undefined; source.setKiloPolicyReceipt(undefined); for (const service of owned.values()) service.setKiloPolicyReceipt(undefined); }); }, 20 * 60_000);
    timer.unref();
  }, stopSupply: () => { if (timer) clearInterval(timer); } };
}
