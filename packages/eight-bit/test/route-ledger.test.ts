import { describe, expect, it } from "vitest";
import type { CapacityRoute, CapacityWindow, ProviderCapacityPool } from "@codeforge/forge-zero";
import { buildRouteLedger, findOwnershipViolations, aggregateSupplyDomains, type RouteLedgerEntry } from "../src/route-ledger.js";
import { EightBitMeasuredHealthTracker, type EightBitRouteMeasurement } from "../src/measured-health.js";

const NOW = Date.parse("2026-09-21T00:00:00.000Z");
const OBSERVED_AT = "2026-09-20T23:00:00.000Z";

function quotaWindow(overrides: Partial<CapacityWindow> = {}): CapacityWindow {
  return { unit: "requests", limit: 1000, remaining: 900, resetAt: "2026-09-22T00:00:00.000Z", scope: "ORG", observedAt: OBSERVED_AT, authoritative: true, period: "DAILY_RESET", ...overrides };
}

function route(id: string, overrides: Partial<CapacityRoute> = {}): CapacityRoute {
  return {
    routeId: id,
    providerId: "managed-a",
    modelId: `${id}-model`,
    canonicalModelId: `${id}-model`,
    family: id,
    gateway: "managed-a",
    supplyClass: "PURE_MANAGED_FREE",
    capacityPoolId: `${id}-pool`,
    capacityPoolScope: "SHARED_OWNER_POOL",
    capacityScope: "ORG",
    dataPolicyProfile: "PRIVATE_CODE_ALLOWED",
    lifecycle: "APPROVED",
    explicitZeroPrice: true,
    paidFallbackDisabled: true,
    managedMultiUserAllowed: true,
    privacyClass: "standard",
    roles: ["CODER"],
    qualityScore: 70,
    healthy: true,
    enabled: true,
    windows: [quotaWindow()],
    ...overrides,
  };
}

function pool(id: string, overrides: Partial<ProviderCapacityPool> = {}): ProviderCapacityPool {
  return {
    poolId: id,
    providerId: "managed-a",
    scope: "SHARED_OWNER_POOL",
    supplyClass: "PURE_MANAGED_FREE",
    windows: [quotaWindow()],
    observedAt: OBSERVED_AT,
    authoritative: true,
    ...overrides,
  };
}

function measurement(overrides: Partial<EightBitRouteMeasurement> = {}): EightBitRouteMeasurement {
  return {
    providerId: "managed-a",
    modelId: "route-a-model",
    observedAt: OBSERVED_AT,
    sampleSize: 10,
    successes: 10,
    failures: 0,
    rateLimits: 1,
    timeouts: 0,
    latencyP50Ms: 420,
    latencyP95Ms: 900,
    capacityUtilization: 0.4,
    policyCertainty: "verified",
    costCertainty: "verified_free",
    ...overrides,
  };
}

function entryFor(ledger: { entries: readonly RouteLedgerEntry[] }, routeId: string): RouteLedgerEntry {
  const entry = ledger.entries.find((e) => e.routeId === routeId);
  if (!entry) throw new Error(`missing ledger entry ${routeId}`);
  return entry;
}

