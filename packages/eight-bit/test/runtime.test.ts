import { beforeEach, describe, expect, it } from "vitest";
import { ForgeZero, CapacityReservationLedger, type CapacityRoute, type CapacityWindow } from "@codeforge/forge-zero";
import { createSessionPersistence, type ISessionPersistence } from "@codeforge/sessions";
import { EightBitRuntime } from "../src/runtime.js";
import { createFreeFabric } from "../src/free-fabric.js";
import { EightBitRouteHealthAuthority } from "../src/route-health-authority.js";
import { makeModel } from "./fixtures.js";

const OBSERVED_AT = new Date(Date.now() - 60_000).toISOString();
const NO_RESET = "9999-12-31T23:59:59.999Z";

function fabricRoute(id: string, overrides: Partial<CapacityRoute> = {}): CapacityRoute {
  return {
    routeId: `fabric:${id}`,
    providerId: id,
    modelId: `${id}-model`,
    canonicalModelId: `${id}-model`,
    family: id,
    gateway: id,
    supplyClass: "PURE_MANAGED_FREE",
    capacityPoolId: `shared:${id}`,
    capacityPoolScope: "SHARED_OWNER_POOL",
    capacityScope: "ORG",
    dataPolicyProfile: "PRIVATE_CODE_ALLOWED",
    lifecycle: "APPROVED",
    explicitZeroPrice: true,
    paidFallbackDisabled: true,
    managedMultiUserAllowed: true,
    privacyClass: "standard",
    // Fabric capacity routes speak product-role vocabulary: CODER maps to PRIMARY_CODING_AGENT
    // at the runtime seam (FABRIC_MODEL_ROLE), so the fixture must declare that role.
    roles: ["PRIMARY_CODING_AGENT"],
    qualityScore: 70,
    healthy: true,
    enabled: true,
    windows: [{ unit: "requests", limit: 100, remaining: 100, resetAt: NO_RESET, scope: "ORG", observedAt: OBSERVED_AT, authoritative: true } as CapacityWindow],
    ...overrides,
  };
}

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
  it("rotates between same-model independent pools without cooling the healthy pool or global model", async () => {
    fw.register(makeModel({ providerId: "provider-a", modelId: "provider-a-model" }));
    const primary = fabricRoute("provider-a", { routeId: "account-a", capacityPoolId: "account-a", qualityScore: 90 });
    const standby = { ...primary, routeId: "account-b", capacityPoolId: "account-b", qualityScore: 70 };
    const health = new EightBitRouteHealthAuthority();
    const fabric = createFreeFabric({ managedRoutes: () => [primary, standby], health, reservations: new CapacityReservationLedger({ routes: [] }) });
    const fabricRuntime = new EightBitRuntime({ firewall: fw, persistence, freeFabric: fabric, routeHealth: health });
    const initial = await fabricRuntime.selectInitialRoute({ sessionId: "s1", role: "CODER" }, { policyMode: "adaptive", hasAdapter: () => true }, { runId: "domain-run" });
    expect(initial.fabric?.selected?.capacityPoolId).toBe("account-a");
    const outcome = await fabricRuntime.handleTurnFailure({ sessionId: "s1", turnId: "domain-turn", runId: "domain-run", role: "CODER", policyMode: "adaptive", current: { providerId: "provider-a", modelId: "provider-a-model" }, currentCapacityPoolId: "account-a", preferIndependentFromPoolId: "account-a", isExactPin: false, hasAdapter: () => true, error: Object.assign(new Error("429 rate limited"), { status: 429, retryAfter: 60 }) });
    expect(outcome.action).toBe("rotate");
    expect(outcome.capacityPoolId).toBe("account-b");
    expect(outcome.receipt?.evidence).toMatchObject({ previousCapacityPoolId: "account-a", capacityPoolId: "account-b" });
    expect(health.assess("provider-a", "provider-a-model", { quotaDomainId: "account-a" }).hardExclude).toBe(true);
    expect(health.assess("provider-a", "provider-a-model", { quotaDomainId: "account-b" }).hardExclude).toBe(false);
    expect(fw.eligibleModels().some((model) => model.modelId === "provider-a-model")).toBe(true);
  });
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

  it("R51: failover measures an unmeasured candidate once, then the fabric re-decide admits it", async () => {
    // The failed route leaves only an unmeasured candidate — zero quota windows, denied as
    // CAPACITY_UNMEASURED. measureCapacity is the bounded probe seam: after it lands real
    // windows, the coordinator's own re-decide rotates onto the now-admitted route. Without
    // the hook the same situation stays a truthful no_replacement.
    fw.register(makeModel({ providerId: "dead", modelId: "dead-model" }));
    fw.register(makeModel({ providerId: "provider-b", modelId: "provider-b-model" }));
    let measured = false;
    const unmeasuredB = fabricRoute("provider-b", { windows: [] });
    const measuredB = fabricRoute("provider-b");
    const fabric = createFreeFabric({
      managedRoutes: () => [measured ? measuredB : unmeasuredB],
      managedPools: () => [],
      reservations: new CapacityReservationLedger({ routes: [], now: () => Date.now() }),
    });
    const fabricRuntime = new EightBitRuntime({ firewall: fw, persistence, freeFabric: fabric });
    const probes: string[] = [];
    const outcome = await fabricRuntime.handleTurnFailure({
      sessionId: "s1",
      turnId: "t-fail",
      role: "CODER",
      current: { providerId: "dead", modelId: "dead-model" },
      isExactPin: false,
      policyMode: "adaptive",
      error: new Error("quota exhausted"),
      hasAdapter: () => true,
      measureCapacity: async (providerId, modelId) => {
        probes.push(`${providerId}/${modelId}`);
        measured = true;
        return true;
      },
    });
    expect(outcome.action).toBe("rotate");
    expect(probes).toEqual(["provider-b/provider-b-model"]);
    if (outcome.action === "rotate") {
      expect(outcome.replacement).toEqual({ providerId: "provider-b", modelId: "provider-b-model" });
    }
  });

  it("R51: without a measure hook an unmeasured candidate is a truthful no_replacement — never capacity_wait", async () => {
    fw.register(makeModel({ providerId: "dead", modelId: "dead-model" }));
    fw.register(makeModel({ providerId: "provider-b", modelId: "provider-b-model" }));
    const fabric = createFreeFabric({
      managedRoutes: () => [fabricRoute("provider-b", { windows: [] })],
      managedPools: () => [],
      reservations: new CapacityReservationLedger({ routes: [], now: () => Date.now() }),
    });
    const fabricRuntime = new EightBitRuntime({ firewall: fw, persistence, freeFabric: fabric });
    const outcome = await fabricRuntime.handleTurnFailure({
      sessionId: "s1",
      turnId: "t-fail2",
      role: "CODER",
      current: { providerId: "dead", modelId: "dead-model" },
      isExactPin: false,
      policyMode: "adaptive",
      error: new Error("quota exhausted"),
      hasAdapter: () => true,
    });
    expect(outcome.action).toBe("no_replacement");
    // CAPACITY_UNMEASURED never masquerades as a capacity wait — there is no reset to wait for.
    expect((outcome as { capacityWait?: unknown }).capacityWait).toBeUndefined();
  });

  it("R59: failover joins a live qualification lane once, then the re-decide admits the landed route", async () => {
    // provider-b exists but its role verdict has not landed yet (roles: [] — the fabric cannot
    // admit it). The host's awaitQualification hook runs the bounded recovery wait; once the
    // receipt lands mid-wait the same re-decide rotates onto the now-admissible route.
    fw.register(makeModel({ providerId: "dead", modelId: "dead-model" }));
    fw.register(makeModel({ providerId: "provider-b", modelId: "provider-b-model" }));
    let receiptLanded = false;
    const fabric = createFreeFabric({
      managedRoutes: () => [fabricRoute("provider-b", receiptLanded ? {} : { roles: [] })],
      managedPools: () => [],
      reservations: new CapacityReservationLedger({ routes: [], now: () => Date.now() }),
    });
    const fabricRuntime = new EightBitRuntime({ firewall: fw, persistence, freeFabric: fabric });
    let awaits = 0;
    const outcome = await fabricRuntime.handleTurnFailure({
      sessionId: "s1",
      turnId: "t-qual",
      role: "CODER",
      current: { providerId: "dead", modelId: "dead-model" },
      isExactPin: false,
      policyMode: "adaptive",
      error: new Error("quota exhausted"),
      hasAdapter: () => true,
      awaitQualification: async () => {
        awaits++;
        receiptLanded = true;
        return true;
      },
    });
    expect(outcome.action).toBe("rotate");
    expect(awaits).toBe(1);
    if (outcome.action === "rotate") {
      expect(outcome.replacement).toEqual({ providerId: "provider-b", modelId: "provider-b-model" });
    }
  });

  it("R59: a spent qualification lane leaves no_replacement terminal — awaitQualification false means no retry", async () => {
    fw.register(makeModel({ providerId: "dead", modelId: "dead-model" }));
    fw.register(makeModel({ providerId: "provider-b", modelId: "provider-b-model" }));
    const fabric = createFreeFabric({
      managedRoutes: () => [fabricRoute("provider-b", { roles: [] })],
      managedPools: () => [],
      reservations: new CapacityReservationLedger({ routes: [], now: () => Date.now() }),
    });
    const fabricRuntime = new EightBitRuntime({ firewall: fw, persistence, freeFabric: fabric });
    let awaits = 0;
    const outcome = await fabricRuntime.handleTurnFailure({
      sessionId: "s1",
      turnId: "t-qual-dead",
      role: "CODER",
      current: { providerId: "dead", modelId: "dead-model" },
      isExactPin: false,
      policyMode: "adaptive",
      error: new Error("quota exhausted"),
      hasAdapter: () => true,
      // The lane is at its daily budget — nothing live to wait on, so the hook declines
      // and the denial must stay terminal rather than re-deciding over identical state.
      awaitQualification: async () => { awaits++; return false; },
    });
    expect(outcome.action).toBe("no_replacement");
    expect(awaits).toBe(1);
  });
});
