import { describe, expect, it } from "vitest";
import type { FreeModelRecord } from "@codeforge/forge-zero";
import { CatalogDriftTracker } from "../src/drift.js";

function makeModel(overrides: Partial<FreeModelRecord> = {}): FreeModelRecord {
  return {
    providerId: "groq",
    modelId: "qwen/qwen3.6-27b",
    accessClass: "FREE_ALLOWANCE",
    contextWindow: 32_768,
    costProfile: {
      isFree: true,
      inputCostPerMillion: 0,
      outputCostPerMillion: 0,
      paidFallbackPossible: false,
      paidFallbackDisabled: true,
      source: "test",
    },
    capabilities: {
      text: true,
      coding: true,
      toolCalling: true,
      vision: false,
      structuredOutput: true,
      longContext: false,
    },
    freeStatus: "verified_free",
    freeStatusVerifiedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("CatalogDriftTracker — 8-Bit catalog evolution and drift maturity", () => {
  it("detects newly appeared free routes", () => {
    const tracker = new CatalogDriftTracker();
    const prev: FreeModelRecord[] = [];
    const curr: FreeModelRecord[] = [makeModel({ modelId: "openai/gpt-oss-120b" })];

    const events = tracker.detectCatalogDrift({ previousModels: prev, currentModels: curr });
    expect(events).toHaveLength(1);
    expect(events[0]!.driftKind).toBe("ROUTE_APPEARED");
    expect(events[0]!.modelId).toBe("openai/gpt-oss-120b");
  });

  it("detects disappeared routes when genuinely missing upstream", () => {
    const tracker = new CatalogDriftTracker();
    const prev: FreeModelRecord[] = [makeModel({ modelId: "legacy-model" })];
    const curr: FreeModelRecord[] = [];

    const events = tracker.detectCatalogDrift({ previousModels: prev, currentModels: curr });
    expect(events).toHaveLength(1);
    expect(events[0]!.driftKind).toBe("ROUTE_DISAPPEARED");
    expect(events[0]!.modelId).toBe("legacy-model");
  });

  it("strictly preserves invariant: temporary quota exhaustion is NOT treated as route removal", () => {
    const tracker = new CatalogDriftTracker();
    // A model that is temporarily quota_exhausted (e.g. daily neuron limit hit, HTTP 429)
    const prev: FreeModelRecord[] = [
      makeModel({
        providerId: "cloudflare-workers-ai",
        modelId: "@cf/openai/gpt-oss-120b",
        health: { status: "quota_exhausted", lastError: "daily free allocation of 10,000 neurons used up" },
      }),
    ];
    // In an active catalog query, quota-exhausted models might temporarily be filtered out
    const curr: FreeModelRecord[] = [];

    const events = tracker.detectCatalogDrift({ previousModels: prev, currentModels: curr });
    // Invariant: MUST NOT record ROUTE_DISAPPEARED for temporary quota exhaustion!
    expect(events).toHaveLength(0);
  });

  it("detects renamed or replaced models when replacement is mapped", () => {
    const tracker = new CatalogDriftTracker();
    const prev: FreeModelRecord[] = [makeModel({ modelId: "qwen/qwen2.5-32b" })];
    const curr: FreeModelRecord[] = [makeModel({ modelId: "qwen/qwen3.6-27b" })];

    const events = tracker.detectCatalogDrift({
      previousModels: prev,
      currentModels: curr,
      knownReplacements: {
        "groq::qwen/qwen2.5-32b": "groq::qwen/qwen3.6-27b",
      },
    });

    const replaced = events.find((e) => e.driftKind === "ROUTE_RENAMED_OR_REPLACED");
    expect(replaced).toBeDefined();
    expect(replaced!.previousRoute).toEqual({ providerId: "groq", modelId: "qwen/qwen2.5-32b" });
    expect(replaced!.replacementRoute).toEqual({ providerId: "groq", modelId: "qwen/qwen3.6-27b" });
  });

  it("detects free terms changes (e.g. transition from free to paid)", () => {
    const tracker = new CatalogDriftTracker();
    const prev: FreeModelRecord[] = [makeModel({ accessClass: "FREE_ALLOWANCE" })];
    const curr: FreeModelRecord[] = [
      makeModel({
        accessClass: "PAID",
        costProfile: {
          isFree: false,
          inputCostPerMillion: 2.5,
          outputCostPerMillion: 10,
          paidFallbackPossible: true,
          paidFallbackDisabled: false,
          source: "provider-pricing",
        },
      }),
    ];

    const events = tracker.detectCatalogDrift({ previousModels: prev, currentModels: curr });
    const termsEvent = events.find((e) => e.driftKind === "FREE_TERMS_CHANGED");
    expect(termsEvent).toBeDefined();
    expect(termsEvent!.reason).toContain("FREE_ALLOWANCE -> PAID");
  });

  it("detects capability drift (tools, structured output, contextWindow)", () => {
    const tracker = new CatalogDriftTracker();
    const prev: FreeModelRecord[] = [
      makeModel({
        contextWindow: 32_768,
        capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: false },
      }),
    ];
    const curr: FreeModelRecord[] = [
      makeModel({
        contextWindow: 128_000,
        capabilities: { text: true, coding: true, toolCalling: true, vision: true, structuredOutput: true, longContext: true },
      }),
    ];

    const events = tracker.detectCatalogDrift({ previousModels: prev, currentModels: curr });
    const capEvent = events.find((e) => e.driftKind === "CAPABILITIES_CHANGED");
    expect(capEvent).toBeDefined();
  });

  it("detects stale verification age", () => {
    const tracker = new CatalogDriftTracker();
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const prev: FreeModelRecord[] = [makeModel({ freeStatusVerifiedAt: eightDaysAgo })];
    const curr: FreeModelRecord[] = [makeModel({ freeStatusVerifiedAt: eightDaysAgo })];

    const events = tracker.detectCatalogDrift({ previousModels: prev, currentModels: curr });
    const staleEvent = events.find((e) => e.driftKind === "ROUTE_STALE");
    expect(staleEvent).toBeDefined();
    expect(staleEvent!.reason).toContain("expired");
  });

  it("records replacement promotions and supports filtering", () => {
    const tracker = new CatalogDriftTracker();
    tracker.recordPromotion(
      { role: "CODER", sessionId: "sess-123" },
      { providerId: "groq", modelId: "openai/gpt-oss-20b" },
      { providerId: "groq", modelId: "openai/gpt-oss-120b" },
      "Promoted to higher-parameter qualified route for complex coding task",
    );

    const promotions = tracker.getDriftEvents({ driftKind: "REPLACEMENT_PROMOTED" });
    expect(promotions).toHaveLength(1);
    expect(promotions[0]!.replacementRoute?.modelId).toBe("openai/gpt-oss-120b");
    expect(promotions[0]!.previousRoute?.modelId).toBe("openai/gpt-oss-20b");
  });
});
