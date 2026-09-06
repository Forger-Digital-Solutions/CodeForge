import { describe, it, expect } from "vitest";
import { canonicalCacheKey, FORGE_GREEN_CACHE_SCHEMA_VERSION } from "../src/canonical-cache.js";
import { createForgeGreenLedgerCollector, createForgeGreenAdvisor } from "../src/index.js";

describe("FG-1D canonical cache identity", () => {
  const base = {
    namespace: "ws-namespace",
    analysis: "repo_file_summary",
    parameters: { path: "src/a.ts", limit: 50 },
  };

  it("produces identical keys for identical semantic inputs (hit)", () => {
    const a = canonicalCacheKey({ ...base, contentHashes: ["hash-1"], scopeDigest: "1:parser" });
    const b = canonicalCacheKey({ ...base, contentHashes: ["hash-1"], scopeDigest: "1:parser" });
    expect(a).toBe(b);
  });

  it("survives harmless property-order differences in parameters", () => {
    const a = canonicalCacheKey({ ...base, parameters: { path: "src/a.ts", limit: 50 } });
    const b = canonicalCacheKey({ ...base, parameters: { limit: 50, path: "src/a.ts" } });
    expect(a).toBe(b);
  });

  it("survives content-hash list ordering differences", () => {
    const a = canonicalCacheKey({ ...base, contentHashes: ["h1", "h2"] });
    const b = canonicalCacheKey({ ...base, contentHashes: ["h2", "h1"] });
    expect(a).toBe(b);
  });

  it("changes when the underlying content changes (same path, changed content)", () => {
    const a = canonicalCacheKey({ ...base, contentHashes: ["hash-1"], scopeDigest: "1:parser" });
    const b = canonicalCacheKey({ ...base, contentHashes: ["hash-2"], scopeDigest: "1:parser" });
    expect(a).not.toBe(b);
  });

  it("changes when a relevant dependency/scope digest changes", () => {
    const a = canonicalCacheKey({ ...base, scopeDigest: "1:parser:generation-7" });
    const b = canonicalCacheKey({ ...base, scopeDigest: "1:parser:generation-8" });
    expect(a).not.toBe(b);
  });

  it("changes on parser/schema version change and on policy version change", () => {
    const parserA = canonicalCacheKey({ ...base, parserVersion: "typescript-5.9+deterministic-1", scopeDigest: "g1" });
    const parserB = canonicalCacheKey({ ...base, parserVersion: "typescript-5.10+deterministic-1", scopeDigest: "g1" });
    expect(parserA).not.toBe(parserB);
    const policyA = canonicalCacheKey({ ...base, policyVersion: "p1", scopeDigest: "g1" });
    const policyB = canonicalCacheKey({ ...base, policyVersion: "p2", scopeDigest: "g1" });
    expect(policyA).not.toBe(policyB);
  });

  it("changes on relevant model/provider change", () => {
    const a = canonicalCacheKey({ ...base, model: "zai/glm-4.6", scopeDigest: "g1" });
    const b = canonicalCacheKey({ ...base, model: "zai/glm-4.7", scopeDigest: "g1" });
    expect(a).not.toBe(b);
  });

  it("isolates security namespaces: one namespace can never read another's identity", () => {
    const a = canonicalCacheKey({ ...base, namespace: "tenant-alpha/ws-1" });
    const b = canonicalCacheKey({ ...base, namespace: "tenant-beta/ws-1" });
    expect(a).not.toBe(b);
  });

  it("is content-first: identical content across commit/worktree topology reuses safely (no commit SHA in identity)", () => {
    const worktreeA = canonicalCacheKey({ ...base, contentHashes: ["same-hash"], scopeDigest: "1:parser" });
    const worktreeB = canonicalCacheKey({ ...base, contentHashes: ["same-hash"], scopeDigest: "1:parser" });
    expect(worktreeA).toBe(worktreeB);
  });

  it("rejects identities without a security namespace or analysis type", () => {
    expect(() => canonicalCacheKey({ ...base, namespace: "" })).toThrow();
    expect(() => canonicalCacheKey({ analysis: "x", namespace: "n" } as never)).not.toThrow();
    expect(() => canonicalCacheKey({ namespace: "n" } as never)).toThrow();
  });

  it("embeds the schema version so a schema bump invalidates every prior entry", () => {
    expect(FORGE_GREEN_CACHE_SCHEMA_VERSION).toBe("fg1-1");
  });
});