describe("8-Bit route ledger", () => {
  it("joins route + pool + measured health into one row with observed provenance", () => {
    const tracker = new EightBitMeasuredHealthTracker();
    const record = tracker.ingest(measurement());
    const ledger = buildRouteLedger({
      routes: [route("route-a")],
      pools: [pool("route-a-pool", { windows: [quotaWindow({ remaining: 250 }), quotaWindow({ unit: "concurrency", limit: 2, remaining: 2, period: "CONTINUOUS" })] })],
      measuredHealth: [record],
      policyFacts: { "managed-a": { termsStatus: "CLEARED", commercialPackagingEligible: true } },
      now: NOW,
    });
    const entry = entryFor(ledger, "route-a");
    expect(entry.requestsRemaining).toBe(250);
    expect(entry.quotaPeriod).toBe("DAILY_RESET");
    expect(entry.requestsPerDay).toBe(1000);
    expect(entry.concurrency).toBe(2);
    expect(entry.health).toBe("DEGRADED");
    expect(entry.latencyP50Ms).toBe(420);
    expect(entry.latencyP95Ms).toBe(900);
    expect(entry.rateLimitRate).toBeCloseTo(0.1);
    expect(entry.measuredSampleSize).toBe(10);
    expect(entry.commercialStatus).toBe("CLEARED");
    expect(entry.multiTenantStatus).toBe("CLEARED");
    expect(entry.productionStatus).toBe("PRODUCTION_ALLOWED");
    expect(entry.freeEligible).toBe(true);
    expect(entry.onExhaustion).toBe("ROTATE_THEN_AWAIT_RESET");
    expect(entry.fieldProvenance.requestsRemaining).toBe("OBSERVED");
    expect(entry.fieldProvenance.latency).toBe("OBSERVED");
    expect(ledger.summary.isolationViolations).toEqual([]);
  });

  it("keeps unknown capacity fields null instead of fabricating zero", () => {
    const ledger = buildRouteLedger({ routes: [route("route-b", { windows: [] })], now: NOW });
    const entry = entryFor(ledger, "route-b");
    expect(entry.requestsRemaining).toBeNull();
    expect(entry.tokensRemaining).toBeNull();
    expect(entry.creditsRemaining).toBeNull();
    expect(entry.latencyP95Ms).toBeNull();
    expect(entry.rateLimitRate).toBeNull();
    expect(entry.quotaPeriod).toBe("UNKNOWN");
    expect(entry.fieldProvenance.requestsRemaining).toBe("UNKNOWN");
    expect(entry.fieldProvenance.latency).toBe("UNKNOWN");
    expect(entry.commercialStatus).toBe("UNKNOWN");
    expect(entry.productionStatus).toBe("UNKNOWN");
  });

  it("separates rate-limit windows from budget windows", () => {
    const windows = [
      quotaWindow({ unit: "requests", period: "MINUTE_RESET", limit: 20, remaining: 20, resetAt: "2026-09-21T00:01:00.000Z" }),
      quotaWindow({ unit: "requests", period: "DAILY_RESET", limit: 1000, remaining: 400 }),
      quotaWindow({ unit: "input_tokens", period: "MINUTE_RESET", limit: 60_000, remaining: 60_000, resetAt: "2026-09-21T00:01:00.000Z" }),
      quotaWindow({ unit: "input_tokens", period: "DAILY_RESET", limit: 2_000_000, remaining: 1_500_000 }),
      quotaWindow({ unit: "credits", period: "MONTHLY_RESET", limit: 500, remaining: 300, resetAt: "2026-10-01T00:00:00.000Z" }),
    ];
    const ledger = buildRouteLedger({ routes: [route("route-c", { windows })], now: NOW });
    const entry = entryFor(ledger, "route-c");
    expect(entry.requestsPerMinute).toBe(20);
    expect(entry.tokensPerMinute).toBe(60_000);
    expect(entry.requestsPerDay).toBe(1000);
    expect(entry.tokensPerDay).toBe(2_000_000);
    expect(entry.requestsRemaining).toBe(400);
    expect(entry.tokensRemaining).toBe(1_500_000);
    expect(entry.creditsRemaining).toBe(300);
    expect(entry.monthlyLimit).toBe(500);
    expect(entry.resetAt).toBe("2026-09-22T00:00:00.000Z");
  });

  it("marks expiring promotions for retirement and expired windows as no longer counting", () => {
    const windows = [
      quotaWindow({ unit: "credits", period: "EXPIRING_PROMOTION", limit: 100, remaining: 50, expiresAt: "2026-10-01T00:00:00.000Z", resetAt: "2026-10-01T00:00:00.000Z" }),
    ];
    const promo = route("promo", { supplyClass: "PROMOTIONAL_FREE", windows });
    const expired = route("expired", {
      supplyClass: "PROMOTIONAL_FREE",
      windows: [quotaWindow({ unit: "credits", period: "EXPIRING_PROMOTION", remaining: 999, expiresAt: "2026-09-01T00:00:00.000Z", resetAt: "2026-09-01T00:00:00.000Z" })],
    });
    const ledger = buildRouteLedger({ routes: [promo, expired], now: NOW });
    expect(entryFor(ledger, "promo").onExhaustion).toBe("ROTATE_THEN_RETIRE");
    expect(entryFor(ledger, "promo").expiresAt).toBe("2026-10-01T00:00:00.000Z");
    const expiredEntry = entryFor(ledger, "expired");
    expect(expiredEntry.creditsRemaining).toBeNull();
    expect(expiredEntry.onExhaustion).toBe("ROTATE_THEN_RETIRE");
  });

  it("gates sponsored supply behind the explicit policy flag", () => {
    const sponsored = route("sponsored", { supplyClass: "SPONSORED_FREE" });
    const denied = buildRouteLedger({ routes: [sponsored], now: NOW });
    const deniedEntry = entryFor(denied, "sponsored");
    expect(deniedEntry.freeEligible).toBe(false);
    expect(deniedEntry.exclusionReason).toBe("SPONSORED_FREE_NOT_AUTHORIZED");
    expect(deniedEntry.quotaOwner).toBe("SPONSORED");
    const allowed = buildRouteLedger({
      routes: [sponsored],
      policy: { paidInferenceAllowed: false, allowUserConnectedFree: true, allowDistributedUserFree: true, allowDepositUnlockedFree: false, allowSponsoredFree: true },
      now: NOW,
    });
    expect(entryFor(allowed, "sponsored").freeEligible).toBe(true);
  });

  it("isolates user-entitlement pools from shared supply in aggregation", () => {
    const shared = route("shared", { windows: [quotaWindow({ remaining: 100 })] });
    const alice = route("alice", {
      providerId: "ollama-cloud",
      modelId: "gemma4",
      supplyClass: "USER_CONNECTED_FREE",
      capacityPoolId: "ollama-cloud:user:alicehash",
      capacityPoolScope: "PER_USER_POOL",
      capacityScope: "USER_ACCOUNT",
      capacityIdentity: "alicehash",
      explicitZeroPrice: false,
      freeOnlyAdmissionProven: true,
      managedMultiUserAllowed: true,
      windows: [quotaWindow({ unit: "credits", scope: "USER_ACCOUNT", remaining: 5, limit: 5, period: "MONTHLY_RESET", resetAt: "2026-10-01T00:00:00.000Z" })],
    });
    const ledger = buildRouteLedger({ routes: [shared, alice], now: NOW });
    const aliceEntry = entryFor(ledger, "alice");
    expect(aliceEntry.quotaOwner).toBe("USER_ENTITLEMENT");
    expect(aliceEntry.quotaOwnerIdentity).toBe("alicehash");
    expect(aliceEntry.onExhaustion).toBe("ROTATE_OWNED_THEN_YIELD");
    expect(ledger.domains.shared.requestsRemaining).toBe(100);
    expect(ledger.domains.shared.creditsRemaining).toBeNull();
    expect(ledger.domains.perUser["alicehash"]?.creditsRemaining).toBe(5);
    expect(ledger.summary.byOwner.USER_ENTITLEMENT).toBe(1);
    expect(ledger.summary.isolationViolations).toEqual([]);
  });

  it("detects pool scope conflicts and identity domain crossover", () => {
    const sharedRow = route("x", { capacityPoolId: "pool-1", capacityPoolScope: "SHARED_OWNER_POOL" });
    const userRow = route("y", {
      capacityPoolId: "pool-1",
      capacityPoolScope: "PER_USER_POOL",
      capacityIdentity: "alicehash",
      supplyClass: "USER_CONNECTED_FREE",
      freeOnlyAdmissionProven: true,
    });
    const scopedEntries = buildRouteLedger({ routes: [sharedRow, userRow], now: NOW }).entries;
    const violations = findOwnershipViolations(scopedEntries);
    expect(violations.some((v) => v.startsWith("POOL_SCOPE_CONFLICT:pool-1"))).toBe(true);

    // A shared pool must never be backed by a physical account that also owns per-user quota.
    const crossoverShared = buildRouteLedger({ routes: [route("z", { capacityPoolId: "pool-2", capacityPoolScope: "SHARED_OWNER_POOL", capacityIdentity: "alicehash" })], now: NOW }).entries[0]!;
    const crossoverViolations = findOwnershipViolations([aliceFrom(ledgerOf("alicehash")), crossoverShared]);
    expect(crossoverViolations.some((v) => v.startsWith("IDENTITY_DOMAIN_CROSSOVER"))).toBe(true);
  });

  it("reports per-user aggregate without folding it into shared totals", () => {
    const entries = [
      ...buildRouteLedger({ routes: [route("s1", { windows: [quotaWindow({ remaining: 50 })] })], now: NOW }).entries,
      ...ledgerOf("alicehash", 5).entries,
      ...ledgerOf("bobhash", 7).entries,
    ];
    const domains = aggregateSupplyDomains(entries);
    expect(domains.shared.requestsRemaining).toBe(50);
    expect(Object.keys(domains.perUser).sort()).toEqual(["alicehash", "bobhash"]);
    expect(domains.perUser["alicehash"]?.creditsRemaining).toBe(5);
    expect(domains.perUser["bobhash"]?.creditsRemaining).toBe(7);
  });
});

function ledgerOf(identity: string, credits = 5) {
  return buildRouteLedger({
    routes: [route(`u-${identity}`, {
      providerId: "ollama-cloud",
      supplyClass: "USER_CONNECTED_FREE",
      capacityPoolId: `ollama-cloud:user:${identity}`,
      capacityPoolScope: "PER_USER_POOL",
      capacityScope: "USER_ACCOUNT",
      capacityIdentity: identity,
      explicitZeroPrice: false,
      freeOnlyAdmissionProven: true,
      windows: [quotaWindow({ unit: "credits", scope: "USER_ACCOUNT", remaining: credits, limit: credits, period: "MONTHLY_RESET", resetAt: "2026-10-01T00:00:00.000Z" })],
    })],
    now: NOW,
  });
}

function aliceFrom(ledger: { entries: readonly RouteLedgerEntry[] }): RouteLedgerEntry {
  const entry = ledger.entries.find((e) => e.quotaOwnerIdentity === "alicehash");
  if (!entry) throw new Error("missing alice entry");
  return entry;
}
