import { describe, expect, it } from "vitest";
import { ForgeZero, type FreeModelRecord } from "@codeforge/forge-zero";
import { InMemoryProviderCatalog, createMockProvider } from "@codeforge/providers";
import {
  FreeCloudService,
  NormalizedModelRegistry,
  parseRouteQuota,
  type ProviderConnectionState,
} from "../src/index.js";

/**
 * R13 Priority 6 — deterministic free-capacity chaos suite.
 *
 * No paid traffic anywhere in this file. All provider responses are synthetic. Time is fully
 * controlled via an injected clock — no wall-clock sleeps, no flakiness.
 *
 * This complements (does not duplicate) the "happy path" evidence-driven coverage already in
 * free-cloud-registry.test.ts (429 with Retry-After, 429 with reset-only, quota-driven SATURATED
 * classification, same-model alternates, qualification budget/interval). This file targets the
 * adversarial/malformed-input edge of the same mechanisms, retry-storm prevention, full-outage
 * fail-closed behavior, and the passive-recovery timeline.
 */

const NOW = new Date();

function freeRecord(providerId: string, modelId: string, overrides: Partial<FreeModelRecord> = {}): FreeModelRecord {
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
    accessClass: providerId === "openrouter" ? "FREE_ROUTED" : "FREE_NATIVE",
    privacyClass: "standard",
    lastVerified: NOW.toISOString(),
    verificationSource: "pricing+live-catalog",
    health: { status: "available", lastCheckedAt: NOW.toISOString() },
    ...overrides,
  };
}

function connected(providerId: string, extra: Partial<ProviderConnectionState> = {}): ProviderConnectionState {
  return { providerId, connected: true, credentialSource: "SECURE_STORAGE", authState: "ok", ...extra };
}

/** A service with an explicitly advanceable clock and every route already qualified/admitted,
 * so every test in this file starts from a clean FORGEAUTO_ELIGIBLE baseline and only varies the
 * chaos input under test. */
function chaosHarness(routes: Array<{ providerId: string; modelId: string }>) {
  const fw = new ForgeZero();
  for (const r of routes) fw.register(freeRecord(r.providerId, r.modelId));
  const catalog = new InMemoryProviderCatalog();
  for (const providerId of new Set(routes.map((r) => r.providerId))) catalog.register(createMockProvider({ providerId }));
  let clock = NOW.getTime();
  const svc = new FreeCloudService({
    firewall: fw,
    providerCatalog: catalog,
    registry: new NormalizedModelRegistry(),
    now: () => new Date(clock),
    qualificationCycleIntervalMs: 0,
    qualificationRunner: async (model) => ({
      suiteVersion: "chaos",
      providerId: model.providerId,
      modelId: model.modelId,
      modelDisplayName: model.modelId,
      accessClass: "FREE_NATIVE" as const,
      freeStatus: "verified_free" as const,
      roleResults: { CODER: { role: "CODER" as const, status: "QUALIFIED" as const, testCases: [], hardFailures: [], overallScore: 1, startedAt: NOW.toISOString(), completedAt: NOW.toISOString() } },
      startedAt: NOW.toISOString(),
      completedAt: NOW.toISOString(),
      totalLatencyMs: 1,
      qualificationState: "QUALIFIED" as const,
      hardFailureRoles: [],
    }),
  });
  for (const providerId of new Set(routes.map((r) => r.providerId))) svc.setConnection(connected(providerId, { credentialSource: "OAUTH" }));
  return {
    svc,
    fw,
    advance: (ms: number) => { clock += ms; },
    qualifyAll: () => svc.qualifyPending({ budget: routes.length }),
  };
}

