import { beforeEach, describe, expect, it } from "vitest";
import { ForgeZero } from "@codeforge/forge-zero";
import { createSessionPersistence, type ISessionPersistence } from "@codeforge/sessions";
import { EightBitHealthTracker } from "../src/health.js";
import { EightBitReliabilityTracker } from "../src/reliability.js";
import { EightBitRouter } from "../src/router.js";
import { EightBitDecisionStore } from "../src/persistence.js";
import { EightBitFailoverCoordinator, type FailoverRequest } from "../src/failover.js";
import { makeModel } from "./fixtures.js";

let fw: ForgeZero;
let health: EightBitHealthTracker;
let router: EightBitRouter;
let store: EightBitDecisionStore;
let coordinator: EightBitFailoverCoordinator;
let persistence: ISessionPersistence;

beforeEach(async () => {
  fw = new ForgeZero();
  health = new EightBitHealthTracker(fw);
  router = new EightBitRouter(fw, health, new EightBitReliabilityTracker());
  persistence = createSessionPersistence({ dbPath: ":memory:" });
  await persistence.init();
  await persistence.upsertSession({ id: "s1", title: "t", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: "running" });
  store = new EightBitDecisionStore(persistence);
  coordinator = new EightBitFailoverCoordinator(health, router, store);
});

const baseReq: Omit<FailoverRequest, "error" | "current"> = {
  sessionId: "s1",
  turnId: "t1",
  role: "CODER",
  isExactPin: false,
  policyMode: "adaptive",
  hasAdapter: () => true,
};

describe("EightBitFailoverCoordinator — safe active-run handoff decision", () => {
  it("[PASS] a single quota-exhaustion failure rotates to the next eligible route (cross-provider — ForgeZero's markProviderHealth is provider-wide, so a realistic replacement is on a different provider)", async () => {
    fw.register(makeModel({ providerId: "openrouter", modelId: "primary" }));
    fw.register(makeModel({ providerId: "groq", modelId: "secondary" }));
    const outcome = await coordinator.handleFailure({ ...baseReq, current: { providerId: "openrouter", modelId: "primary" }, error: new Error("quota exhausted") });
    expect(outcome.action).toBe("rotate");
    if (outcome.action === "rotate") {
      expect(outcome.replacement).toEqual({ providerId: "groq", modelId: "secondary" });
      expect(outcome.receipt.action).toBe("ROTATE");
      expect(outcome.receipt.reasonCodes).toContain("QUOTA_EXHAUSTED");
    }
  });

  it("[PASS] a single TIMEOUT does not rotate (bounded retry first — never demote on one transient blip)", async () => {
    fw.register(makeModel({ providerId: "openrouter", modelId: "primary" }));
    fw.register(makeModel({ providerId: "groq", modelId: "secondary" }));
    const outcome = await coordinator.handleFailure({ ...baseReq, current: { providerId: "openrouter", modelId: "primary" }, error: new Error("request timed out") });
    expect(outcome.action).toBe("retry_same");
  });

  it("[PASS] sustained TIMEOUT failures eventually rotate", async () => {
    fw.register(makeModel({ providerId: "openrouter", modelId: "primary" }));
    fw.register(makeModel({ providerId: "groq", modelId: "secondary" }));
    const current = { providerId: "openrouter", modelId: "primary" };
    await coordinator.handleFailure({ ...baseReq, current, error: new Error("timed out") });
    await coordinator.handleFailure({ ...baseReq, current, error: new Error("timed out") });
    const outcome = await coordinator.handleFailure({ ...baseReq, current, error: new Error("timed out") });
    expect(outcome.action).toBe("rotate");
  });

  it("[PASS] an exact pin is NEVER silently auto-replaced, even after sustained failure", async () => {
    fw.register(makeModel({ modelId: "primary" }));
    fw.register(makeModel({ modelId: "secondary" }));
    const outcome = await coordinator.handleFailure({
      ...baseReq,
      isExactPin: true,
      current: { providerId: "openrouter", modelId: "primary" },
      error: new Error("quota exhausted"),
    });
    expect(outcome.action).toBe("no_replacement");
    if (outcome.action === "no_replacement") expect(outcome.receipt.action).toBe("EXACT_PIN_FAILED");
  });

  it("[PASS] no eligible replacement produces NO_ELIGIBLE_FREE_MODEL, not a silent paid/unknown fallback", async () => {
    fw.register(makeModel({ modelId: "primary" }));
    const outcome = await coordinator.handleFailure({ ...baseReq, current: { providerId: "openrouter", modelId: "primary" }, error: new Error("quota exhausted") });
    expect(outcome.action).toBe("no_replacement");
    if (outcome.action === "no_replacement") {
      expect(outcome.receipt.action).toBe("NO_ELIGIBLE_ROUTE");
      expect(outcome.receipt.reasonCodes).toContain("NO_ELIGIBLE_FREE_MODEL");
    }
  });

  it("[PASS] context-limit / invalid-tool-output failures surface directly rather than triggering route rotation", async () => {
    fw.register(makeModel({ modelId: "primary" }));
    fw.register(makeModel({ modelId: "secondary" }));
    const outcome = await coordinator.handleFailure({ ...baseReq, current: { providerId: "openrouter", modelId: "primary" }, error: new Error("maximum context length exceeded") });
    expect(outcome.action).toBe("surface");
  });

  it("[PASS] every rotation produces a persisted, inspectable decision receipt", async () => {
    fw.register(makeModel({ providerId: "openrouter", modelId: "primary" }));
    fw.register(makeModel({ providerId: "groq", modelId: "secondary" }));
    await coordinator.handleFailure({ ...baseReq, current: { providerId: "openrouter", modelId: "primary" }, error: new Error("quota exhausted") });
    const receipts = await store.listReceipts("s1");
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.previous).toEqual({ providerId: "openrouter", modelId: "primary" });
    expect(receipts[0]!.selected).toEqual({ providerId: "groq", modelId: "secondary" });
  });
});
