import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSessionPersistence } from "@codeforge/sessions";
import {
  ReferenceHeuristicEstimator,
  createSustainabilityReceipt,
  createSustainabilityReceiptStore,
  finalizeSustainabilityReceipt,
  generateForgeGreenSummary,
  normalizeMeasurementInput,
  type NormalizedIdentity,
} from "../src/index.js";

const cleanups: string[] = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const dir = cleanups.pop();
    if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

function id(overrides: Partial<NormalizedIdentity> = {}): NormalizedIdentity {
  return { runId: "run-persist-1", sessionId: "session-persist-1", namespace: "ws-1", ...overrides };
}

describe("FG-8 persistence & durability", () => {
  it("append-only: saving the same finalized receipt twice never duplicates the record", async () => {
    const persistence = createSessionPersistence({ dbPath: ":memory:" });
    await persistence.init();
    await persistence.upsertSession({ id: "session-persist-1", title: "t", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: "running" });
    const store = createSustainabilityReceiptStore(persistence);
    const identity = id();
    const normalized = normalizeMeasurementInput({ identity, usage: { inputTokens: 10, outputTokens: 5, requestCount: 1 } });
    const receipt = finalizeSustainabilityReceipt(createSustainabilityReceipt({ identity, normalized }));
    await store.save(receipt);
    await store.save(receipt);
    const bySession = await store.loadBySession("session-persist-1");
    expect(bySession).toHaveLength(1);
    await persistence.close();
  });

  it("[hardening #5] restart/reload determinism: a receipt reloaded after a simulated process restart is semantically identical, and its regenerated summary matches", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "fg8-persist-"));
    cleanups.push(dir);
    const dbPath = path.join(dir, "fg8.db");

    const identity = id({ runId: "run-restart-1", sessionId: "session-restart-1" });
    const normalized = normalizeMeasurementInput({
      identity,
      usage: { inputTokens: 4200, outputTokens: 1800, cachedTokens: 900, requestCount: 3, provider: "openrouter", model: "m1" },
      toolExecutions: [
        { success: true, readOnly: true, durationMs: 20 },
        { success: false, readOnly: false, durationMs: 40 },
      ],
      wallClockMs: 5400,
    });
    const draft = createSustainabilityReceipt({ identity, normalized, energyEstimator: new ReferenceHeuristicEstimator() });
    const finalized = finalizeSustainabilityReceipt(draft);
    const summaryBefore = generateForgeGreenSummary(finalized);

    const persistenceA = createSessionPersistence({ dbPath });
    await persistenceA.init();
    await persistenceA.upsertSession({ id: "session-restart-1", title: "t", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: "running" });
    const storeA = createSustainabilityReceiptStore(persistenceA);
    await storeA.save(finalized);
    await persistenceA.close();

    // Simulate a fresh process/runtime: a brand-new persistence instance opened against the same
    // on-disk database, never sharing in-memory state with `persistenceA`.
    const persistenceB = createSessionPersistence({ dbPath });
    await persistenceB.init();
    const storeB = createSustainabilityReceiptStore(persistenceB);
    const reloaded = await storeB.loadByReceiptId(finalized.receiptId);
    await persistenceB.close();

    expect(reloaded).toBeDefined();
    // No documented exclusions: the receipt was already finalized (immutable, all timestamps
    // fixed) before it was persisted, so every field must round-trip identically.
    expect(reloaded).toEqual(finalized);

    const summaryAfter = generateForgeGreenSummary(reloaded!);
    expect(summaryAfter).toEqual(summaryBefore);
  });

  it("a receipt that failed to build (impossible input) is never silently dropped: the failure itself is representable and persistable", async () => {
    const persistence = createSessionPersistence({ dbPath: ":memory:" });
    await persistence.init();
    await persistence.upsertSession({ id: "session-persist-1", title: "t", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: "running" });
    const store = createSustainabilityReceiptStore(persistence);
    const identity = id();
    const { createFailedSustainabilityReceipt } = await import("../src/index.js");
    const failed = finalizeSustainabilityReceipt(createFailedSustainabilityReceipt(identity, ["UPSTREAM_DATA_UNAVAILABLE"]));
    await store.save(failed);
    const reloaded = await store.loadByReceiptId(failed.receiptId);
    expect(reloaded?.measurementStatus).toBe("failed");
    expect(reloaded?.measurementFailureReasonCodes).toContain("UPSTREAM_DATA_UNAVAILABLE");
    // Never a zero-value "successful" receipt standing in for the failure.
    expect(reloaded?.tokenAccounting.coverage).toBe("unavailable");
    expect(reloaded?.tokenAccounting.totalTokens).toBeUndefined();
    await persistence.close();
  });
});
