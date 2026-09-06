import { beforeEach, describe, expect, it } from "vitest";
import { createSessionPersistence, type ISessionPersistence } from "@codeforge/sessions";
import { EightBitDecisionStore, newReceiptId } from "../src/persistence.js";
import type { BindingScope } from "../src/router.js";
import type { DecisionReceipt } from "../src/types.js";

let persistence: ISessionPersistence;
let store: EightBitDecisionStore;

beforeEach(async () => {
  persistence = createSessionPersistence({ dbPath: ":memory:" });
  await persistence.init();
  await persistence.upsertSession({ id: "s1", title: "t", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: "running" });
  store = new EightBitDecisionStore(persistence);
});

const scope: BindingScope = { sessionId: "s1", role: "CODER" };

describe("EightBitDecisionStore — persistence via existing ISessionPersistence (SQLite/PostgreSQL)", () => {
  it("[PASS] saves and loads a route state", async () => {
    await store.saveRouteState(scope, { sessionId: "s1", role: "CODER", providerId: "openrouter", modelId: "m1", policyMode: "adaptive", isExactPin: false });
    const loaded = await store.loadRouteState(scope);
    expect(loaded?.providerId).toBe("openrouter");
    expect(loaded?.modelId).toBe("m1");
  });

  it("[PASS] upserting a route state twice updates it in place (mutable current-state semantics)", async () => {
    await store.saveRouteState(scope, { sessionId: "s1", role: "CODER", providerId: "openrouter", modelId: "m1", policyMode: "adaptive", isExactPin: false });
    await store.saveRouteState(scope, { sessionId: "s1", role: "CODER", providerId: "groq", modelId: "m2", policyMode: "adaptive", isExactPin: false });
    const loaded = await store.loadRouteState(scope);
    expect(loaded?.providerId).toBe("groq");
    const all = await store.loadAllRouteStates("s1");
    expect(all).toHaveLength(1);
  });

  it("[PASS] different roles/workstreams get independent bindings", async () => {
    await store.saveRouteState({ sessionId: "s1", role: "CODER" }, { sessionId: "s1", role: "CODER", providerId: "a", modelId: "x", policyMode: "adaptive", isExactPin: false });
    await store.saveRouteState({ sessionId: "s1", role: "REVIEWER" }, { sessionId: "s1", role: "REVIEWER", providerId: "b", modelId: "y", policyMode: "adaptive", isExactPin: false });
    await store.saveRouteState({ sessionId: "s1", role: "CODER", workstreamId: "alpha" }, { sessionId: "s1", role: "CODER", workstreamId: "alpha", providerId: "c", modelId: "z", policyMode: "adaptive", isExactPin: false });
    const all = await store.loadAllRouteStates("s1");
    expect(all).toHaveLength(3);
  });

  it("[PASS] decision receipts are append-only and exactly-once even if the same receiptId is recorded twice", async () => {
    const receipt: DecisionReceipt = {
      receiptId: newReceiptId(),
      createdAt: new Date().toISOString(),
      sessionId: "s1",
      role: "CODER",
      action: "ROTATE",
      policyMode: "adaptive",
      reasonCodes: ["QUOTA_EXHAUSTED"],
    };
    await store.recordReceipt(receipt);
    await store.recordReceipt(receipt);
    const receipts = await store.listReceipts("s1");
    expect(receipts).toHaveLength(1);
  });

  it("[PASS] receipts are ordered by createdAt", async () => {
    const r1: DecisionReceipt = { receiptId: newReceiptId(), createdAt: "2026-01-01T00:00:00.000Z", sessionId: "s1", role: "CODER", action: "INITIAL_SELECTION", policyMode: "adaptive", reasonCodes: [] };
    const r2: DecisionReceipt = { receiptId: newReceiptId(), createdAt: "2026-01-02T00:00:00.000Z", sessionId: "s1", role: "CODER", action: "ROTATE", policyMode: "adaptive", reasonCodes: [] };
    await store.recordReceipt(r2);
    await store.recordReceipt(r1);
    const receipts = await store.listReceipts("s1");
    expect(receipts.map((r) => r.action)).toEqual(["INITIAL_SELECTION", "ROTATE"]);
  });
});
