import { afterEach, describe, expect, it } from "vitest";
import { createServer, type CodeForgeServer } from "../src/index.js";
import { ForgeZero, type FreeModelRecord } from "@codeforge/forge-zero";
import { InMemoryProviderCatalog, createMockProvider } from "@codeforge/providers";
import { NormalizedModelRegistry, createFreeCloudService } from "@codeforge/model-registry";

/**
 * R59 — the machine-readable supply ledger. The R58 false-zero was only diagnosable after
 * the fact because "no eligible route" carried no per-route cause; this endpoint makes every
 * route's admission chain explicit: catalog presence, verification, qualification, health,
 * ledger exclusion, and the exact gate that failed.
 */

const NOW = new Date();

function freeRecord(providerId: string, modelId: string): FreeModelRecord {
  return {
    providerId,
    modelId,
    displayName: modelId,
    freeStatus: "verified_free",
    freeStatusVerifiedAt: NOW.toISOString(),
    tier: "free",
    contextWindow: 131072,
    capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true },
    costProfile: {
      inputCostPerMillion: 0,
      outputCostPerMillion: 0,
      isFree: true,
      freeTierVerifiedAt: NOW.toISOString(),
      paidFallbackPossible: false,
      paidFallbackDisabled: true,
      source: "pricing+live-catalog",
    },
    isRemote: true,
    isCloudHosted: true,
    accessClass: "FREE_ROUTED",
    privacyClass: "standard",
    lastVerified: NOW.toISOString(),
    verificationSource: "pricing+live-catalog",
    health: { status: "available", lastCheckedAt: NOW.toISOString() },
  };
}

function serviceWith(routes: Array<{ providerId: string; modelId: string }>) {
  const firewall = new ForgeZero();
  for (const r of routes) firewall.register(freeRecord(r.providerId, r.modelId));
  const providerCatalog = new InMemoryProviderCatalog();
  const freeCloud = createFreeCloudService({ firewall, providerCatalog, registry: new NormalizedModelRegistry() });
  for (const providerId of new Set(routes.map((r) => r.providerId))) {
    providerCatalog.register(createMockProvider({ providerId }));
    freeCloud.setConnection({ providerId, connected: true, credentialSource: "SECURE_STORAGE", authState: "ok" });
  }
  return freeCloud;
}

describe("GET /api/free-cloud/supply (R59)", () => {
  let server: CodeForgeServer;

  afterEach(async () => {
    await server?.stop();
  });

  it("answers FREE_CLOUD_UNAVAILABLE when the service is not wired", async () => {
    server = createServer({ port: 0, dbPath: ":memory:" });
    await server.start();
    const res = await fetch(`http://127.0.0.1:${server.port}/api/free-cloud/supply`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("FREE_CLOUD_UNAVAILABLE");
  });

  it("explains an unqualified verified route by its exact gate instead of a bare zero", async () => {
    const freeCloud = serviceWith([{ providerId: "openrouter", modelId: "m:free" }]);
    server = createServer({ port: 0, dbPath: ":memory:", freeCloud });
    await server.start();
    const res = await fetch(`http://127.0.0.1:${server.port}/api/free-cloud/supply`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      providers: Array<{ providerId: string; connected: boolean; planAttested?: boolean }>;
      qualification: Array<{ providerId: string; pending: number }>;
      routes: Array<{
        providerId: string;
        modelId: string;
        verifiedFree: boolean;
        forgeAutoEligible: boolean;
        pendingQualification: boolean;
        admission: { state: string; failedGate?: string };
        fabric: { inCapacityProjection: boolean; exclusionReason?: string; healthGate?: string; inCoderSupplyPlan?: boolean };
      }>;
    };
    expect(body.providers.find((p) => p.providerId === "openrouter")?.connected).toBe(true);
    expect(body.qualification.find((q) => q.providerId === "openrouter")?.pending).toBe(1);
    const route = body.routes.find((r) => r.providerId === "openrouter" && r.modelId === "m:free")!;
    expect(route.verifiedFree).toBe(true);
    expect(route.forgeAutoEligible).toBe(false);
    expect(route.pendingQualification).toBe(true);
    expect(route.admission.failedGate).toBe("CODEFORGE_QUALIFIED");
    // The fabric ledger row carries the same evidence — the "UNHEALTHY" coarse code plus the
    // gate that produced it, so a consumer never has to guess which layer denied the route.
    expect(route.fabric.inCapacityProjection).toBe(true);
    expect(route.fabric.exclusionReason).toBe("UNHEALTHY");
    expect(route.fabric.healthGate).toBe("CODEFORGE_QUALIFIED");
    expect(route.fabric.inCoderSupplyPlan).toBe(false);
  });

  it("requires the control-plane bearer when one is configured", async () => {
    server = createServer({ port: 0, dbPath: ":memory:", controlPlaneToken: "test-token-123" });
    await server.start();
    const denied = await fetch(`http://127.0.0.1:${server.port}/api/free-cloud/supply`);
    expect(denied.status).toBe(401);
  });
});
