import { describe, expect, it } from "vitest";
import { SqliteSessionPersistence } from "@codeforge/sessions";
import { PAID_AUTO_MODELS, PaidAutoService, PaidFamilyCatalog, PaidFamilyCatalogStore, type ApprovedPaidSuccessor, type PaidAutoModel, type PaidPromotionEvidence } from "../src/index.js";

const predecessor = PAID_AUTO_MODELS.find((model) => model.canonicalModelId === "gpt-5.6-luna")!;
const source = "https://provider.example/catalog/luna-6";
const successor: PaidAutoModel = {
  ...predecessor, canonicalModelId: "luna-6", displayName: "Luna 6", contextWindow: 1_100_000,
  direct: { ...predecessor.direct, canonicalModelId: "luna-6", routeId: "luna-6:direct", providerModelId: "luna-6", source, pricing: { ...predecessor.direct.pricing, inputCostPerMillion: 0.3, outputCostPerMillion: 1.8, source } },
  fallback: { ...predecessor.fallback, canonicalModelId: "luna-6", routeId: "luna-6:openrouter", providerModelId: "openai/luna-6" },
  verification: { verifiedAt: "2026-09-28T00:00:00.000Z", sources: [source] },
};
const approved: ApprovedPaidSuccessor = { canonicalModelId: "luna-6", familyId: "luna", predecessorId: "gpt-5.6-luna", directProviderId: "openai", directProviderModelId: "luna-6", identitySource: source };
const evidence: PaidPromotionEvidence = { role: "CODER", roleQualification: "QUALIFIED", benchmarkEvidenceId: "bench-1", liveEvidenceId: "live-1", verifiedCompletionRate: 0.9, reliability: 0.95, latencyMs: 500, inputPricePerMillion: 0.3, outputPricePerMillion: 1.8, shPerVerifiedTask: null, incumbentCostPerVerifiedTaskUsd: 0.04, candidateCostPerVerifiedTaskUsd: 0.05, priceSource: source, observedAt: "2026-09-28T00:00:00.000Z" };

