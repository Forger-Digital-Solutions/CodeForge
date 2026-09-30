import { afterEach, describe, expect, it, vi } from "vitest";
import { ForgeZero, type FreeModelRecord } from "@codeforge/forge-zero";
import { InMemoryProviderCatalog, createMockProvider } from "@codeforge/providers";
import type { ModelQualificationReceipt } from "@codeforge/eight-bit";
import {
  FreeCloudService,
  NormalizedModelRegistry,
  catalogPruneKeepSet,
  discoverAndVerifyFree,
  verifyAllowanceViaProbe,
  type ModelsDevDoc,
  type ProviderConnectionState,
} from "../src/index.js";

/**
 * R59 — free-supply recovery: the defects that produced the R58 false-zero.
 *
 * Proven defect chain: a transient 429 during qualification recorded a cooldown and left the
 * route verified-free-but-unmeasured; the cooldown correctly decayed to DEGRADED, but nothing
 * ever invoked qualification again — recoverable supply stayed invisible to ForgeAuto until a
 * restart or manual refresh. And on the discovery side, a failed allowance probe produced an
 * empty record set that `pruneStaleRoutes` treated as "the provider delisted everything".
 *
 * Everything here is deterministic: injected clock, scripted receipts, no wall-clock sleeps
 * except the single fake-timer test for the armed recovery schedule.
 */

const START = Date.now();

function freeRecord(providerId: string, modelId: string, overrides: Partial<FreeModelRecord> = {}): FreeModelRecord {
  return {
    providerId,
    modelId,
    displayName: modelId,
    freeStatus: "verified_free",
    freeStatusVerifiedAt: new Date(START).toISOString(),
    tier: "free",
    contextWindow: 131072,
    capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true },
    costProfile: {
      inputCostPerMillion: 0,
      outputCostPerMillion: 0,
      isFree: true,
      freeTierVerifiedAt: new Date(START).toISOString(),
      paidFallbackPossible: false,
      paidFallbackDisabled: true,
      source: "pricing+live-catalog",
    },
    isRemote: true,
    isCloudHosted: true,
    accessClass: providerId === "openrouter" ? "FREE_ROUTED" : "FREE_NATIVE",
    privacyClass: "standard",
    lastVerified: new Date(START).toISOString(),
    verificationSource: "pricing+live-catalog",
    health: { status: "available", lastCheckedAt: new Date(START).toISOString() },
    ...overrides,
  };
}

function connected(providerId: string, extra: Partial<ProviderConnectionState> = {}): ProviderConnectionState {
  return { providerId, connected: true, credentialSource: "SECURE_STORAGE", authState: "ok", ...extra };
}

function receipt(providerId: string, modelId: string, transient: boolean): ModelQualificationReceipt {
  const role = { role: "CODER" as const, status: "QUALIFIED" as const, testCases: [], hardFailures: [], overallScore: 1, startedAt: new Date(START).toISOString(), completedAt: new Date(START).toISOString() };
  return {
    suiteVersion: "R41_ROLE_QUALIFICATION_V3",
    providerId,
    modelId,
    modelDisplayName: modelId,
    accessClass: "FREE_ROUTED",
    freeStatus: "verified_free",
    roleResults: { CODER: role, TOOL_AGENT: role },
    startedAt: new Date(START).toISOString(),
    completedAt: new Date(START).toISOString(),
    totalLatencyMs: 5,
    // The receipt shape a 429-interrupted suite produces: inconclusive, never a verdict.
    qualificationState: transient ? "QUOTA_EXHAUSTED" : "QUALIFIED",
    hardFailureRoles: [],
    ...(transient ? { metadata: { transient: true, requests: 1 } } : {}),
  };
}

