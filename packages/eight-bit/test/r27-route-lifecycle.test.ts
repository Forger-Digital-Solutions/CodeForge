import { describe, expect, it } from "vitest";
import { EightBitEligibilityPolicy } from "../src/eligibility.js";
import { CatalogDriftTracker } from "../src/drift.js";
import {
  DEFAULT_ROUTE_HEALTH_POLICY,
  EightBitRouteHealthAuthority,
} from "../src/route-health-authority.js";
import { makeModel } from "./fixtures.js";

const T0 = Date.parse("2026-09-21T14:43:00.000Z");
const ROUTE = { providerId: "groq", modelId: "openai/gpt-oss-20b" };

function clock(start = T0) {
  let now = start;
  return {
    now: () => now,
    advance: (milliseconds: number) => { now += milliseconds; },
  };
}

function iso(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

describe("R27 8-Bit route lifecycle", () => {
  it("keeps temporary provider failure recoverable while retiring routes permanently until catalog evidence returns", () => {
    const c = clock();
    const authority = new EightBitRouteHealthAuthority(DEFAULT_ROUTE_HEALTH_POLICY, c.now);

    authority.observe({
      kind: "call_failure",
      ...ROUTE,
      observedAt: iso(c.now()),
      source: "runtime",
      reason: "PROVIDER_OUTAGE",
      status: 503,
    });
    expect(authority.assess(ROUTE.providerId, ROUTE.modelId)).toMatchObject({
      state: "TEMPORARY_CAPACITY",
      hardExclude: false,
    });

    c.advance(DEFAULT_ROUTE_HEALTH_POLICY.temporaryCapacityTtlMs + 1);
    expect(authority.assess(ROUTE.providerId, ROUTE.modelId).state).not.toBe("TEMPORARY_CAPACITY");

    authority.observe({
      kind: "catalog",
      ...ROUTE,
      observedAt: iso(c.now()),
      source: "registry",
      fact: "not_found",
    });
    expect(authority.assess(ROUTE.providerId, ROUTE.modelId)).toMatchObject({
      state: "MODEL_RETIRED",
      hardExclude: true,
    });
    expect(authority.probeAdvice(ROUTE.providerId, ROUTE.modelId).never).toBe(true);

    authority.observe({
      kind: "catalog",
      ...ROUTE,
      observedAt: iso(c.now() + 1_000),
      source: "registry",
      fact: "present",
    });
    expect(authority.assess(ROUTE.providerId, ROUTE.modelId).hardExclude).toBe(false);
  });

  it("keeps Planner capability failures role-scoped and clears them only with verified evidence", () => {
    const authority = new EightBitRouteHealthAuthority(DEFAULT_ROUTE_HEALTH_POLICY, cNow);

    authority.observe({
      kind: "role_outcome",
      ...ROUTE,
      observedAt: iso(T0),
      source: "bench",
      role: "PLANNER",
      outcome: "role_failed",
    });
    expect(authority.assess(ROUTE.providerId, ROUTE.modelId, { role: "PLANNER" }).state).toBe("CAPABILITY_LIMITED");
    expect(authority.assess(ROUTE.providerId, ROUTE.modelId, { role: "CODER" }).state).not.toBe("CAPABILITY_LIMITED");

    authority.observe({
      kind: "role_outcome",
      ...ROUTE,
      observedAt: iso(T0 + 1_000),
      source: "bench",
      role: "PLANNER",
      outcome: "verified_complete",
    });
    expect(authority.assess(ROUTE.providerId, ROUTE.modelId, { role: "PLANNER" }).state).not.toBe("CAPABILITY_LIMITED");
  });

  it("quarantines repeated malformed tool calls and requires explicit recovery", () => {
    const authority = new EightBitRouteHealthAuthority(DEFAULT_ROUTE_HEALTH_POLICY, cNow);
    for (let index = 0; index < DEFAULT_ROUTE_HEALTH_POLICY.quarantineStreak; index += 1) {
      authority.observe({
        kind: "tool_outcome",
        ...ROUTE,
        observedAt: iso(T0 + index * 1_000),
        source: "runtime",
        role: "CODER",
        outcome: "malformed",
      });
    }

    expect(authority.assess(ROUTE.providerId, ROUTE.modelId)).toMatchObject({ state: "QUARANTINED", hardExclude: true });
    expect(authority.probeAdvice(ROUTE.providerId, ROUTE.modelId)).toMatchObject({ never: true, shouldProbe: false });

    authority.observe({
      kind: "quarantine",
      ...ROUTE,
      observedAt: iso(T0 + 10_000),
      source: "registry",
      action: "clear",
      reason: "R27_CONTROLLED_RECOVERY",
    });
    expect(authority.assess(ROUTE.providerId, ROUTE.modelId).hardExclude).toBe(false);
  });

  it("turns catalog terms and capability drift into fail-closed role decisions", () => {
    const tracker = new CatalogDriftTracker();
    const previous = makeModel({
      providerId: "groq",
      modelId: "qwen/qwen3.6-27b",
      contextWindow: 32_768,
      capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: false },
    });
    const current = makeModel({
      providerId: previous.providerId,
      modelId: previous.modelId,
      contextWindow: 4_096,
      accessClass: "PAID",
      costProfile: {
        isFree: false,
        inputCostPerMillion: 1,
        outputCostPerMillion: 2,
        paidFallbackPossible: true,
        paidFallbackDisabled: false,
        source: "r27-drift-fixture",
      },
      capabilities: { text: true, coding: true, toolCalling: false, vision: false, structuredOutput: false, longContext: false },
    });

    const events = tracker.detectCatalogDrift({ previousModels: [previous], currentModels: [current] });
    expect(events.map((event) => event.driftKind)).toEqual(expect.arrayContaining(["FREE_TERMS_CHANGED", "CAPABILITIES_CHANGED"]));

    const policy = new EightBitEligibilityPolicy();
    expect(policy.evaluate(current, { role: "CODER", policyMode: "adaptive", estimatedContextTokens: 8_000 })).toMatchObject({
      eligible: false,
      code: "PAID_NOT_AUTHORIZED",
    });
  });

  it("does not mistake temporary quota filtering for route disappearance", () => {
    const tracker = new CatalogDriftTracker();
    const previous = makeModel({
      providerId: "cloudflare-workers-ai",
      modelId: "@cf/openai/gpt-oss-120b",
      health: { status: "quota_exhausted", lastError: "daily free allocation used" },
    });
    expect(tracker.detectCatalogDrift({ previousModels: [previous], currentModels: [] })).toEqual([]);
  });
});

const cNow = () => T0;