describe("R55 paid family lifecycle", () => {
  it("rejects similarly named unapproved models and cross-family succession", () => {
    const catalog = new PaidFamilyCatalog();
    expect(() => catalog.discoverSuccessor({ model: successor, version: "6", predecessorId: "gpt-5.6-luna", identitySource: source, trustedCatalogProviderId: "openai", observedAt: evidence.observedAt })).toThrow("PAID_SUCCESSOR_IDENTITY_UNVERIFIED");
    const trusted = new PaidFamilyCatalog(undefined, [approved]);
    expect(() => trusted.discoverSuccessor({ model: { ...successor, family: "glm" }, version: "6", predecessorId: "gpt-5.6-luna", identitySource: source, trustedCatalogProviderId: "openai", observedAt: evidence.observedAt })).toThrow("PAID_FAMILY_MISMATCH");
    expect(() => trusted.discoverSuccessor({ model: successor, version: "6", predecessorId: "gpt-5.6-luna", identitySource: source, trustedCatalogProviderId: "openrouter", observedAt: evidence.observedAt })).toThrow("PAID_SUCCESSOR_IDENTITY_UNVERIFIED");
  });

  it("does not activate a new version before qualification and promotion evidence", () => {
    const catalog = new PaidFamilyCatalog(undefined, [approved]);
    catalog.discoverSuccessor({ model: successor, version: "6", predecessorId: "gpt-5.6-luna", identitySource: source, trustedCatalogProviderId: "openai", observedAt: evidence.observedAt });
    expect(catalog.resolveFamily("luna")?.model.canonicalModelId).toBe("gpt-5.6-luna");
    catalog.beginProbation("luna-6", evidence.observedAt);
    expect(() => catalog.qualify("luna-6", { ...evidence, liveEvidenceId: undefined })).toThrow("PAID_PROMOTION_EVIDENCE_INSUFFICIENT");
    catalog.qualify("luna-6", evidence);
    expect(catalog.resolveFamily("luna")?.model.canonicalModelId).toBe("gpt-5.6-luna");
    catalog.promote("luna-6", evidence, "ACTIVE_ECONOMY");
    expect(catalog.resolveFamily("luna")?.model.canonicalModelId).toBe("luna-6");
    expect(catalog.version("gpt-5.6-luna")?.lifecycle).toBe("ACTIVE_ECONOMY");
    expect(catalog.activeModels().map((model) => model.canonicalModelId)).toContain("gpt-5.6-luna");
    catalog.retire("gpt-5.6-luna", evidence.observedAt);
    expect(catalog.activeModels().map((model) => model.canonicalModelId)).not.toContain("gpt-5.6-luna");
  });

  it("feeds active versions and price changes into the executing role router", () => {
    const catalog = new PaidFamilyCatalog(undefined, [approved]);
    catalog.discoverSuccessor({ model: successor, version: "6", predecessorId: "gpt-5.6-luna", identitySource: source, trustedCatalogProviderId: "openai", observedAt: evidence.observedAt });
    catalog.beginProbation("luna-6", evidence.observedAt);
    catalog.qualify("luna-6", evidence);
    catalog.promote("luna-6", evidence, "SUPERSEDED");
    const routes = Object.fromEntries(catalog.activeModels().flatMap((model) => [model.direct, model.fallback]).map((route) => [route.routeId, { state: "READY", commercialEligibility: "verified", privacy: "verified", capabilityParity: "verified", certification: "CERTIFIED" }]));
    const service = new PaidAutoService({ familyCatalog: catalog, paidExecutionEnabled: true, credentialStore: { get: () => "test-key", set: () => undefined, delete: () => true, has: () => true }, routeQualifications: routes, roleVerdicts: [{ canonicalModelId: "luna-6", role: "CODER", status: "QUALIFIED", measuredAt: evidence.observedAt, source: "proof" }], now: () => Date.parse(evidence.observedAt) });
    expect(service.models().map((model) => model.canonicalModelId)).toContain("luna-6");
    expect(service.selectRoleRoute({ role: "CODER", allowedModelIds: ["luna-6"] }).selected?.canonicalModelId).toBe("luna-6");
    expect(service.selectRoleRoute({ role: "CODER", allowedModelIds: ["glm-5.3-flash"] }).selected?.canonicalModelId).toBe("glm-5.3-flash");
    catalog.updateDirectPricing("luna-6", { ...successor.direct.pricing, inputCostPerMillion: 0.1, outputCostPerMillion: 0.2, status: "CURRENT", source, lastVerified: evidence.observedAt });
    expect(catalog.model("luna-6")?.direct.pricing.outputCostPerMillion).toBe(0.2);
  });

  it("recovers global lifecycle state from durable persistence", async () => {
    const db = new SqliteSessionPersistence();
    try {
      const store = new PaidFamilyCatalogStore(db, [approved]);
      const catalog = await store.load();
      catalog.discoverSuccessor({ model: successor, version: "6", predecessorId: "gpt-5.6-luna", identitySource: source, trustedCatalogProviderId: "openai", observedAt: evidence.observedAt });
      await store.save(catalog);
      expect((await store.load()).version("luna-6")?.lifecycle).toBe("DISCOVERED");
    } finally { await db.close(); }
  });

  /** Discover → probation → qualify → promote the successor, returning the catalog. */
  function promotedCatalog(): PaidFamilyCatalog {
    const catalog = new PaidFamilyCatalog(undefined, [approved]);
    catalog.discoverSuccessor({ model: successor, version: "6", predecessorId: "gpt-5.6-luna", identitySource: source, trustedCatalogProviderId: "openai", observedAt: evidence.observedAt });
    catalog.beginProbation("luna-6", evidence.observedAt);
    catalog.qualify("luna-6", evidence);
    catalog.promote("luna-6", evidence, "ACTIVE_ECONOMY");
    return catalog;
  }

  /** luna-6 ACTIVE → luna-7 promoted over it: luna-6 sits SUPERSEDED with retained evidence. */
  function threeGenerationCatalog(): PaidFamilyCatalog {
    const luna7: PaidAutoModel = { ...successor, canonicalModelId: "luna-7", displayName: "Luna 7", direct: { ...successor.direct, canonicalModelId: "luna-7", routeId: "luna-7:direct", providerModelId: "luna-7" }, fallback: { ...successor.fallback, canonicalModelId: "luna-7", routeId: "luna-7:openrouter", providerModelId: "openai/luna-7" } };
    const approved7: ApprovedPaidSuccessor = { canonicalModelId: "luna-7", familyId: "luna", predecessorId: "luna-6", directProviderId: "openai", directProviderModelId: "luna-7", identitySource: source };
    const catalog = new PaidFamilyCatalog(undefined, [approved, approved7]);
    catalog.discoverSuccessor({ model: successor, version: "6", predecessorId: "gpt-5.6-luna", identitySource: source, trustedCatalogProviderId: "openai", observedAt: evidence.observedAt });
    catalog.beginProbation("luna-6", evidence.observedAt);
    catalog.qualify("luna-6", evidence);
    catalog.promote("luna-6", evidence, "SUPERSEDED");
    const evidence7: PaidPromotionEvidence = { ...evidence, liveEvidenceId: "live-7", benchmarkEvidenceId: "bench-7", observedAt: "2026-09-29T00:00:00.000Z" };
    catalog.discoverSuccessor({ model: luna7, version: "7", predecessorId: "luna-6", identitySource: source, trustedCatalogProviderId: "openai", observedAt: evidence7.observedAt });
    catalog.beginProbation("luna-7", evidence7.observedAt);
    catalog.qualify("luna-7", evidence7);
    catalog.promote("luna-7", evidence7, "SUPERSEDED");
    return catalog;
  }

  it("demotes an ACTIVE version to a previously qualified same-family fallback only", () => {
    const catalog = threeGenerationCatalog();
    expect(catalog.resolveFamily("luna")?.model.canonicalModelId).toBe("luna-7");
    const demotion: PaidPromotionEvidence = { ...evidence, liveEvidenceId: "live-demote-1", observedAt: "2026-09-30T00:00:00.000Z" };
    // The superseded successor carries retained promotion/qualification evidence — it can
    // take over; the active version moves to the requested disposition.
    catalog.demote("luna-7", "luna-6", demotion, "QUALIFIED");
    expect(catalog.version("luna-7")?.lifecycle).toBe("QUALIFIED");
    expect(catalog.version("luna-6")?.lifecycle).toBe("ACTIVE");
    expect(catalog.version("luna-6")?.promotionEvidenceId).toBe("live-demote-1");
    expect(catalog.resolveFamily("luna")?.model.canonicalModelId).toBe("luna-6");
    // The bootstrap predecessor carries explicit registry-derived evidence — Luna 6 can
    // roll back to the provider-available bootstrap Luna 5.6 without fabricating proof.
    catalog.demote("luna-6", "gpt-5.6-luna", demotion, "QUALIFIED");
    expect(catalog.version("gpt-5.6-luna")?.lifecycle).toBe("ACTIVE");
    expect(catalog.version("gpt-5.6-luna")?.promotionEvidenceId).toBe("live-demote-1");
    expect(catalog.version("gpt-5.6-luna")?.qualificationEvidenceId).toBe("bootstrap-registry:gpt-5.6-luna");
    expect(catalog.resolveFamily("luna")?.model.canonicalModelId).toBe("gpt-5.6-luna");
  });

  it("rejects demotion to a cross-family, unqualified, or provider-unavailable fallback", () => {
    const catalog = promotedCatalog();
    const demotion: PaidPromotionEvidence = { ...evidence, liveEvidenceId: "live-demote-2", observedAt: "2026-09-29T00:00:00.000Z" };
    // glm is a different family — identity mismatch, never a name check.
    expect(() => catalog.demote("luna-6", "glm-5.3-flash", demotion, "RETIRED")).toThrow("PAID_FAMILY_MISMATCH");
    // A DISCOVERED version never qualified — it can never serve as the fallback.
    const luna7: PaidAutoModel = { ...successor, canonicalModelId: "luna-7", direct: { ...successor.direct, canonicalModelId: "luna-7", routeId: "luna-7:direct", providerModelId: "luna-7" }, fallback: { ...successor.fallback, canonicalModelId: "luna-7", routeId: "luna-7:openrouter", providerModelId: "openai/luna-7" } };
    const approved7: ApprovedPaidSuccessor = { canonicalModelId: "luna-7", familyId: "luna", predecessorId: "luna-6", directProviderId: "openai", directProviderModelId: "luna-7", identitySource: source };
    const catalog2 = new PaidFamilyCatalog(undefined, [approved, approved7]);
    catalog2.discoverSuccessor({ model: successor, version: "6", predecessorId: "gpt-5.6-luna", identitySource: source, trustedCatalogProviderId: "openai", observedAt: evidence.observedAt });
    catalog2.beginProbation("luna-6", evidence.observedAt);
    catalog2.qualify("luna-6", evidence);
    catalog2.promote("luna-6", evidence, "SUPERSEDED");
    catalog2.discoverSuccessor({ model: luna7, version: "7", predecessorId: "luna-6", identitySource: source, trustedCatalogProviderId: "openai", observedAt: evidence.observedAt });
    expect(() => catalog2.demote("luna-6", "luna-7", demotion, "RETIRED")).toThrow("PAID_LIFECYCLE_INVALID");
    // A provider-unavailable predecessor cannot be reactivated.
    catalog2.setProviderAvailability("gpt-5.6-luna", false, demotion.observedAt);
    expect(() => catalog2.demote("luna-6", "gpt-5.6-luna", demotion, "RETIRED")).toThrow("PAID_FALLBACK_UNAVAILABLE");
    // A hydrated record stripped of retained evidence can never be reactivated either.
    const stripped = new PaidFamilyCatalog(promotedCatalog().all().map((record) =>
      record.model.canonicalModelId === "gpt-5.6-luna" ? { ...record, qualificationEvidenceId: undefined, promotionEvidenceId: undefined } : record));
    expect(() => stripped.demote("luna-6", "gpt-5.6-luna", demotion, "RETIRED")).toThrow("PAID_DEMOTION_EVIDENCE_MISSING");
  });

  it("excludes provider-unavailable versions from activeModels and resolveFamily without touching evidence", () => {
    const catalog = promotedCatalog();
    catalog.setProviderAvailability("luna-6", false, "2026-09-30T00:00:00.000Z");
    // The unavailable ACTIVE no longer resolves — the fallback's lifecycle is untouched.
    expect(catalog.activeModels().map((model) => model.canonicalModelId)).not.toContain("luna-6");
    expect(catalog.resolveFamily("luna")).toBeUndefined();
    expect(catalog.version("luna-6")?.lifecycle).toBe("ACTIVE");
    // Availability restoration is immediate and never fabricates qualification.
    catalog.setProviderAvailability("luna-6", true, "2026-09-30T01:00:00.000Z");
    expect(catalog.resolveFamily("luna")?.model.canonicalModelId).toBe("luna-6");
  });

  it("keeps a provider-unavailable exact pin unavailable rather than substituting", () => {
    const catalog = promotedCatalog();
    catalog.setProviderAvailability("luna-6", false, "2026-09-30T00:00:00.000Z");
    const routes = Object.fromEntries(catalog.all().flatMap((record) => [record.model.direct, record.model.fallback]).map((route) => [route.routeId, { state: "READY", commercialEligibility: "verified", privacy: "verified", capabilityParity: "verified", certification: "CERTIFIED" }]));
    const service = new PaidAutoService({ familyCatalog: catalog, paidExecutionEnabled: true, credentialStore: { get: () => "test-key", set: () => undefined, delete: () => true, has: () => true }, routeQualifications: routes, roleVerdicts: [{ canonicalModelId: "luna-6", role: "CODER", status: "QUALIFIED", measuredAt: evidence.observedAt, source: "proof" }], now: () => Date.parse(evidence.observedAt) });
    // The pinned canonical is invisible to activeModels → the router cannot select it and
    // the adapter refuses it; nothing silently slides to another family member.
    expect(service.models().map((model) => model.canonicalModelId)).not.toContain("luna-6");
    expect(service.asProviderAdapter().canRoute("luna-6")).toBe(false);
    expect(service.selectRoleRoute({ role: "CODER", allowedModelIds: ["luna-6"] }).selected).toBeUndefined();
  });

  it("does not disturb retained qualification/promotion evidence on a price update", () => {
    const catalog = promotedCatalog();
    expect(catalog.version("luna-6")?.promotionEvidenceId).toBe("live-1");
    catalog.updateDirectPricing("luna-6", { ...successor.direct.pricing, inputCostPerMillion: 0.11, outputCostPerMillion: 0.22, status: "CURRENT", source, lastVerified: "2026-10-01T00:00:00.000Z" });
    const record = catalog.version("luna-6")!;
    expect(record.promotionEvidenceId).toBe("live-1");
    expect(record.qualificationEvidenceId).toBe("live-1");
    expect(record.lifecycle).toBe("ACTIVE");
    expect(record.model.direct.pricing.inputCostPerMillion).toBe(0.11);
    // A stale/unpriced update is still refused outright.
    expect(() => catalog.updateDirectPricing("luna-6", { ...successor.direct.pricing, status: "UNKNOWN", inputCostPerMillion: null })).toThrow("PAID_PRICE_UNVERIFIED");
  });

  it("rejects corrupt hydrated state — duplicates, family mismatch, bad lifecycle, double ACTIVE", () => {
    const catalog = promotedCatalog();
    const clean = catalog.all();
    expect(() => new PaidFamilyCatalog([...clean, clean[0]!])).toThrow("PAID_VERSION_DUPLICATE");
    expect(() => new PaidFamilyCatalog(clean.map((record) => record.model.canonicalModelId === "luna-6" ? { ...record, lifecycle: "BOGUS" as never } : record))).toThrow("PAID_LIFECYCLE_INVALID");
    expect(() => new PaidFamilyCatalog(clean.map((record) => record.model.canonicalModelId === "luna-6" ? { ...record, predecessorId: "glm-5.3-flash" } : record))).toThrow("PAID_FAMILY_MISMATCH");
    expect(() => new PaidFamilyCatalog(clean.map((record) => record.model.canonicalModelId === "gpt-5.6-luna" ? { ...record, lifecycle: "ACTIVE" as const } : record))).toThrow("PAID_FAMILY_ACTIVE_CONFLICT");
    // Pre-wave-2 records without providerAvailable hydrate as available.
    const legacy = clean.map(({ providerAvailable: _dropped, ...rest }) => rest) as never[];
    const hydrated = new PaidFamilyCatalog(legacy);
    expect(hydrated.version("luna-6")?.providerAvailable).toBe(true);
    expect(hydrated.resolveFamily("luna")?.model.canonicalModelId).toBe("luna-6");
  });

  it("hydrates valid records regardless of persisted order and stays atomic on failure", () => {
    const catalog = promotedCatalog();
    // Child persisted before its predecessor: pass-two referential checks run on the
    // complete collected set, never on insertion order.
    const reversed = [...catalog.all()].reverse();
    const hydrated = new PaidFamilyCatalog(reversed);
    expect(hydrated.version("luna-6")?.lifecycle).toBe("ACTIVE");
    expect(hydrated.version("luna-6")?.predecessorId).toBe("gpt-5.6-luna");
    expect(hydrated.resolveFamily("luna")?.model.canonicalModelId).toBe("luna-6");
    // A rejected hydrate leaves the previously valid catalog completely unchanged.
    const corrupt = reversed.map((record) => record.model.canonicalModelId === "luna-6" ? { ...record, predecessorId: "glm-5.3-flash" } : record);
    expect(() => hydrated.hydrate(corrupt)).toThrow("PAID_FAMILY_MISMATCH");
    expect(hydrated.version("luna-6")?.lifecycle).toBe("ACTIVE");
    expect(hydrated.version("gpt-5.6-luna")?.lifecycle).toBe("ACTIVE_ECONOMY");
  });

  it("resolves the provider-available ACTIVE version as AUTO_CURRENT after a restart", async () => {
    const db = new SqliteSessionPersistence();
    try {
      const store = new PaidFamilyCatalogStore(db, [approved]);
      const catalog = promotedCatalog();
      await store.save(catalog);
      // Restart — the reloaded catalog resolves the same active successor.
      const reloaded = await store.load();
      expect(reloaded.resolveFamily("luna")?.model.canonicalModelId).toBe("luna-6");
      // Provider-unavailable persistence: a restart keeps the flag, so AUTO_CURRENT resolves
      // to nothing rather than resurrecting a stale or superseded pick.
      reloaded.setProviderAvailability("luna-6", false, "2026-10-02T00:00:00.000Z");
      await store.save(reloaded);
      const afterUnavailable = await store.load();
      expect(afterUnavailable.version("luna-6")?.providerAvailable).toBe(false);
      expect(afterUnavailable.resolveFamily("luna")).toBeUndefined();
      afterUnavailable.setProviderAvailability("luna-6", true, "2026-10-03T00:00:00.000Z");
      await store.save(afterUnavailable);
      expect((await store.load()).resolveFamily("luna")?.model.canonicalModelId).toBe("luna-6");
    } finally { await db.close(); }
  });
});
