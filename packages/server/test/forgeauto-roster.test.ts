import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteSessionPersistence } from "@codeforge/sessions";
import { ForgeAutoRosterStore, resolveForgeAutoRole, rosterRouteAllowance, validateForgeAutoRoster, type ForgeAutoRoster, type RosterCandidate, type RosterPolicy } from "../src/forgeauto-roster.js";
import { PaidAutoService, PaidFamilyCatalog, PaidFamilyCatalogStore, type ApprovedPaidSuccessor, type PaidAutoModel, type PaidPromotionEvidence } from "@codeforge/paid-auto";

const catalog: RosterCandidate[] = [
  { modelId: "free-a", providerId: "groq", providerModelId: "a", routes: [{ providerId: "groq", modelId: "a" }], familyId: "free-a", version: "1", sourceClass: "MANAGED_FREE", lifecycle: "ACTIVE", available: true, approved: true, qualifiedRoles: ["CODER", "REVIEWER", "LEAD"], dataPolicy: { privateCode: true } },
  { modelId: "free-b", providerId: "mistral", providerModelId: "b", familyId: "free-b", version: "1", sourceClass: "MANAGED_FREE", lifecycle: "ACTIVE", available: true, approved: true, qualifiedRoles: ["CODER", "REVIEWER"], dataPolicy: { privateCode: false, userConsentRequired: true } },
  { modelId: "gpt-5.6-luna", providerId: "openai", providerModelId: "gpt-5.6-luna", familyId: "luna", version: "5.6", sourceClass: "MANAGED_PAID", lifecycle: "ACTIVE", available: true, approved: true, qualifiedRoles: ["CODER", "REVIEWER", "LEAD"], dataPolicy: { privateCode: true } },
  { modelId: "luna-6", providerId: "openai", providerModelId: "luna-6", familyId: "luna", version: "6", sourceClass: "MANAGED_PAID", lifecycle: "PROBATION", available: true, approved: true, qualifiedRoles: ["LEAD"], dataPolicy: { privateCode: true } },
  { modelId: "user-one", providerId: "custom", providerModelId: "private", familyId: "private", version: "1", sourceClass: "USER_API", lifecycle: "ACTIVE", available: true, approved: true, qualifiedRoles: ["CODER"], ownerUserId: "alice", credentialRef: "vault:alice", dataPolicy: { privateCode: true } },
];

function roster(ownerUserId = "alice", entitlement: ForgeAutoRoster["entitlement"] = "FREE"): ForgeAutoRoster {
  return { ownerUserId, entitlement, slots: [{ kind: "PINNED_VERSION", modelId: "free-a", enabled: true }, { kind: "PINNED_VERSION", modelId: "free-b", enabled: true }], lead: { mode: "NONE" }, updatedAt: "2026-09-28T00:00:00.000Z" };
}