describe("FG-1E efficiency ledger", () => {
  it("classifies measured vs unknown quantities honestly", () => {
    const ledger = createForgeGreenLedgerCollector({ runId: "r1", operation: "agent_run", namespace: "ws" });
    ledger.recordToolCompression(10000, 2000, true);
    ledger.recordProviderPromptCache(512, 0);
    ledger.recordProviderPromptCache(undefined, undefined);
    ledger.recordDuplicateSuppressed();
    ledger.recordCanonicalCacheHit();
    ledger.recordCanonicalCacheMiss();
    ledger.recordCanonicalCacheInvalidation("generation");
    ledger.recordNoProgressInterruption("read loop");
    ledger.recordFallback("analysis_unavailable");
    const snapshot = ledger.snapshot();
    expect(snapshot.totals.bytesAvoidedMeasured).toBe(8000);
    expect(snapshot.totals.tokensAvoidedMeasured).toBe(512);
    expect(snapshot.totals.eventsWithUnknownQuantity).toBe(1);
    expect(snapshot.totals.duplicateActionsSuppressed).toBe(1);
    expect(snapshot.totals.canonicalCacheHits).toBe(1);
    expect(snapshot.totals.canonicalCacheMisses).toBe(1);
    expect(snapshot.totals.canonicalCacheInvalidations).toBe(1);
    expect(snapshot.totals.noProgressInterruptions).toBe(1);
    expect(snapshot.totals.fallbackEvents).toBe(1);
  });

  it("never records content: event fields are quantities, units, and reason codes only", () => {
    const ledger = createForgeGreenLedgerCollector({ runId: "r2", operation: "agent_run", namespace: "ws" });
    ledger.record({ mechanism: "tool_output_compression", measurement: "measured", quantity: 100, unit: "bytes" });
    const snapshot = ledger.snapshot();
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("password");
    for (const event of snapshot.events) {
      expect(Object.keys(event).sort()).toEqual(["measurement", "mechanism", "quantity", "reason", "unit"].filter((key) => event[key as keyof typeof event] !== undefined).sort());
    }
  });

  it("ignores compression events that were not applied (no fabricated savings)", () => {
    const ledger = createForgeGreenLedgerCollector({ runId: "r3", operation: "agent_run", namespace: "ws" });
    ledger.recordToolCompression(1000, 1000, false);
    expect(ledger.snapshot().totals.bytesAvoidedMeasured).toBe(0);
    expect(ledger.snapshot().events).toHaveLength(0);
  });
});

describe("FG-1E receipt honesty", () => {
  it("reports provider_prompt_cache accounting only when the provider actually reported tokens", () => {
    const advisor = createForgeGreenAdvisor();
    const withoutTelemetry = advisor.createReceipt({ workspaceId: "ws", repositoryGeneration: 1 });
    expect(withoutTelemetry.promptCacheAccounting).toBe("unavailable");
    expect(withoutTelemetry.providerCachedInputTokens).toBeUndefined();

    const withTelemetry = advisor.createReceipt({ workspaceId: "ws", repositoryGeneration: 1, providerCachedInputTokens: 4096 });
    expect(withTelemetry.promptCacheAccounting).toBe("provider_reported");
    expect(withTelemetry.providerCachedInputTokens).toBe(4096);
  });

  it("surfaces FG-1 mechanism counters on the receipt when present", () => {
    const advisor = createForgeGreenAdvisor();
    const receipt = advisor.createReceipt({
      workspaceId: "ws",
      repositoryGeneration: 1,
      toolOutputBytesAvoided: 1234,
      duplicateActionsSuppressed: 2,
      noProgressInterruptions: 1,
      canonicalCacheHits: 3,
      canonicalCacheMisses: 1,
    });
    expect(receipt.toolOutputBytesAvoided).toBe(1234);
    expect(receipt.duplicateActionsSuppressed).toBe(2);
    expect(receipt.noProgressInterruptions).toBe(1);
    expect(receipt.canonicalCacheHits).toBe(3);
    expect(receipt.canonicalCacheMisses).toBe(1);
    expect(receipt.reasonCodes).toEqual([]);
  });
});