describe("chaos: rate limiting", () => {
  it("a 429 with zero headers still enters cooldown via exponential fallback, not silently ignored", async () => {
    const h = chaosHarness([{ providerId: "openrouter", modelId: "m:free" }]);
    await h.qualifyAll();
    expect(h.svc.isForgeAutoEligible("openrouter", "m:free")).toBe(true);

    h.svc.onProviderResponse({ providerId: "openrouter", modelId: "m:free", status: 429, headers: [], observedAt: Date.now() });

    expect(h.svc.isForgeAutoEligible("openrouter", "m:free")).toBe(false);
    const route = h.svc.snapshot().models[0]!.routes[0]!;
    expect(route.health).toBe("COOLDOWN");
    expect(route.capacityState).toBe("SATURATED");
    // First failure with zero header evidence still gets the deterministic 30s floor.
    expect(route.cooldownUntil! - NOW.getTime()).toBeGreaterThanOrEqual(30_000);
  });

  it("repeated 429s back off exponentially rather than permitting an immediate-retry storm", async () => {
    const h = chaosHarness([{ providerId: "openrouter", modelId: "m:free" }]);
    await h.qualifyAll();

    const cooldownAfter = (n: number) => {
      for (let i = 0; i < n; i++) h.svc.recordRouteFailure("openrouter", "m:free", "RATE_LIMITED");
      return h.svc.snapshot().models[0]!.routes[0]!.cooldownUntil!;
    };

    // Each additional consecutive failure must not shrink the cooldown — proves there is no path
    // back to "retry immediately" while the route keeps failing.
    const first = cooldownAfter(1);
    expect(first - NOW.getTime()).toBeCloseTo(30_000, -3);
    const second = cooldownAfter(1); // 2 total
    expect(second - NOW.getTime()).toBeCloseTo(60_000, -3);
    const third = cooldownAfter(1); // 3 total
    expect(third - NOW.getTime()).toBeCloseTo(120_000, -3);
    // The route stays ineligible throughout — never a window where a failing route is retried.
    expect(h.svc.isForgeAutoEligible("openrouter", "m:free")).toBe(false);
  });

  it("backoff is capped, not unbounded, even under an unbroken failure streak", async () => {
    const h = chaosHarness([{ providerId: "openrouter", modelId: "m:free" }]);
    await h.qualifyAll();
    for (let i = 0; i < 10; i++) h.svc.recordRouteFailure("openrouter", "m:free", "RATE_LIMITED");
    const route = h.svc.snapshot().models[0]!.routes[0]!;
    expect(route.cooldownUntil! - NOW.getTime()).toBe(15 * 60_000); // SHARED_MAX_COOLDOWN_MS
  });

  it("a quota-exhaustion failure floors at the full shared max cooldown even on the very first failure", async () => {
    const h = chaosHarness([{ providerId: "openrouter", modelId: "m:free" }]);
    await h.qualifyAll();
    h.svc.recordRouteFailure("openrouter", "m:free", "QUOTA_EXHAUSTED");
    const route = h.svc.snapshot().models[0]!.routes[0]!;
    // While actively cooling down, QUOTA_EXHAUSTED surfaces as the same generic "COOLDOWN" label
    // as any other rate-limit reason — the distinction that matters is tested below: it does not
    // auto-recover once the timer expires, unlike a plain rate-limit cooldown does.
    expect(route.health).toBe("COOLDOWN");
    expect(route.capacityState).toBe("SATURATED");
    expect(route.cooldownUntil! - NOW.getTime()).toBe(15 * 60_000);
  });

  it("unlike a plain rate-limit cooldown, quota exhaustion does NOT auto-recover to DEGRADED once its timer expires", async () => {
    const h = chaosHarness([{ providerId: "openrouter", modelId: "m:free" }]);
    await h.qualifyAll();
    h.svc.recordRouteFailure("openrouter", "m:free", "QUOTA_EXHAUSTED"); // cooldown = 15 min

    h.advance(15 * 60_000 + 1_000); // past the cooldown window
    const stillBlocked = h.svc.snapshot().models[0]!.routes[0]!;
    expect(stillBlocked.health).toBe("QUOTA_EXHAUSTED");
    expect(stillBlocked.capacityState).toBe("SATURATED");
    // A daily-style quota exhaustion is not "probably fine now" just because time passed — it stays
    // blocked until proof of a real success, unlike the plain-COOLDOWN case tested above.
    expect(h.svc.isForgeAutoEligible("openrouter", "m:free")).toBe(false);

    h.svc.recordRouteSuccess("openrouter", "m:free");
    expect(h.svc.isForgeAutoEligible("openrouter", "m:free")).toBe(true);
  });

  it("recovers passively over time: COOLDOWN (blocking) -> DEGRADED (admissible, post-expiry) -> HEALTHY (explicit success)", async () => {
    const h = chaosHarness([{ providerId: "openrouter", modelId: "m:free" }]);
    await h.qualifyAll();
    h.svc.recordRouteFailure("openrouter", "m:free", "RATE_LIMITED"); // cooldown = 30s

    expect(h.svc.isForgeAutoEligible("openrouter", "m:free")).toBe(false);
    expect(h.svc.snapshot().models[0]!.routes[0]!.capacityState).toBe("SATURATED");

    h.advance(29_000); // still inside cooldown
    expect(h.svc.isForgeAutoEligible("openrouter", "m:free")).toBe(false);

    h.advance(2_000); // now past the 30s cooldown, no explicit success recorded yet
    const postCooldown = h.svc.snapshot().models[0]!.routes[0]!;
    expect(postCooldown.health).toBe("DEGRADED");
    expect(postCooldown.capacityState).toBe("DEGRADED");
    // DEGRADED passes the HEALTHY admission gate — it is not a second blocking state.
    expect(h.svc.isForgeAutoEligible("openrouter", "m:free")).toBe(true);

    h.svc.recordRouteSuccess("openrouter", "m:free");
    const recovered = h.svc.snapshot().models[0]!.routes[0]!;
    expect(recovered.health).toBe("HEALTHY");
    expect(recovered.capacityState).toBe("HEALTHY");
  });
});