describe("R55 ForgeAuto roster", () => {
  it("enforces compact size, duplicate and plan eligibility", () => {
    expect(() => validateForgeAutoRoster({ ...roster(), slots: [] }, catalog)).toThrow("ROSTER_EMPTY");
    expect(() => validateForgeAutoRoster({ ...roster(), slots: [{ kind: "PINNED_VERSION", modelId: "free-a", enabled: true }] }, catalog)).toThrow("ROSTER_TOO_SMALL");
    expect(() => validateForgeAutoRoster({ ...roster(), slots: Array.from({ length: 6 }, () => ({ kind: "AUTO", sourceClass: "MANAGED_FREE" as const, enabled: true })) }, catalog)).toThrow("ROSTER_TOO_LARGE");
    expect(() => validateForgeAutoRoster({ ...roster(), slots: [{ kind: "PINNED_VERSION", modelId: "free-a", enabled: true }, { kind: "PINNED_VERSION", modelId: "free-a", enabled: true }] }, catalog)).toThrow("ROSTER_DUPLICATE_SLOT");
    expect(() => validateForgeAutoRoster({ ...roster(), slots: [{ kind: "PINNED_VERSION", modelId: "free-a", enabled: true }, { kind: "PINNED_VERSION", modelId: "gpt-5.6-luna", enabled: true }] }, catalog)).toThrow("ROSTER_MODEL_INELIGIBLE");
    expect(() => validateForgeAutoRoster({ ...roster(), slots: [{ kind: "PINNED_VERSION", modelId: "free-a", enabled: true }, { kind: "PINNED_VERSION", modelId: "user-one", enabled: true }] }, catalog)).toThrow("ROSTER_MODEL_INELIGIBLE");
    expect(() => validateForgeAutoRoster({ ...roster(), slots: [{ kind: "PINNED_VERSION", modelId: "free-a", enabled: true }] }, catalog, { minSlots: 1, maxSlots: 3, allowSingleModel: true })).not.toThrow();
  });

  it("keeps a paid lead optional and never forces paid workers", () => {
    const paid: ForgeAutoRoster = { ...roster("alice", "PAID"), slots: [{ kind: "PINNED_VERSION", modelId: "gpt-5.6-luna", allowedRoles: ["LEAD"], enabled: true }, { kind: "PINNED_VERSION", modelId: "free-a", allowedRoles: ["CODER"], enabled: true }], lead: { mode: "MANUAL", slotIndex: 0 } };
    validateForgeAutoRoster(paid, catalog);
    expect(resolveForgeAutoRole(paid, catalog, "LEAD").candidates.map((entry) => entry.modelId)).toEqual(["gpt-5.6-luna"]);
    expect(resolveForgeAutoRole(paid, catalog, "CODER").candidates.map((entry) => entry.modelId)).toEqual(["free-a"]);
    expect(rosterRouteAllowance(resolveForgeAutoRole(paid, catalog, "CODER")).paidModelIds).toEqual([]);
  });

  it("preserves pins, follows only certified same-family current versions, and reports loss", () => {
    const paid: ForgeAutoRoster = { ...roster("alice", "PAID"), slots: [{ kind: "PINNED_VERSION", modelId: "gpt-5.6-luna", enabled: true }, { kind: "AUTO_CURRENT", familyId: "luna", sourceClass: "MANAGED_PAID", enabled: true }], lead: { mode: "AUTO" } };
    expect(resolveForgeAutoRole(paid, catalog, "CODER").candidates.map((entry) => entry.modelId)).toEqual(["gpt-5.6-luna"]);
    const promoted = catalog.map((entry) => entry.modelId === "gpt-5.6-luna" ? { ...entry, lifecycle: "SUPERSEDED" as const } : entry.modelId === "luna-6" ? { ...entry, lifecycle: "ACTIVE" as const, qualifiedRoles: ["CODER", "LEAD"] as const } : entry);
    expect(resolveForgeAutoRole(paid, promoted, "CODER").candidates.map((entry) => entry.modelId)).toEqual(["gpt-5.6-luna", "luna-6"]);
    const retired = promoted.map((entry) => entry.modelId === "gpt-5.6-luna" ? { ...entry, available: false } : entry);
    const result = resolveForgeAutoRole(paid, retired, "CODER");
    expect(result.candidates.map((entry) => entry.modelId)).toEqual(["luna-6"]);
    expect(result.rejected).toContainEqual({ slotIndex: 0, reason: "PINNED_MODEL_UNAVAILABLE" });
  });

  it("rejects a MANUAL lead slot that resolves no LEAD-qualified candidate at write time", () => {
    // Slot 0 is authorized for the owner but qualified only for CODER — a manual Lead
    // pointer to it would dangle, so validation refuses to save the roster.
    const dangling: ForgeAutoRoster = {
      ...roster("alice", "PAID"),
      slots: [
        { kind: "PINNED_VERSION", modelId: "free-b", allowedRoles: ["LEAD"], enabled: true },
        { kind: "PINNED_VERSION", modelId: "free-a", allowedRoles: ["CODER"], enabled: true },
      ],
      lead: { mode: "MANUAL", slotIndex: 0 },
    };
    expect(() => validateForgeAutoRoster(dangling, catalog)).toThrow("ROSTER_LEAD_INVALID");
    // A manual Lead slot that does resolve stays valid.
    const resolvable: ForgeAutoRoster = {
      ...roster("alice", "PAID"),
      slots: [
        { kind: "PINNED_VERSION", modelId: "free-a", allowedRoles: ["LEAD", "CODER"], enabled: true },
        { kind: "PINNED_VERSION", modelId: "free-b", allowedRoles: ["REVIEWER"], enabled: true },
      ],
      lead: { mode: "MANUAL", slotIndex: 0 },
    };
    expect(() => validateForgeAutoRoster(resolvable, catalog)).not.toThrow();
  });

  it("rejects slots that can select the same candidate for an overlapping role", () => {
    // Exact pin + unrestricted AUTO paid pool: gpt-5.6-luna sits in both — a hidden
    // double route is refused at validation.
    const overlap: ForgeAutoRoster = {
      ...roster("alice", "PAID"),
      slots: [
        { kind: "PINNED_VERSION", modelId: "gpt-5.6-luna", enabled: true },
        { kind: "AUTO", sourceClass: "MANAGED_PAID", enabled: true },
      ],
    };
    expect(() => validateForgeAutoRoster(overlap, catalog)).toThrow("ROSTER_CONFLICTING_SLOTS");
    // Pin + AUTO_CURRENT of the same family overlap exactly when the pin IS the ACTIVE.
    const currentOverlap: ForgeAutoRoster = {
      ...roster("alice", "PAID"),
      slots: [
        { kind: "PINNED_VERSION", modelId: "gpt-5.6-luna", enabled: true },
        { kind: "AUTO_CURRENT", familyId: "luna", sourceClass: "MANAGED_PAID", enabled: true },
      ],
    };
    expect(() => validateForgeAutoRoster(currentOverlap, catalog)).toThrow("ROSTER_CONFLICTING_SLOTS");
    // Disjoint allowedRoles may coexist even when the candidate sets overlap.
    const disjointRoles: ForgeAutoRoster = {
      ...roster("alice", "PAID"),
      slots: [
        { kind: "PINNED_VERSION", modelId: "gpt-5.6-luna", allowedRoles: ["LEAD"], enabled: true },
        { kind: "AUTO", sourceClass: "MANAGED_PAID", allowedRoles: ["CODER"], enabled: true },
      ],
    };
    expect(() => validateForgeAutoRoster(disjointRoles, catalog)).not.toThrow();
    // Disjoint candidate sets may coexist even when the roles overlap.
    const disjointCandidates: ForgeAutoRoster = {
      ...roster("alice", "PAID"),
      slots: [
        { kind: "PINNED_VERSION", modelId: "free-a", allowedRoles: ["CODER"], enabled: true },
        { kind: "AUTO", sourceClass: "MANAGED_PAID", allowedRoles: ["CODER"], enabled: true },
      ],
    };
    expect(() => validateForgeAutoRoster(disjointCandidates, catalog)).not.toThrow();
  });

  it("reports a pin's unavailability and role ineligibility as distinct reasons", () => {
    const paid = roster("alice", "PAID");
    // A retired pin validates as configured intent but resolves as action-required.
    const retiredMap = new Map(catalog.map((entry) => [entry.modelId, { ...entry }]));
    retiredMap.set("gpt-5.6-luna", { ...retiredMap.get("gpt-5.6-luna")!, lifecycle: "RETIRED", available: false });
    const retiredCatalog = [...retiredMap.values()];
    const retiredPin: ForgeAutoRoster = {
      ...paid,
      slots: [
        { kind: "PINNED_VERSION", modelId: "gpt-5.6-luna", allowedRoles: ["CODER"], enabled: true },
        { kind: "PINNED_VERSION", modelId: "free-b", allowedRoles: ["TESTER"], enabled: true },
      ],
    };
    expect(() => validateForgeAutoRoster(retiredPin, retiredCatalog)).not.toThrow();
    const unavailable = resolveForgeAutoRole(retiredPin, retiredCatalog, "CODER");
    expect(unavailable.status).toBe("UNAVAILABLE_ACTION_REQUIRED");
    expect(unavailable.rejected).toContainEqual({ slotIndex: 0, reason: "PINNED_MODEL_UNAVAILABLE" });

    // An available pin that simply does not qualify for the requested role is a different
    // failure — NO_ELIGIBLE_ROLE_MODEL with the role-ineligible reason, never "unavailable".
    const leadOnly = catalog.map((entry) => entry.modelId === "gpt-5.6-luna"
      ? { ...entry, qualifiedRoles: ["LEAD" as const] }
      : entry);
    const ineligiblePin: ForgeAutoRoster = {
      ...paid,
      slots: [
        { kind: "PINNED_VERSION", modelId: "gpt-5.6-luna", allowedRoles: ["CODER"], enabled: true },
        { kind: "PINNED_VERSION", modelId: "free-b", allowedRoles: ["TESTER"], enabled: true },
      ],
    };
    expect(() => validateForgeAutoRoster(ineligiblePin, leadOnly)).not.toThrow();
    const roleIneligible = resolveForgeAutoRole(ineligiblePin, leadOnly, "CODER");
    expect(roleIneligible.status).toBe("NO_ELIGIBLE_ROLE_MODEL");
    expect(roleIneligible.rejected).toContainEqual({ slotIndex: 0, reason: "PINNED_MODEL_ROLE_INELIGIBLE" });
  });

  it("resolves AUTO_CURRENT to the real ACTIVE successor even when the economy predecessor lists first", async () => {
    // R55 wave-2 critical fix: paid candidates carry the family record's exact lifecycle.
    // Build a real family catalog where luna-6 is ACTIVE and the bootstrap gpt-5.6-luna
    // (listed first) sits ACTIVE_ECONOMY — then project candidates exactly as
    // CodeForgeServer.rosterCatalog() does.
    const source = "https://provider.example/catalog/luna-6";
    const lunaModel: PaidAutoModel = {
      canonicalModelId: "luna-6", displayName: "Luna 6", family: "luna",
      contextWindow: 1_100_000, maxOutput: 128_000,
      capabilities: { text: true, coding: true, toolCalling: true, vision: true, structuredOutput: true, longContext: true },
      direct: { routeId: "luna-6:direct", canonicalModelId: "luna-6", kind: "direct", providerId: "openai", providerModelId: "luna-6", priority: 1, source, pricing: { inputCostPerMillion: 0.3, outputCostPerMillion: 1.8, currency: "USD", unit: "USD_PER_MILLION_TOKENS", effectiveDate: "2026-09-28", lastVerified: "2026-09-28T00:00:00.000Z", status: "CURRENT", source } },
      fallback: { routeId: "luna-6:openrouter", canonicalModelId: "luna-6", kind: "openrouter", providerId: "openrouter", providerModelId: "openai/luna-6", priority: 2, source: "https://openrouter.ai/openai/luna-6", pricing: { inputCostPerMillion: null, outputCostPerMillion: null, currency: "USD", unit: "USD_PER_MILLION_TOKENS", effectiveDate: "2026-09-28", lastVerified: "2026-09-28T00:00:00.000Z", status: "UNKNOWN", source: "https://openrouter.ai/openai/luna-6" } },
      verification: { verifiedAt: "2026-09-28T00:00:00.000Z", sources: [source] },
    };
    const approval: ApprovedPaidSuccessor = { canonicalModelId: "luna-6", familyId: "luna", predecessorId: "gpt-5.6-luna", directProviderId: "openai", directProviderModelId: "luna-6", identitySource: source };
    const evidence: PaidPromotionEvidence = { role: "CODER", roleQualification: "QUALIFIED", benchmarkEvidenceId: "bench-r", liveEvidenceId: "live-r", verifiedCompletionRate: 0.9, reliability: 0.95, latencyMs: 500, inputPricePerMillion: 0.3, outputPricePerMillion: 1.8, shPerVerifiedTask: null, incumbentCostPerVerifiedTaskUsd: 0.04, candidateCostPerVerifiedTaskUsd: 0.05, priceSource: source, observedAt: "2026-09-28T00:00:00.000Z" };
    const buildCatalog = (): PaidFamilyCatalog => {
      const families = new PaidFamilyCatalog(undefined, [approval]);
      families.discoverSuccessor({ model: lunaModel, version: "6", predecessorId: "gpt-5.6-luna", identitySource: source, trustedCatalogProviderId: "openai", observedAt: evidence.observedAt });
      families.beginProbation("luna-6", evidence.observedAt);
      families.qualify("luna-6", evidence);
      families.promote("luna-6", evidence, "ACTIVE_ECONOMY");
      return families;
    };
    const projectPaid = (service: PaidAutoService): RosterCandidate[] =>
      service.modelViews().map((view) => {
        const model = service.getModel(view.id)!;
        const record = service.familyVersion(view.id)!;
        return {
          modelId: model.canonicalModelId, providerId: model.direct.providerId, providerModelId: model.direct.providerModelId,
          familyId: model.family, version: model.canonicalModelId, sourceClass: "MANAGED_PAID" as const,
          lifecycle: record.lifecycle, approved: true, available: view.available && record.providerAvailable,
          qualifiedRoles: ["CODER" as const, "LEAD" as const], dataPolicy: { privateCode: true },
        };
      });
    const familyCatalog = buildCatalog();
    const paidCredentials = { get: () => "test-key", set: () => undefined, delete: () => true, has: () => true };
    const routeQuals = (families: PaidFamilyCatalog) =>
      Object.fromEntries(families.activeModels().flatMap((m) => [m.direct, m.fallback]).map((route) => [route.routeId, { state: "READY" as const, commercialEligibility: "verified" as const, privacy: "verified" as const, capabilityParity: "verified" as const, certification: "CERTIFIED" as const }]));
    const service = new PaidAutoService({ familyCatalog, paidExecutionEnabled: true, credentialStore: paidCredentials, routeQualifications: routeQuals(familyCatalog) });
    const paidCandidates = projectPaid(service);
    // Ordering: the ACTIVE_ECONOMY predecessor lists before its ACTIVE successor.
    const lunaIds = paidCandidates.filter((entry) => entry.familyId === "luna").map((entry) => entry.modelId);
    expect(lunaIds).toEqual(["gpt-5.6-luna", "luna-6"]);
    expect(paidCandidates.find((entry) => entry.modelId === "gpt-5.6-luna")!.lifecycle).toBe("ACTIVE_ECONOMY");
    expect(paidCandidates.find((entry) => entry.modelId === "luna-6")!.lifecycle).toBe("ACTIVE");

    const projectedCatalog = [...catalog.filter((entry) => entry.sourceClass !== "MANAGED_PAID"), ...paidCandidates];
    const currentRoster: ForgeAutoRoster = {
      ...roster("alice", "PAID"),
      slots: [{ kind: "AUTO_CURRENT", familyId: "luna", sourceClass: "MANAGED_PAID", enabled: true }],
      lead: { mode: "NONE" },
    };
    // AUTO_CURRENT resolves the ACTIVE successor — never the cheaper economy predecessor.
    expect(resolveForgeAutoRole(currentRoster, projectedCatalog, "CODER").candidates.map((entry) => entry.modelId)).toEqual(["luna-6"]);
    // An explicit pin still names the economy predecessor exactly.
    const pinRoster: ForgeAutoRoster = {
      ...roster("alice", "PAID"),
      slots: [{ kind: "PINNED_VERSION", modelId: "gpt-5.6-luna", enabled: true }],
      lead: { mode: "NONE" },
    };
    expect(resolveForgeAutoRole(pinRoster, projectedCatalog, "CODER").candidates.map((entry) => entry.modelId)).toEqual(["gpt-5.6-luna"]);

    // The same projection holds after the catalog survives a persistence round-trip.
    const dir = mkdtempSync(join(process.cwd(), ".forgeauto-family-test-"));
    const dbPath = join(dir, "sessions.sqlite");
    try {
      const store1 = new SqliteSessionPersistence({ dbPath });
      await new PaidFamilyCatalogStore(store1, [approval]).save(familyCatalog);
      await store1.close();
      const store2 = new SqliteSessionPersistence({ dbPath });
      const reloaded = await new PaidFamilyCatalogStore(store2, [approval]).load();
      const reloadedCandidates = projectPaid(new PaidAutoService({ familyCatalog: reloaded, paidExecutionEnabled: true, credentialStore: paidCredentials, routeQualifications: routeQuals(reloaded) }));
      const reloadedCatalog = [...catalog.filter((entry) => entry.sourceClass !== "MANAGED_PAID"), ...reloadedCandidates];
      expect(resolveForgeAutoRole(currentRoster, reloadedCatalog, "CODER").candidates.map((entry) => entry.modelId)).toEqual(["luna-6"]);
      expect(resolveForgeAutoRole(pinRoster, reloadedCatalog, "CODER").candidates.map((entry) => entry.modelId)).toEqual(["gpt-5.6-luna"]);
      await store2.close();
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows can retain the SQLite WAL until process exit. */ }
    }
  });

  it("requires user ownership, qualification and data-policy consent", () => {
    const custom: ForgeAutoRoster = { ...roster("alice", "CUSTOM"), slots: [{ kind: "PINNED_VERSION", modelId: "user-one", enabled: true }, { kind: "PINNED_VERSION", modelId: "free-b", enabled: true }] };
    validateForgeAutoRoster(custom, catalog);
    expect(resolveForgeAutoRole(custom, catalog, "REVIEWER", { privateCode: true, userConsented: false }).candidates).toEqual([]);
    expect(resolveForgeAutoRole(custom, catalog, "CODER", { privateCode: true, userConsented: false }).candidates.map((entry) => entry.modelId)).toEqual(["user-one"]);
    expect(() => validateForgeAutoRoster({ ...custom, ownerUserId: "bob" }, catalog)).toThrow("ROSTER_MODEL_INELIGIBLE");
  });

  it("persists by owner across restart without mixing users", async () => {
    const dir = mkdtempSync(join(process.cwd(), ".forgeauto-roster-test-"));
    const path = join(dir, "sessions.sqlite");
    try {
      const first = new SqliteSessionPersistence({ dbPath: path });
      const store = new ForgeAutoRosterStore(first);
      await store.put("alice", roster(), catalog);
      await expect(store.put("bob", roster(), catalog)).rejects.toThrow("ROSTER_OWNER_MISMATCH");
      await first.close();
      const restarted = new SqliteSessionPersistence({ dbPath: path });
      const reopened = new ForgeAutoRosterStore(restarted);
      expect(await reopened.get("alice")).toEqual(roster());
      expect(await reopened.get("bob")).toBeUndefined();
      await restarted.close();
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows can retain the SQLite WAL until process exit. */ }
    }
  });
});