function harness(opts: {
  routes: Array<{ providerId: string; modelId: string }>;
  runner?: (providerId: string, modelId: string, callIndex: number) => ModelQualificationReceipt;
  cycleIntervalMs?: number;
  recoveryCap?: number;
  dailyBudget?: number;
}) {
  const fw = new ForgeZero();
  for (const r of opts.routes) fw.register(freeRecord(r.providerId, r.modelId));
  const catalog = new InMemoryProviderCatalog();
  for (const providerId of new Set(opts.routes.map((r) => r.providerId))) catalog.register(createMockProvider({ providerId }));
  let clock = START;
  const calls: string[] = [];
  const svc = new FreeCloudService({
    firewall: fw,
    providerCatalog: catalog,
    registry: new NormalizedModelRegistry(),
    now: () => new Date(clock),
    qualificationCycleIntervalMs: opts.cycleIntervalMs ?? 0,
    ...(opts.recoveryCap !== undefined ? { qualificationRecoveryAttemptsPerProviderPerDay: opts.recoveryCap } : {}),
    ...(opts.dailyBudget !== undefined ? { qualificationDailyBudgetPerProvider: opts.dailyBudget } : {}),
    qualificationRunner: async (model) => {
      calls.push(`${model.providerId}/${model.modelId}`);
      return opts.runner?.(model.providerId, model.modelId, calls.length) ?? receipt(model.providerId, model.modelId, false);
    },
  });
  for (const providerId of new Set(opts.routes.map((r) => r.providerId))) svc.setConnection(connected(providerId, { credentialSource: "OAUTH" }));
  return { svc, calls, advance: (ms: number) => { clock += ms; } };
}