describe("chaos: contradictory and malformed metadata", () => {
  it("a malformed reset-time string is dropped, never crashes, never invents a value", () => {
    const q = parseRouteQuota([
      ["x-ratelimit-remaining-requests", "5"],
      ["x-ratelimit-reset-requests", "not-a-duration-or-date"],
    ], () => NOW);
    expect(q?.remainingRequests).toBe(5);
    expect(q?.resetAt).toBeUndefined();
  });

  it("a non-numeric remaining-requests header is dropped rather than parsed as NaN/0", () => {
    const q = parseRouteQuota([["x-ratelimit-remaining-requests", "unlimited"]], () => NOW);
    // "unlimited" contributes nothing else parseable either, so the whole record is absent —
    // CodeForge never invents a 0 (which would look identical to "exhausted") from garbage input.
    expect(q).toBeUndefined();
  });

  it("a 429's own status governs cooldown even when its headers contradict it with a large remaining count", async () => {
    const h = chaosHarness([{ providerId: "openrouter", modelId: "m:free" }]);
    await h.qualifyAll();
    // Internally inconsistent provider response: 429 (rejected) but headers claim ample capacity.
    h.svc.onProviderResponse({
      providerId: "openrouter",
      modelId: "m:free",
      status: 429,
      headers: [["x-ratelimit-remaining-requests", "999999"], ["x-ratelimit-limit-requests", "1000000"]],
      observedAt: Date.now(),
    });
    // The transport-level rejection is authoritative, not the self-reported remaining count.
    expect(h.svc.isForgeAutoEligible("openrouter", "m:free")).toBe(false);
    expect(h.svc.snapshot().models[0]!.routes[0]!.capacityState).toBe("SATURATED");
  });

  it("a 200 response with zero quota headers changes nothing and invents no state", async () => {
    const h = chaosHarness([{ providerId: "openrouter", modelId: "m:free" }]);
    await h.qualifyAll();
    h.svc.onProviderResponse({ providerId: "openrouter", modelId: "m:free", status: 200, headers: [], observedAt: Date.now() });
    expect(h.svc.isForgeAutoEligible("openrouter", "m:free")).toBe(true);
    expect(h.svc.quotaRemaining("openrouter", "m:free")).toBeUndefined();
  });

  it("a negative remaining-requests count on a successful response is at least penalized, documenting current behavior", async () => {
    const h = chaosHarness([{ providerId: "openrouter", modelId: "m:free" }]);
    await h.qualifyAll();
    // A provider reporting negative remaining capacity on 200 OK is self-contradictory; parseRouteQuota
    // does not reject it (no negative-number validation), so this documents what actually happens
    // downstream rather than asserting an aspirational fix.
    h.svc.onProviderResponse({ providerId: "openrouter", modelId: "m:free", status: 200, headers: [["x-ratelimit-remaining-requests", "-5"]], observedAt: Date.now() });
    const advice = h.svc.capacityRoutingAdvice("openrouter", "m:free");
    expect(advice.scoreAdjustment).toBeLessThan(0);
    // 200 OK never calls recordRouteFailure, so admission itself is untouched by this signal alone —
    // a negative count is a soft ranking penalty today, not a hard admission block.
    expect(h.svc.isForgeAutoEligible("openrouter", "m:free")).toBe(true);
  });
});

