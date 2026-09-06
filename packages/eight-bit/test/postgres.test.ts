import { beforeEach, describe, expect, it } from "vitest";
import { ForgeZero } from "@codeforge/forge-zero";
import { createSessionPersistence, type ISessionPersistence } from "@codeforge/sessions";
import { EightBitRuntime } from "../src/runtime.js";
import { makeModel } from "./fixtures.js";

const TEST_PG = process.env.CODEFORGE_TEST_POSTGRES_URL || process.env.DATABASE_URL;

/**
 * §42 of the brief: 8-Bit state belongs to production session/runtime persistence, so it must
 * be certified against real PostgreSQL, not SQLite-only. This reuses the exact same
 * `EightBitDecisionStore`/`EightBitRuntime` code paths already certified against SQLite in
 * runtime.test.ts/persistence.test.ts — the only thing that changes is the driver.
 */
describe.skipIf(!TEST_PG?.startsWith("postgres"))("8-Bit persistence — real PostgreSQL", () => {
  let persistence: ISessionPersistence;
  let sessionId: string;

  beforeEach(async () => {
    persistence = createSessionPersistence({ driver: "postgres", databaseUrl: TEST_PG });
    await persistence.init();
    sessionId = `pg-eight-bit-session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await persistence.upsertSession({
      id: sessionId,
      title: "t",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "running",
    });
  });

  it("[PASS] route state, route health, and decision receipts round-trip through real PostgreSQL work_items", async () => {
    const fw = new ForgeZero();
    fw.register(makeModel({ providerId: "openrouter", modelId: "route-a" }));
    fw.register(makeModel({ providerId: "groq", modelId: "route-b" }));
    const runtime = new EightBitRuntime({ firewall: fw, persistence });

    const result = await runtime.selectInitialRoute(
      { sessionId, role: "CODER" },
      { policyMode: "adaptive", hasAdapter: () => true },
      {},
    );
    expect(result.outcome).toBe("selected");

    const outcome = await runtime.handleTurnFailure({
      sessionId,
      turnId: "t1",
      role: "CODER",
      current: { providerId: "openrouter", modelId: "route-a" },
      isExactPin: false,
      policyMode: "adaptive",
      error: new Error("quota exhausted"),
      hasAdapter: () => true,
    });
    expect(outcome.action).toBe("rotate");

    const savedState = await runtime.store.loadRouteState({ sessionId: sessionId, role: "CODER" });
    expect(savedState?.providerId).toBe("groq");

    const receipts = await runtime.store.listReceipts(sessionId);
    expect(receipts.some((r) => r.action === "ROTATE")).toBe(true);

    await persistence.close();
  });

  it("[PASS] restart recovery works identically against PostgreSQL: a brand-new EightBitRuntime rehydrates the cooldown", async () => {
    const fw1 = new ForgeZero();
    fw1.register(makeModel({ providerId: "openrouter", modelId: "route-a" }));
    fw1.register(makeModel({ providerId: "groq", modelId: "route-b" }));
    const runtime1 = new EightBitRuntime({ firewall: fw1, persistence });
    await runtime1.selectInitialRoute({ sessionId: sessionId, role: "CODER" }, { policyMode: "adaptive", hasAdapter: () => true }, {});
    await runtime1.handleTurnFailure({
      sessionId: sessionId,
      turnId: "t2",
      role: "CODER",
      current: { providerId: "openrouter", modelId: "route-a" },
      isExactPin: false,
      policyMode: "adaptive",
      error: new Error("quota exhausted"),
      hasAdapter: () => true,
    });

    const fw2 = new ForgeZero();
    fw2.register(makeModel({ providerId: "openrouter", modelId: "route-a" }));
    fw2.register(makeModel({ providerId: "groq", modelId: "route-b" }));
    const runtime2 = new EightBitRuntime({ firewall: fw2, persistence });
    await runtime2.hydrate(sessionId);
    const reselected = runtime2.router.selectRoute({ scope: { sessionId: sessionId, role: "CODER" }, policyMode: "adaptive", hasAdapter: () => true });
    expect(reselected.outcome).toBe("selected");
    if (reselected.outcome === "selected") expect(reselected.model.modelId).not.toBe("route-a");

    await persistence.close();
  });
});