describe("R55 — user-owned source classes in the roster", () => {
  const NOW = new Date().toISOString();
  // Single-slot rosters isolate the source-class gate under test.
  const SINGLE_SLOT: RosterPolicy = { minSlots: 1, maxSlots: 5, allowSingleModel: true };

  const userApiCandidate = (ownerUserId: string, sourceId: string): RosterCandidate => ({
    modelId: `${sourceId}/${sourceId}-model`,
    providerId: `user-api-${sourceId}`,
    providerModelId: `${sourceId}-model`,
    familyId: `${sourceId}-family`,
    version: "1.0.0",
    sourceClass: "USER_API",
    lifecycle: "ACTIVE",
    approved: true,
    available: true,
    qualifiedRoles: ["CODER"],
    ownerUserId,
    sourceId,
    inputCostPerMillion: 1,
    outputCostPerMillion: 2,
    costConfidence: "OBSERVED",
    priceSource: "user-declared",
    dataPolicy: { privateCode: true },
  });

  const customRoster = (ownerUserId: string, slots: ForgeAutoRoster["slots"]): ForgeAutoRoster =>
    ({ ownerUserId, entitlement: "CUSTOM", slots, lead: { mode: "NONE" }, updatedAt: NOW });

  it("fails closed for USER_HOSTED and LOCAL — schema values, never executable in V1", () => {
    for (const sourceClass of ["USER_HOSTED", "LOCAL"] as const) {
      const auto = customRoster("alice", [{ kind: "AUTO", sourceClass, enabled: true }]);
      expect(() => validateForgeAutoRoster(auto, catalog, SINGLE_SLOT)).toThrow("ROSTER_SOURCE_NOT_EXECUTABLE_V1");
      const resolution = resolveForgeAutoRole(auto, catalog, "CODER");
      expect(resolution.status).toBe("NO_ELIGIBLE_ROLE_MODEL");
      expect(resolution.rejected[0]?.reason).toBe("ROSTER_SOURCE_NOT_EXECUTABLE_V1");
      expect(rosterRouteAllowance(resolution).userRoutes).toEqual([]);
    }
    const hostedCandidate: RosterCandidate = { ...userApiCandidate("alice", "hosted-src"), sourceClass: "USER_HOSTED" };
    const pin = customRoster("alice", [{ kind: "PINNED_VERSION", modelId: hostedCandidate.modelId, enabled: true }]);
    expect(() => validateForgeAutoRoster(pin, [hostedCandidate], SINGLE_SLOT)).toThrow("ROSTER_SOURCE_NOT_EXECUTABLE_V1");
    expect(resolveForgeAutoRole(pin, [hostedCandidate], "CODER").rejected[0]?.reason).toBe("ROSTER_SOURCE_NOT_EXECUTABLE_V1");
  });

  it("keeps USER_API candidates owner-scoped through validation and resolution", () => {
    const aliceCandidate = userApiCandidate("alice", "alice-src");
    const bobCandidate = userApiCandidate("bob", "bob-src");
    const shared = [...catalog, aliceCandidate, bobCandidate];

    // Bob's roster cannot pin or auto-select Alice's candidate even when it is present.
    const bobPin = customRoster("bob", [{ kind: "PINNED_VERSION", modelId: aliceCandidate.modelId, enabled: true }]);
    expect(() => validateForgeAutoRoster(bobPin, shared, SINGLE_SLOT)).toThrow("ROSTER_MODEL_INELIGIBLE");

    const bobAuto = customRoster("bob", [{ kind: "AUTO", sourceClass: "USER_API", enabled: true }]);
    const bobResolution = resolveForgeAutoRole(bobAuto, shared, "CODER");
    expect(bobResolution.status).toBe("READY");
    expect(bobResolution.candidates.map((entry) => entry.sourceId)).toEqual(["bob-src"]);

    // Alice's pool admits exactly her own sources — the catalog's `user-one` fixture is
    // alice-owned, bob-src is not.
    const aliceAuto = customRoster("alice", [{ kind: "AUTO", sourceClass: "USER_API", enabled: true }]);
    const aliceResolution = resolveForgeAutoRole(aliceAuto, shared, "CODER");
    expect(aliceResolution.candidates.map((entry) => entry.sourceId)).toEqual([undefined, "alice-src"]);
  });

  it("projects an exact user pin and an AUTO user pool into userRoutes", () => {
    const aliceCandidate = userApiCandidate("alice", "alice-src");
    const shared = [...catalog, aliceCandidate];

    const pinned = resolveForgeAutoRole(
      customRoster("alice", [{ kind: "PINNED_VERSION", modelId: aliceCandidate.modelId, enabled: true }]),
      shared,
      "CODER",
      { privateCode: true, userConsented: false },
    );
    expect(pinned.status).toBe("READY");
    const pinnedRoutes = rosterRouteAllowance(pinned).userRoutes;
    expect(pinnedRoutes).toEqual([{
      sourceId: "alice-src",
      providerId: "user-api-alice-src",
      modelId: "alice-src-model",
      sourceClass: "USER_API",
      pinned: true,
      inputCostPerMillion: 1,
      outputCostPerMillion: 2,
      costConfidence: "OBSERVED",
      priceSource: "user-declared",
    }]);

    const auto = resolveForgeAutoRole(
      customRoster("alice", [{ kind: "AUTO", sourceClass: "USER_API", enabled: true }]),
      shared,
      "CODER",
      { privateCode: true, userConsented: false },
    );
    const autoRoutes = rosterRouteAllowance(auto).userRoutes;
    // The AUTO pool carries every alice-owned USER_API candidate — never pinned.
    expect(autoRoutes).toHaveLength(2);
    expect(autoRoutes.every((route) => !route.pinned)).toBe(true);
    expect(autoRoutes.find((route) => route.sourceId === "alice-src")).toMatchObject({ providerId: "user-api-alice-src", modelId: "alice-src-model" });
  });

  it("populates bounded decision audit only when the caller supplies identity", () => {
    const aliceCandidate = userApiCandidate("alice", "alice-src");
    const shared = [...catalog, aliceCandidate];
    const roster = customRoster("alice", [{ kind: "AUTO", sourceClass: "USER_API", enabled: true }]);
    const resolution = resolveForgeAutoRole(roster, shared, "CODER", { privateCode: true, userConsented: false });

    // No audit → no decision block at all.
    expect(rosterRouteAllowance(resolution).decision).toBeUndefined();

    const audited = rosterRouteAllowance(resolution, { ownerUserId: "alice", rosterUpdatedAt: roster.updatedAt, role: "CODER" });
    expect(audited.decision).toBeDefined();
    expect(audited.decision!.ownerUserId).toBe("alice");
    expect(audited.decision!.rosterUpdatedAt).toBe(roster.updatedAt);
    expect(audited.decision!.role).toBe("CODER");
    // Candidate evidence is identity + lifecycle only — a serialized decision can never
    // carry a credential ref, endpoint, prompt, or body.
    for (const candidate of audited.decision!.candidates) {
      expect(Object.keys(candidate).sort()).toEqual(["familyId", "lifecycle", "modelId", "providerId", "providerModelId", "sourceClass", "version"]);
    }
    const serialized = JSON.stringify(audited);
    expect(serialized).not.toContain("credentialRef");
    expect(serialized).not.toContain("vault:alice");
  });
});
