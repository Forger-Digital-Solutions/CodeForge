import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSessionPersistence } from "@codeforge/sessions";
import { createRepositoryIntelligence } from "@codeforge/repo-intelligence";
import {
  computeLiveContextPopulation,
  createForgeGreenLedgerCollector,
  createSustainabilityReceipt,
  createSustainabilityReceiptStore,
  finalizeSustainabilityReceipt,
  generateForgeGreenSummary,
  normalizeMeasurementInput,
  ReferenceHeuristicEstimator,
  type NormalizedIdentity,
} from "../src/index.js";

const cleanups: string[] = [];
const intelligences: Array<ReturnType<typeof createRepositoryIntelligence>> = [];

afterEach(async () => {
  await Promise.all(intelligences.splice(0).map((i) => i.closeWorkspace().catch(() => undefined)));
  await Promise.all(cleanups.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

/**
 * Drives the EXACT same sequence `AgentRuntime.persistForgeGreenSustainabilityReceipt`
 * (packages/server/src/agent-runtime.ts) drives in production — ledger snapshot → normalize
 * (with live routing/financial evidence + live context population) → build → finalize — using
 * real production-faithful components (a real ForgeGreenLedgerCollector, a real
 * RepositoryIntelligence instance indexing a real temp workspace) instead of a full HTTP/agent
 * loop. No network call is made anywhere in this test.
 */
async function driveRealisticLiveLifecycle() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fg8r-lifecycle-"));
  const cache = await fs.mkdtemp(path.join(os.tmpdir(), "fg8r-lifecycle-cache-"));
  cleanups.push(root, cache);
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fg8r-lifecycle", version: "1.0.0" }));
  for (let i = 0; i < 3; i++) {
    await fs.writeFile(path.join(root, `file-${i}.ts`), `export const value${i} = ${i};\n`);
  }
  const intelligence = createRepositoryIntelligence({ cacheRoot: cache });
  intelligences.push(intelligence);
  await intelligence.openWorkspace(root);
  await intelligence.indexWorkspace();

  // 1. run/session identity.
  const identity: NormalizedIdentity = { runId: "live-run-1", sessionId: "live-session-1", agentId: "agent-1", namespace: root, taskId: "task-live-1" };

  // 2. model route decision represented (a real 8-Bit `DecisionReceipt` shape — the ACTUAL live
  //    authority, since createRouteReceipt/createFinancialReceipt are unused in production).
  const decisionReceipts = [
    { receiptId: "decision-1", sessionId: "live-session-1", runId: "live-run-1", action: "rotate" as const, selected: { providerId: "openrouter", modelId: "glm-4.6" }, reasonCodes: ["PROVIDER_TIMEOUT", "REPLACEMENT_ELIGIBLE"], createdAt: new Date().toISOString() },
  ];

  // 3. FinancialReceipt represented — via the REAL live authority (FreeModelRecord), not the
  //    dead createFinancialReceipt() schema.
  const freeModelRecord = {
    providerId: "openrouter", modelId: "glm-4.6", accessClass: "VERIFIED_FREE", freeStatus: "verified_free" as const,
    costProfile: { isFree: true, paidFallbackPossible: false, paidFallbackDisabled: true, source: "openrouter-live" },
  };

  // 4. agent usage accumulated (real AgentUsage shape).
  const usage = { inputTokens: 3400, outputTokens: 1200, cachedTokens: 400, requestCount: 4, provider: "openrouter", model: "glm-4.6" };

  // 5. tools execute.
  const toolExecutions = [
    { success: true, readOnly: true, durationMs: 40 },
    { success: true, readOnly: false, durationMs: 120 },
    { success: false, readOnly: true, durationMs: 15 },
  ];

  // 6. context activity occurs — real ForgeGreenLedgerCollector, real page counters.
  const ledger = createForgeGreenLedgerCollector({ runId: "live-run-1", operation: "agent_run", namespace: root, sessionId: "live-session-1", agentId: "agent-1" });
  ledger.recordContextPagesReused(2);
  ledger.recordContextPagesPulled(1);
  ledger.recordModelFailoverRotation();

  // 7. verification activity occurs.
  ledger.recordVerificationObligations(2);
  ledger.recordVerificationTargetedSuiteUsed();
  ledger.recordVerificationFullSuiteAvoided();

  // 8. ForgeGreen ledger finalizes.
  const ledgerRecord = ledger.snapshot();

  // Real, bounded, zero-network live context population (Baseline B evidence).
  const contextPopulation = await computeLiveContextPopulation(intelligence, { actualTransmittedBytes: 10, actualTransmittedTokens: 3 });

  // 9. SustainabilityReceipt is normalized.
  const normalized = normalizeMeasurementInput({ identity, ledgerRecord, usage, toolExecutions, wallClockMs: 8200 });

  // 10. cross-receipt identities are validated + 11. Baseline B receives real eligible-context
  // population + 12. receipt finalizes.
  const draft = createSustainabilityReceipt({
    identity,
    normalized,
    live: { freeModelRecord, decisionReceipts },
    contextPopulation,
    energyEstimator: new ReferenceHeuristicEstimator(),
    taskId: "task-live-1",
  });
  const finalized = finalizeSustainabilityReceipt(draft);

  return { root, cache, identity, finalized };
}

describe("FG-8R full live-run lifecycle proof (§10)", () => {
  it("drives all 12 in-process lifecycle stages against production-faithful components and produces a COMPLETE, consistent receipt", async () => {
    const { finalized } = await driveRealisticLiveLifecycle();

    expect(finalized.measurementStatus).toBe("complete");
    expect(finalized.finalized).toBe(true);
    expect(finalized.tokenAccounting.totalTokens).toBe(4600);
    expect(finalized.toolAccounting.toolCallCount).toBe(3);
    expect(finalized.toolAccounting.toolFailureCount).toBe(1);
    expect(finalized.verificationAccounting.obligationsGenerated).toBe(2);
    expect(finalized.contextAccounting.contextPagesReused).toBe(2);
    expect(finalized.routingAccounting.modelFailoverRotations).toBe(1);
    expect(finalized.crossReceiptIntegrity.financialClassification).toBe("free");
    expect(finalized.crossReceiptIntegrity.financialClassificationSource).toBe("live_free_model_record");
    expect(finalized.crossReceiptIntegrity.liveModelProviderId).toBe("openrouter");
    expect(finalized.crossReceiptIntegrity.decisionReceiptIds).toEqual(["decision-1"]);
    const baselineB = finalized.baselines.find((b) => b.baselineKind === "B_NAIVE_FULL_CONTEXT");
    expect(baselineB).toBeDefined();

    const summary = generateForgeGreenSummary(finalized);
    expect(summary.measurementStatus).toBe("complete");
    expect(summary.headline).toContain("request");
  });

  it("[§11 restart/rehydration proof] persists the live-shaped receipt, reconstructs the runtime against a fresh persistence instance, reloads, and every authoritative field is identical", async () => {
    const { identity, finalized } = await driveRealisticLiveLifecycle();

    const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "fg8r-lifecycle-db-"));
    cleanups.push(dbDir);
    const dbPath = path.join(dbDir, "fg8r.db");

    const persistenceA = createSessionPersistence({ dbPath });
    await persistenceA.init();
    await persistenceA.upsertSession({ id: identity.sessionId!, title: "t", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: "running" });
    await createSustainabilityReceiptStore(persistenceA).save(finalized);
    await persistenceA.close();

    // "process/runtime is reconstructed": a brand-new persistence instance, sharing nothing but
    // the on-disk file.
    const persistenceB = createSessionPersistence({ dbPath });
    await persistenceB.init();
    const reloaded = await createSustainabilityReceiptStore(persistenceB).loadByReceiptId(finalized.receiptId);
    await persistenceB.close();

    expect(reloaded).toBeDefined();
    // schema version, normalization version, run/session identity, route reference, financial
    // reference, usage accounting, baseline provenance, estimator provenance, confidence
    // classifications — all identical, no reinterpretation due to restart.
    expect(reloaded!.receiptSchemaVersion).toBe(finalized.receiptSchemaVersion);
    expect(reloaded!.normalizationVersion).toBe(finalized.normalizationVersion);
    expect(reloaded!.runId).toBe(finalized.runId);
    expect(reloaded!.sessionId).toBe(finalized.sessionId);
    expect(reloaded!.crossReceiptIntegrity).toEqual(finalized.crossReceiptIntegrity);
    expect(reloaded!.tokenAccounting).toEqual(finalized.tokenAccounting);
    expect(reloaded!.baselines).toEqual(finalized.baselines);
    expect(reloaded!.energyEstimate).toEqual(finalized.energyEstimate);
    expect(reloaded!.carbonEstimate).toEqual(finalized.carbonEstimate);

    const summaryBefore = generateForgeGreenSummary(finalized);
    const summaryAfter = generateForgeGreenSummary(reloaded!);
    expect(summaryAfter).toEqual(summaryBefore);
  });
});