describe("R59 — transient qualification failure keeps the route pending and arms recovery", () => {
  it("a 429-interrupted suite stores no receipt, records the cooldown, and schedules the aligned retry", async () => {
    const h = harness({
      routes: [{ providerId: "openrouter", modelId: "m:free" }],
      runner: (p, m) => receipt(p, m, true),
    });

    const produced = await h.svc.qualifyPending();
    expect(produced).toEqual([]);
    expect(h.calls).toEqual(["openrouter/m:free"]);

    const route = h.svc.snapshot().models[0]!.routes[0]!;
    // Transient evidence is a cooldown, not a qualification verdict — the route must stay
    // measured-never rather than absorbing a fabricated NOT_QUALIFIED.
    expect(route.health).toBe("COOLDOWN");
    expect(route.qualificationState).toBe("NOT_TESTED");
    expect(h.svc.isForgeAutoEligible("openrouter", "m:free")).toBe(false);

    const summary = h.svc.qualificationSummary().find((s) => s.providerId === "openrouter")!;
    expect(summary.recoveryScheduledAt).toBeDefined();
    // First RATE_LIMITED failure → 30s cooldown; the retry lands just past it.
    expect(Date.parse(summary.recoveryScheduledAt!)).toBeGreaterThanOrEqual(START + 30_000);
    // While the cooldown is active the route is waiting on evidence, not pending a probe —
    // pending re-admits it the moment the provider's own window expires.
    expect(summary.pending).toBe(0);
    expect(h.svc.pendingQualification()).toEqual([]);
  });

  it("once the cooldown expires the route is pending again — the armed timer fires a recovery cycle that qualifies it", async () => {
    vi.useFakeTimers();
    try {
      const h = harness({
        routes: [{ providerId: "openrouter", modelId: "m:free" }],
        // First attempt hits the transient upstream wall; the recovery probe lands clean.
        runner: (p, m, i) => receipt(p, m, i === 1),
      });
      await h.svc.qualifyPending();
      expect(h.calls).toHaveLength(1);

      // 30s cooldown + 250ms schedule margin — the service clock and the timer must move together.
      h.advance(31_000);
      expect(h.svc.pendingQualification().map((r) => r.providerModelId)).toEqual(["m:free"]);
      await vi.advanceTimersByTimeAsync(31_000);

      expect(h.calls).toHaveLength(2);
      expect(h.svc.isForgeAutoEligible("openrouter", "m:free")).toBe(true);
      expect(h.svc.qualificationSummary().find((s) => s.providerId === "openrouter")!.recoveryScheduledAt).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a normal cycle still respects the interval gate while recovery substitutes cooldown evidence", async () => {
    const h = harness({
      routes: [{ providerId: "openrouter", modelId: "m:free" }],
      cycleIntervalMs: 20 * 60_000,
      runner: (p, m) => receipt(p, m, true),
    });
    await h.svc.qualifyPending();
    h.advance(31_000); // cooldown expired; interval (20 min) has not

    // Non-recovery cycles are cadence-bound — spend discipline is unchanged.
    await h.svc.qualifyPending({ providerId: "openrouter" });
    expect(h.calls).toHaveLength(1);

    // Recovery cycles substitute the provider-stated cooldown for the interval.
    await h.svc.qualifyPending({ providerId: "openrouter", recovery: true });
    expect(h.calls).toHaveLength(2);
    const summary = h.svc.qualificationSummary().find((s) => s.providerId === "openrouter")!;
    expect(summary.recoveryAttemptsToday).toBe(1);
  });

  it("recovery is bounded: the per-day recovery cap stops a permanently saturated upstream from being re-probed forever", async () => {
    const h = harness({
      routes: [{ providerId: "openrouter", modelId: "m:free" }],
      recoveryCap: 1,
      runner: (p, m) => receipt(p, m, true),
    });
    await h.svc.qualifyPending();
    h.advance(31_000);
    await h.svc.qualifyPending({ recovery: true }); // recovery #1 — allowed
    expect(h.calls).toHaveLength(2);

    h.advance(61_000); // second-failure cooldown (~60s) expired
    await h.svc.qualifyPending({ recovery: true }); // cap reached — refused
    expect(h.calls).toHaveLength(2);
    expect(h.svc.qualificationSummary().find((s) => s.providerId === "openrouter")!.recoveryAttemptsToday).toBe(1);
  });

  it("the daily qualification budget binds recovery cycles exactly like normal ones", async () => {
    const h = harness({
      routes: [{ providerId: "openrouter", modelId: "m:free" }],
      // Compact runner spends 3/cycle; budget 3 leaves zero headroom after one cycle.
      dailyBudget: 3,
      runner: (p, m) => receipt(p, m, true),
    });
    await h.svc.qualifyPending();
    h.advance(31_000);
    await h.svc.qualifyPending({ recovery: true });
    expect(h.calls).toHaveLength(1); // refused: budget already spent
  });
});

describe("R59 — capacity projection explains the gate, not just UNHEALTHY", () => {
  it("a verified-free route awaiting qualification projects healthGate=CODEFORGE_QUALIFIED", () => {
    const h = harness({ routes: [{ providerId: "openrouter", modelId: "m:free" }] });
    const route = h.svc.capacityRoutes().find((r) => r.modelId === "m:free")!;
    // healthy=false is the fabric's conservative projection of "not ForgeAuto-admitted" —
    // the gate fields keep "never measured" from masquerading as a health failure.
    expect(route.healthy).toBe(false);
    expect(route.healthGate).toBe("CODEFORGE_QUALIFIED");
    expect(route.healthReason).toBeDefined();
  });

  it("a qualified route projects no gate detail — healthGate exists only for denials", async () => {
    const h = harness({ routes: [{ providerId: "openrouter", modelId: "m:free" }] });
    await h.svc.qualifyPending();
    const route = h.svc.capacityRoutes().find((r) => r.modelId === "m:free")!;
    expect(route.healthy).toBe(true);
    expect(route.healthGate).toBeUndefined();
  });
});

describe("R59 — catalogPruneKeepSet: inconclusive evidence never erases verified supply", () => {
  it("a failed allowance probe keeps every registered route the live catalog still lists", () => {
    const keep = catalogPruneKeepSet({
      registeredModelIds: ["a:free", "b:free", "c:free"],
      catalogModelIds: ["a:free", "b:free", "paid/x"],
      verifiedModelIds: [],
      probeFailed: true,
    });
    // c:free is dropped — the successful catalog listing affirmatively omits it (delisting is
    // real evidence). a/b stay: the failed probe proves nothing about their free status.
    expect([...keep].sort()).toEqual(["a:free", "b:free"]);
  });

  it("a failed read that returns zero listed models prunes nothing", () => {
    const keep = catalogPruneKeepSet({
      registeredModelIds: ["a:free", "b:free"],
      catalogModelIds: [],
      verifiedModelIds: [],
      probeFailed: true,
    });
    expect([...keep].sort()).toEqual(["a:free", "b:free"]);
  });

  it("a successful catalog prunes down to exactly the re-verified set", () => {
    const keep = catalogPruneKeepSet({
      registeredModelIds: ["a:free", "gone:free"],
      catalogModelIds: ["a:free", "paid/x"],
      verifiedModelIds: ["a:free"],
    });
    expect([...keep]).toEqual(["a:free"]);
  });

  it("a probe that fails with affirmative revocation evidence (402) is NOT inconclusive — prune to verified", () => {
    // "402 Payment Required" is real evidence the account's free access was revoked, the
    // opposite of a 429. Keeping last-verified routes on it would route work onto a plan
    // that bills — fail closed instead.
    const keep = catalogPruneKeepSet({
      registeredModelIds: ["a:free", "b:free"],
      catalogModelIds: ["a:free", "b:free"],
      verifiedModelIds: [],
      probeFailed: true,
      probeRevoked: true,
    });
    expect([...keep]).toEqual([]);
  });
});

describe("R59 — discovery surfaces the evidence class a probe produced", () => {
  it("verifyAllowanceViaProbe marks a failed probe without granting or denying free status", async () => {
    const reg = new NormalizedModelRegistry();
    reg.loadDoc(
      {
        groq: {
          id: "groq",
          models: {
            "llama-3.3-70b": { id: "llama-3.3-70b", tool_call: true, limit: { context: 128000 }, cost: { input: 0, output: 0 } },
          },
        },
      } as ModelsDevDoc,
      "live",
      new Date(START).toISOString(),
    );
    const result = await verifyAllowanceViaProbe(reg, "groq", [{ modelId: "llama-3.3-70b", toolCalling: true }], async () => ({ ok: false, error: "HTTP 429" }));
    expect(result.probeFailed).toBe(true);
    expect(result.probeRevoked).toBeUndefined();
    expect(result.verifiedCount).toBe(0);
    expect(result.catalogModelIds).toEqual(["llama-3.3-70b"]);

    const revoked = await verifyAllowanceViaProbe(reg, "groq", [{ modelId: "llama-3.3-70b", toolCalling: true }], async () => ({ ok: false, error: "402 Payment Required: free allowance expired" }));
    expect(revoked.probeFailed).toBe(true);
    expect(revoked.probeRevoked).toBe(true);
  });

  it("discoverAndVerifyFree returns the full live listing, not only the verified subset", () => {
    const reg = new NormalizedModelRegistry();
    reg.loadDoc(
      {
        openrouter: {
          id: "openrouter",
          models: {
            "a/model:free": { id: "a/model:free", tool_call: true, limit: { context: 100000 }, cost: { input: 0, output: 0 } },
          },
        },
      } as ModelsDevDoc,
      "live",
      new Date(START).toISOString(),
    );
    const result = discoverAndVerifyFree(reg, "openrouter", [
      { modelId: "a/model:free", isFree: true, contextWindow: 100000, toolCalling: true },
      { modelId: "paid/model", isFree: false },
    ]);
    expect(result.verifiedCount).toBe(1);
    expect(result.catalogModelIds).toEqual(["a/model:free", "paid/model"]);
  });
});

afterEach(() => {
  vi.useRealTimers();
});
