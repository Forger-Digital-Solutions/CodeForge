import { describe, expect, it } from "vitest";
import { createSessionPersistence } from "@codeforge/sessions";
import {
  createSustainabilityReceipt,
  createSustainabilityReceiptStore,
  finalizeSustainabilityReceipt,
  normalizeMeasurementInput,
  type NormalizedIdentity,
} from "../src/index.js";

function id(overrides: Partial<NormalizedIdentity> = {}): NormalizedIdentity {
  return { runId: "run-retry-1", sessionId: "session-retry-1", namespace: "ws-1", ...overrides };
}

describe("FG-8R duplicate finalization / retry safety (§12)", () => {
  it("running the exact same 'finalize + persist' flow twice (simulating a crash/retry) never duplicates the receipt, double-counts tokens, or doubles a baseline", async () => {
    const persistence = createSessionPersistence({ dbPath: ":memory:" });
    await persistence.init();
    await persistence.upsertSession({ id: "session-retry-1", title: "t", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: "running" });
    const store = createSustainabilityReceiptStore(persistence);

    const identity = id();
    const normalized = normalizeMeasurementInput({
      identity,
      usage: { inputTokens: 500, outputTokens: 200, requestCount: 1 },
    });

    // Simulate the exact retry shape: the SAME upstream data is re-processed twice (e.g. a
    // process crash right after finalization but before the caller observed success).
    async function attempt() {
      const finalized = finalizeSustainabilityReceipt(createSustainabilityReceipt({ identity, normalized }));
      await store.save(finalized);
      return finalized;
    }

    const first = await attempt();
    const second = await attempt();

    // Deterministic construction -> identical receiptId -> insertIfAbsent makes the retry a no-op.
    expect(second.receiptId).toBe(first.receiptId);
    const stored = await store.loadBySession("session-retry-1");
    expect(stored).toHaveLength(1);
    expect(stored[0]!.tokenAccounting.totalTokens).toBe(700); // never doubled to 1400
    await persistence.close();
  });

  it("a retry that legitimately observed MORE work (e.g. the run continued after the first crash) produces a genuinely different receiptId and is stored as a separate record — never silently merged", async () => {
    const persistence = createSessionPersistence({ dbPath: ":memory:" });
    await persistence.init();
    await persistence.upsertSession({ id: "session-retry-1", title: "t", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: "running" });
    const store = createSustainabilityReceiptStore(persistence);
    const identity = id();

    const firstNormalized = normalizeMeasurementInput({ identity, usage: { inputTokens: 100, outputTokens: 50, requestCount: 1 } });
    const first = finalizeSustainabilityReceipt(createSustainabilityReceipt({ identity, normalized: firstNormalized }));
    await store.save(first);

    const secondNormalized = normalizeMeasurementInput({ identity, usage: { inputTokens: 300, outputTokens: 150, requestCount: 3 } });
    const second = finalizeSustainabilityReceipt(createSustainabilityReceipt({ identity, normalized: secondNormalized }));
    await store.save(second);

    expect(second.receiptId).not.toBe(first.receiptId);
    const stored = await store.loadBySession("session-retry-1");
    expect(stored).toHaveLength(2);
    await persistence.close();
  });
});
