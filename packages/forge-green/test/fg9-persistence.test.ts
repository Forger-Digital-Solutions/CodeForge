import { describe, expect, it } from "vitest";
import { createSessionPersistence } from "@codeforge/sessions";
import {
  buildDuplicateToolReuseDecision,
  createOptimizationDecisionStore,
  createOptimizationReceiptStore,
  finalizeOptimizationDecision,
  type OptimizationDecisionStatus,
} from "../src/index.js";

async function seededPersistence(sessionId: string) {
  const persistence = createSessionPersistence({ dbPath: ":memory:" });
  await persistence.init();
  await persistence.upsertSession({ id: sessionId, title: "t", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: "running" });
  return persistence;
}

describe("FG-9 persistence (§30 items 15-19)", () => {
  it("[15] a decision persists and reloads with identical fields", async () => {
    const persistence = await seededPersistence("s1");
    const store = createOptimizationDecisionStore(persistence);
    const result = buildDuplicateToolReuseDecision({ runId: "r1", sessionId: "s1", sustainabilityReceiptId: "recv-1", events: [{ tool: "read_file", identityKeyHash: "h1", priorExecutionId: "e1", avoidedBytes: 100 }] })!;
    await store.save(result.decision);
    const reloaded = await store.loadByDecisionId(result.decision.decisionId);
    expect(reloaded).toEqual(result.decision);
    await persistence.close();
  });

  it("[16] a receipt persists and reloads with identical fields", async () => {
    const persistence = await seededPersistence("s1");
    const store = createOptimizationReceiptStore(persistence);
    const result = buildDuplicateToolReuseDecision({ runId: "r1", sessionId: "s1", sustainabilityReceiptId: "recv-1", events: [{ tool: "read_file", identityKeyHash: "h1", priorExecutionId: "e1", avoidedBytes: 100 }] })!;
    await store.save(result.receipt);
    const reloaded = await store.loadByReceiptId(result.receipt.receiptId);
    expect(reloaded).toEqual(result.receipt);
    await persistence.close();
  });

  it("[17] restart does not reapply a completed optimization: saving the same decision twice (simulating a post-restart retry) never duplicates it", async () => {
    const persistence = await seededPersistence("s1");
    const store = createOptimizationDecisionStore(persistence);
    const result = buildDuplicateToolReuseDecision({ runId: "r1", sessionId: "s1", sustainabilityReceiptId: "recv-1", events: [{ tool: "read_file", identityKeyHash: "h1", priorExecutionId: "e1", avoidedBytes: 100 }] })!;
    await store.save(result.decision);
    await store.save(result.decision); // retried write after a simulated restart
    const all = await store.loadBySession("s1");
    expect(all).toHaveLength(1);
    await persistence.close();
  });

  it("[18] an INVALIDATED decision stays invalid across reload — reload never reinterprets status", async () => {
    const persistence = await seededPersistence("s1");
    const store = createOptimizationDecisionStore(persistence);
    const result = buildDuplicateToolReuseDecision({ runId: "r1", sessionId: "s1", sustainabilityReceiptId: "recv-1", events: [{ tool: "read_file", identityKeyHash: "h1", priorExecutionId: "e1", avoidedBytes: 100 }] })!;
    // Simulate post-hoc invalidation (e.g. a verification run afterward proved it unsafe): a
    // fresh finalized record with status INVALIDATED, distinct decisionId (content-addressed).
    const invalidated = finalizeOptimizationDecision({
      ...result.decision,
      finalized: false,
      finalizedAt: undefined,
      status: "INVALIDATED" as OptimizationDecisionStatus,
      statusReasonCodes: ["POST_HOC_VERIFICATION_FAILURE"],
      decisionId: `${result.decision.decisionId}-invalidated`,
    });
    await store.save(invalidated);
    const reloaded = await store.loadByDecisionId(invalidated.decisionId);
    expect(reloaded?.status).toBe("INVALIDATED");
    await persistence.close();
  });

  it("[19] prevented-work metrics are not doubled: two DIFFERENT runs' decisions both persist distinctly, and their avoided-tool-execution counts remain separate, never summed into one record", async () => {
    const persistence = await seededPersistence("s1");
    const store = createOptimizationDecisionStore(persistence);
    const runA = buildDuplicateToolReuseDecision({ runId: "run-a", sessionId: "s1", sustainabilityReceiptId: "recv-a", events: [{ tool: "read_file", identityKeyHash: "h1", priorExecutionId: "e1", avoidedBytes: 100 }] })!;
    const runB = buildDuplicateToolReuseDecision({ runId: "run-b", sessionId: "s1", sustainabilityReceiptId: "recv-b", events: [{ tool: "read_file", identityKeyHash: "h2", priorExecutionId: "e2", avoidedBytes: 200 }, { tool: "list_files", identityKeyHash: "h3", priorExecutionId: "e3", avoidedBytes: 50 }] })!;
    await store.save(runA.decision);
    await store.save(runB.decision);
    const all = await store.loadBySession("s1");
    expect(all).toHaveLength(2);
    const forRunA = all.find((d) => d.runId === "run-a");
    const forRunB = all.find((d) => d.runId === "run-b");
    expect(forRunA?.expectedEffect.avoidedToolExecutions).toBe(1);
    expect(forRunB?.expectedEffect.avoidedToolExecutions).toBe(2);
    await persistence.close();
  });
});
