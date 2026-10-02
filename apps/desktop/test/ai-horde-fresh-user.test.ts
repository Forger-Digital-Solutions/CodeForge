import { describe, expect, it } from "vitest";
import { ForgeZero } from "@codeforge/forge-zero";
import { InMemoryProviderCatalog, createProviderAdapterFromDefinition } from "@codeforge/providers";
import { FreeCloudService, NormalizedModelRegistry, PROVIDER_DEFINITIONS } from "@codeforge/model-registry";
import { ProviderConnections } from "../src/provider-connections.js";

/**
 * R65 fresh-user acceptance: a brand-new install has an EMPTY credential store, no settings,
 * and no environment keys. AI Horde must still come up connected on the anonymous community
 * key through the exact startup path main.ts uses (definition → adapter → publishAll), and
 * no secret may ever be written for it. A key-required provider in the same empty store must
 * stay disconnected, proving the anonymous path is real and not a blanket "everything on".
 */
const freshHost = (catalog: InMemoryProviderCatalog, firewall: ForgeZero, freeCloud: FreeCloudService, secrets: Map<string, string>) => ({
  readSettings: () => ({}),
  writeSettings: () => true,
  secrets: {
    get: (key: string) => secrets.get(key),
    set: (key: string, value: string) => { secrets.set(key, value); },
    delete: (key: string) => { secrets.delete(key); },
    keys: () => [...secrets.keys()],
  },
  env: () => ({}),
  providerCatalog: catalog,
  firewall,
  freeCloud,
  discoverProviderFree: async () => 0,
  providerAuthState: () => "ok" as const,
  userId: "fresh-user",
});

describe("AI Horde fresh-user anonymous acceptance", () => {
  it("connects anonymously on an empty credential store without writing any secret", async () => {
    const secrets = new Map<string, string>();
    const catalog = new InMemoryProviderCatalog();
    const firewall = new ForgeZero();
    const freeCloud = new FreeCloudService({ firewall, providerCatalog: catalog, registry: new NormalizedModelRegistry() });
    const conns = new ProviderConnections(freshHost(catalog, firewall, freeCloud, secrets));

    const def = PROVIDER_DEFINITIONS["ai-horde"]!;
    const adapter = createProviderAdapterFromDefinition(def, {
      clientDirectAuthorized: true,
      credentialStore: { get: () => undefined, set: () => {}, delete: () => false, has: () => false },
    });
    expect(adapter).toBeDefined();
    catalog.register(adapter!);

    expect(conns.credentialSourceOf("ai-horde")).toBe("ANONYMOUS_DIRECT");
    conns.publishAll();

    const state = freeCloud.getConnection("ai-horde");
    expect(state?.connected).toBe(true);
    expect(state?.credentialSource).toBe("ANONYMOUS_DIRECT");
    expect(state?.supplyClass).toBe("COMMUNITY_ANONYMOUS_FREE");
    expect(secrets.size).toBe(0);

    const view = conns.listConnections().find((v) => v.providerId === "ai-horde");
    expect(view?.connected).toBe(true);
    expect(view?.credentialSource).toBe("ANONYMOUS_DIRECT");
    expect(view?.connectOffer).toBeUndefined();
  });

  it("leaves key-required providers disconnected on the same empty store", () => {
    const secrets = new Map<string, string>();
    const catalog = new InMemoryProviderCatalog();
    const firewall = new ForgeZero();
    const freeCloud = new FreeCloudService({ firewall, providerCatalog: catalog, registry: new NormalizedModelRegistry() });
    const conns = new ProviderConnections(freshHost(catalog, firewall, freeCloud, secrets));
    conns.publishAll();
    const cerebras = conns.listConnections().find((v) => v.providerId === "cerebras");
    expect(cerebras?.connected ?? false).toBe(false);
    expect(conns.credentialSourceOf("cerebras")).toBe("NONE");
  });
});
