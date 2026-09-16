import { describe, expect, it } from "vitest";
import { createSessionPersistence } from "@codeforge/sessions";
import {
  comparePromptCacheExperiment,
  createForgeGreenR0TelemetryCollector,
  createForgeGreenR0TelemetryStore,
} from "../src/index.js";

describe("ForgeGreen R0 telemetry", () => {
  it("keeps provider usage unknown when the provider emitted no usage event", () => {
    const collector = createForgeGreenR0TelemetryCollector({
      runId: "r0-no-usage",
      sessionId: "s0",
      workspaceId: "w0",
    });
    collector.recordModelAttempt({ routeClass: "adaptive_free_route" });
    collector.recordResult("completed", "completed");

    const telemetry = collector.finalize({ wallTimeMs: 12 });

    expect(telemetry.model.modelAttempts.value).toBe(1);
    expect(telemetry.model.inputTokens.source).toBe("UNKNOWN");
    expect(telemetry.model.inputTokens.value).toBeUndefined();
    expect(telemetry.model.outputTokens.source).toBe("UNKNOWN");
    expect(telemetry.actualProviderCost.source).toBe("UNKNOWN");
    expect(telemetry.completionGate.status).toBe("UNKNOWN");
  });

  it("records observed usage, derived uncached input, bounded tool sizes, and retries without content", () => {
    const collector = createForgeGreenR0TelemetryCollector({
      runId: "r0-observed",
      sessionId: "s0",
      workspaceId: "w0",
      repositoryGeneration: 7,
    });
    collector.setRouteClass("explicit_route");
    collector.recordModelAttempt({
      providerId: "provider-a",
      modelId: "model-a",
      routeClass: "explicit_route",
      contextBytes: 1_000,
      stablePromptBytes: 400,
    });
    collector.recordProviderAttempt("provider-a", "model-a", "explicit_route");
    collector.recordModelResponse({
      providerId: "provider-a",
      modelId: "model-a",
      routeClass: "explicit_route",
      usageSource: "PROVIDER_REPORTED",
      inputTokens: 100,
      cachedInputTokens: 40,
      outputTokens: 20,
      totalTokens: 120,
      stablePromptCacheHit: true,
    });
    collector.recordRetry("provider_timeout");
    collector.recordToolCall("read_file");
    collector.recordToolExecution({
      toolName: "read_file",
      durationMs: 8,
      success: true,
      rawOutputBytes: 1_000,
      deliveredBytes: 200,
      originalBytes: 1_000,
      compressedBytes: 200,
    });
    collector.recordToolCall("read_file");
    collector.recordDuplicateEquivalentToolCall("read_file", 200);
    collector.recordContext({ initialContextBytes: 600, sourceCategories: { repository_evidence: 3 } });
    collector.recordResult("completed", "completed");

    const telemetry = collector.finalize({
      wallTimeMs: 42,
      forgeVerify: { status: "PASS", source: "OBSERVED" },
      completionGate: { status: "PASS", source: "OBSERVED" },
    });

    expect(telemetry.identity.repositoryGeneration).toBe(7);
    expect(telemetry.model.inputTokens).toMatchObject({ value: 100, source: "OBSERVED" });
    expect(telemetry.model.cachedInputTokens).toMatchObject({ value: 40, source: "OBSERVED" });
    expect(telemetry.model.effectiveUncachedInputTokens).toMatchObject({ value: 60, source: "DERIVED" });
    expect(telemetry.model.stablePromptCacheHits.value).toBe(1);
    expect(telemetry.tools.toolCalls.value).toBe(2);
    expect(telemetry.tools.executedToolCalls.value).toBe(1);
    expect(telemetry.tools.duplicateEquivalentToolCalls.value).toBe(1);
    expect(telemetry.tools.rawToolOutputBytes.value).toBe(1_000);
    expect(telemetry.tools.bytesDeliveredToModelContext.value).toBe(400);
    expect(telemetry.tools.compression.bytesAvoided.value).toBe(800);
    expect(telemetry.tools.byTool[0]).toMatchObject({ toolName: "read_file", calls: { value: 2 }, executed: { value: 1 }, suppressed: { value: 1 } });
    expect(JSON.stringify(telemetry)).not.toContain("read_file output");
  });

  it("does not convert missing cache data or authority parity into an experiment win", () => {
    const base = {
      workloadId: "workload-1",
      providerId: "provider-a",
      modelId: "model-a",
      repositoryRevision: "rev-1",
      verificationPolicyRevision: "policy-1",
      forgeVerifyStatus: { status: "PASS" as const, source: "OBSERVED" as const },
      completionGateStatus: { status: "PASS" as const, source: "OBSERVED" as const },
      taskCompletionStatus: "completed",
    };
    const incomplete = comparePromptCacheExperiment(
      { ...base, totalInputTokens: 100 },
      { ...base, cachedInputTokens: 50 },
    );
    expect(incomplete.comparable).toBe(false);
    expect(incomplete.netPositive).toBe(false);
    expect(incomplete.reasons).toContain("UNCACHED_INPUT_UNKNOWN");

    const comparison = comparePromptCacheExperiment(
      { ...base, totalInputTokens: 100, cachedInputTokens: 0, wallTimeMs: 100 },
      { ...base, totalInputTokens: 100, cachedInputTokens: 80, wallTimeMs: 100 },
    );
    expect(comparison.comparable).toBe(true);
    expect(comparison.verificationParity).toBe(true);
    expect(comparison.completionParity).toBe(true);
    expect(comparison.deltas.uncachedInputTokens).toBe(-80);
    expect(comparison.netPositive).toBe(true);
  });

  it("persists one run-scoped record through the existing session store", async () => {
    const persistence = createSessionPersistence({ dbPath: ":memory:" });
    await persistence.init();
    await persistence.upsertSession({
      id: "s0",
      title: "R0 test",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "running",
    });
    const collector = createForgeGreenR0TelemetryCollector({ runId: "r0-persist", sessionId: "s0", workspaceId: "w0" });
    collector.recordResult("blocked", "budget_exhausted");
    const telemetry = collector.finalize({ wallTimeMs: 9 });
    const store = createForgeGreenR0TelemetryStore(persistence);
    await store.save(telemetry);
    await store.save(telemetry);

    expect(await store.loadByRun("s0", "r0-persist")).toEqual(telemetry);
    expect(await store.loadByRun("other-session", "r0-persist")).toBeUndefined();
    await persistence.close();
  });
});
