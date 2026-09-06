import { beforeEach, describe, expect, it } from "vitest";
import { ForgeZero } from "@codeforge/forge-zero";
import { createSessionPersistence, type ISessionPersistence } from "@codeforge/sessions";
import { EightBitRuntime } from "../src/runtime.js";
import { makeModel } from "./fixtures.js";

let fw: ForgeZero;
let persistence: ISessionPersistence;
let runtime: EightBitRuntime;

beforeEach(async () => {
  fw = new ForgeZero();
  persistence = createSessionPersistence({ dbPath: ":memory:" });
  await persistence.init();
  await persistence.upsertSession({ id: "s1", title: "t", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: "running" });
  runtime = new EightBitRuntime({ firewall: fw, persistence });
});

describe("EightBitRuntime — end-to-end facade", () => {
  it("[PASS] initial selection persists a route binding and a decision receipt", async () => {
    fw.register(makeModel({ modelId: "primary" }));
    fw.register(makeModel({ modelId: "secondary" }));
    const result = await runtime.selectInitialRoute(
      { sessionId: "s1", role: "CODER" },
      { policyMode: "adaptive", hasAdapter: () => true },
      {},
    );
    expect(result.outcome).toBe("selected");
    const saved = await runtime.store.loadRouteState({ sessionId: "s1", role: "CODER" });
    expect(saved?.providerId).toBe("openrouter");
    const receipts = await runtime.store.listReceipts("s1");
    expect(receipts.some((r) => r.action === "INITIAL_SELECTION")).toBe(true);
  });

  it("[PASS] restart recovery: rotating away from a failed route, then rehydrating a NEW runtime instance, does not resurrect the dead route", async () => {
    fw.register(makeModel({ providerId: "openrouter", modelId: "route-a" }));
    fw.register(makeModel({ providerId: "groq", modelId: "route-b" }));
    await runtime.selectInitialRoute({ sessionId: "s1", role: "CODER" }, { policyMode: "adaptive", hasAdapter: () => true }, {});
    const bound = runtime.router.currentBinding({ sessionId: "s1", role: "CODER" })!;
    expect(bound.modelId).toBe("route-a");

    const outcome = await runtime.handleTurnFailure({
      sessionId: "s1",
      turnId: "t1",
      role: "CODER",
      current: bound,
      isExactPin: false,
      policyMode: "adaptive",
      error: new Error("quota exhausted"),
      hasAdapter: () => true,
    });
    expect(outcome.action).toBe("rotate");

    // Simulate a process restart: brand-new ForgeZero + brand-new EightBitRuntime, same
    // persistence. Model A ("route-a") is still catalog-registered (still exists), so the
    // only thing that must prevent picking it again is 8-Bit's persisted health/binding.
    const fw2 = new ForgeZero();
    fw2.register(makeModel({ providerId: "openrouter", modelId: "route-a" }));
    fw2.register(makeModel({ providerId: "groq", modelId: "route-b" }));
    const runtime2 = new EightBitRuntime({ firewall: fw2, persistence });
    await runtime2.hydrate("s1");

    const rebound = runtime2.router.currentBinding({ sessionId: "s1", role: "CODER" });
    expect(rebound?.modelId).toBe("route-b");
    // The restored health state must also make route-a ineligible for a fresh selection.
    const reselected = runtime2.router.selectRoute({
      scope: { sessionId: "s1", role: "CODER" },
      policyMode: "adaptive",
      hasAdapter: () => true,
    });
    expect(reselected.outcome).toBe("selected");
    if (reselected.outcome === "selected") expect(reselected.model.modelId).not.toBe("route-a");
  });

  it("[PASS] tool-call outcomes recorded through the facade feed eligibility via the reliability tracker", async () => {
    fw.register(makeModel({ modelId: "flaky" }));
    for (let i = 0; i < 10; i++) runtime.recordToolCallOutcome("openrouter", "flaky", "malformed");
    const score = runtime.reliability.score("openrouter", "flaky");
    expect(score.quarantined).toBe(true);
  });
});