describe("chaos: total outage — fail closed, never escalate to paid", () => {
  it("when every free route for a canonical model is saturated, nothing is eligible and nothing substitutes a paid route", async () => {
    const h = chaosHarness([
      { providerId: "openrouter", modelId: "m:free" },
      { providerId: "groq", modelId: "m" },
    ]);
    await h.qualifyAll();
    h.svc.recordRouteFailure("openrouter", "m:free", "QUOTA_EXHAUSTED");
    h.svc.recordRouteFailure("groq", "m", "RATE_LIMITED");

    expect(h.svc.isForgeAutoEligible("openrouter", "m:free")).toBe(false);
    expect(h.svc.isForgeAutoEligible("groq", "m")).toBe(false);
    expect(h.svc.sameModelAlternates("openrouter", "m:free")).toEqual([]);

    const snap = h.svc.snapshot();
    const model = snap.models.find((m) => m.canonicalId.includes("openrouter/m") || m.routes.some((r) => r.providerModelId === "m:free"))!;
    expect(model.readiness).toBe("FREE_TEMPORARILY_UNAVAILABLE");
    // No route on this model is executable, and none is PAID_BYOK — CodeForge records the outage
    // honestly instead of finding a paid backstop.
    expect(model.routes.every((r) => !r.executable)).toBe(true);
    expect(model.readiness).not.toBe("PAID_BYOK");
  });
});

describe("chaos: PROBATION is reachable and distinct from SATURATED/HEALTHY", () => {
  it("an unqualified/never-tested route reports PROBATION, not HEALTHY or SATURATED", async () => {
    const fw = new ForgeZero();
    fw.register(freeRecord("openrouter", "untested:free"));
    const catalog = new InMemoryProviderCatalog();
    catalog.register(createMockProvider({ providerId: "openrouter" }));
    const svc = new FreeCloudService({
      firewall: fw,
      providerCatalog: catalog,
      registry: new NormalizedModelRegistry(),
      now: () => NOW,
    });
    svc.setConnection(connected("openrouter", { credentialSource: "OAUTH" }));
    // Deliberately never call qualifyPending — the route is still NOT_TESTED.
    const route = svc.snapshot().models[0]!.routes[0]!;
    expect(route.qualificationState).toBe("NOT_TESTED");
    expect(route.capacityState).toBe("PROBATION");
    expect(route.capacityState).not.toBe("SATURATED");
    expect(route.capacityState).not.toBe("HEALTHY");
  });
});

describe("chaos: capacity-governor evidence feedback (R13 fix)", () => {
  it("a 429 observed through the governed provider wrapper reaches ProviderCapacityGovernor's own cooldown state", async () => {
    const { ProviderCapacityGovernor, ProviderError } = await import("@codeforge/providers");
    const governor = new ProviderCapacityGovernor();
    const governed = governor.wrapAdapter({
      providerId: "openrouter",
      listModels: async () => [],
      healthCheck: async () => ({ status: "available" as const }),
      chat: async () => { throw new ProviderError("rate limited", "RATE_LIMITED", true, { status: 429, retryAfter: Date.now() + 5_000 }); },
      streamChat: async function* () {},
    });
    expect(governor.isCoolingDown("openrouter")).toBe(false);
    await expect(governed.chat({ model: "m", messages: [{ role: "user", content: "hi" }] })).rejects.toThrow();
    // Before the R13 fix this wrapper silently dropped the 429 and the governor never cooled down.
    expect(governor.isCoolingDown("openrouter")).toBe(true);
  });
});
