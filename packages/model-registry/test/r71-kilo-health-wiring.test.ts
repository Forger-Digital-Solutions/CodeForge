import { describe, expect, it } from "vitest";
import { ForgeZero } from "@codeforge/forge-zero";
import { createKiloFreeDirectAdapter, InMemoryProviderCatalog } from "@codeforge/providers";
import { createEightBitRouteHealthAuthority } from "@codeforge/eight-bit";
import { FreeCloudService } from "../src/free-cloud-service.js";
import { NormalizedModelRegistry } from "../src/index.js";

describe("R71 adapter response scope reaches production connection health", () => {
  it.each(["model", "provider"] as const)("retains a %s cooldown through the real adapter and registry observer", async scope => {
    const health = createEightBitRouteHealthAuthority();
    const service = new FreeCloudService({ firewall: new ForgeZero(), providerCatalog: new InMemoryProviderCatalog(), registry: new NormalizedModelRegistry(), routeHealth: health });
    service.setConnection({ providerId: "kilo-free-direct", connected: true, credentialSource: "ANONYMOUS_DIRECT", authState: "ok", ownerUserId: "alice" });
    const adapter = createKiloFreeDirectAdapter({ onResponse: service.onProviderResponse, fetchFn: async () => Response.json({ error: {
      code: 429, message: scope === "model" ? "Provider returned error" : "Free models per IP quota exceeded",
      metadata: { provider_name: "Upstream", provider_code: 429 },
    } }, { status: 429, headers: { "retry-after": "120" } }) });
    await expect(adapter.chat({ model: "lab/hot:free", messages: [{ role: "user", content: "public fixture" }] })).rejects.toMatchObject({ rateLimitScope: scope });
    const quotaDomainId = "kilo-free-direct:user:localconn:kilo-free-direct";
    expect(health.assess(adapter.providerId, "lab/hot:free", { quotaDomainId }).hardExclude).toBe(true);
    expect(health.assess(adapter.providerId, "lab/cold:free", { quotaDomainId }).hardExclude).toBe(scope === "provider");
    expect(health.assess(adapter.providerId, "lab/hot:free", { quotaDomainId: "independent-client" }).hardExclude).toBe(false);
    expect(health.snapshot()).toHaveLength(1);
  });

  it("keeps an exact model upstream wall from excluding an available sibling in the same source-IP pool", async () => {
    const health = createEightBitRouteHealthAuthority();
    const service = new FreeCloudService({ firewall: new ForgeZero(), providerCatalog: new InMemoryProviderCatalog(), registry: new NormalizedModelRegistry(), routeHealth: health });
    service.setConnection({ providerId: "kilo-free-direct", connected: true, credentialSource: "ANONYMOUS_DIRECT", authState: "ok", ownerUserId: "alice" });
    const model = "liquid/lfm-2.5-2.6b:free";
    const adapter = createKiloFreeDirectAdapter({ onResponse: service.onProviderResponse, fetchFn: async () => Response.json({ error: {
      code: 429, message: "Provider returned error", metadata: { raw: `${model} is temporarily rate-limited upstream. Please retry shortly.` },
    } }, { status: 429, headers: { "retry-after": "120" } }) });
    await expect(adapter.chat({ model, messages: [{ role: "user", content: "public fixture" }] })).rejects.toMatchObject({ rateLimitScope: "model" });
    const quotaDomainId = "kilo-free-direct:user:localconn:kilo-free-direct";
    expect(health.assess(adapter.providerId, model, { quotaDomainId }).hardExclude).toBe(true);
    expect(health.assess(adapter.providerId, "cohere/north-mini-code:free", { quotaDomainId }).hardExclude).toBe(false);
  });
});
