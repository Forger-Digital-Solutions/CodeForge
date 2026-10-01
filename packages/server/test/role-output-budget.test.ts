import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ForgeZero,
  createGenericFreeRecord,
  CapacityReservationLedger,
  type CapacityRoute,
  type CapacityWindow,
  type FreeModelRecord,
  type ProviderCapacityPool,
} from "@codeforge/forge-zero";
import {
  type ProviderAdapter,
  type ProviderModel,
  type ChatRequest,
  type ChatResponse,
  type StreamEvent,
  InMemoryProviderCatalog,
} from "@codeforge/providers";
import { EventStore, createSessionPersistence, type ISessionPersistence } from "@codeforge/sessions";
import { createEightBitRuntime, createEightBitRouteHealthAuthority, createFreeFabric } from "@codeforge/eight-bit";
import { createAgentRuntime } from "../src/agent-runtime.js";
import {
  DEFAULT_REASONING_RESERVE_TOKENS,
  ROLE_OUTPUT_HARD_CAP_TOKENS,
  outputDemandForRole,
  roleOutputBudget,
  type ReasoningRouteProfile,
} from "../src/role-output-budget.js";

/**
 * R41: bounded model-aware output budgeting for orchestrated role runs. The R40 role
 * qualification corpus caught reasoning models starving their answers inside a bounded
 * maxTokens (north-mini-code: 457/500 tokens went to reasoning, empty content; gpt-oss-120b
 * failed at a 120-token cap and passed at 1500). These tests pin the contract: the role's
 * measured baseline plus a measured-reasoning reserve — bounded by the 4k hard cap, the run's
 * configured output ceiling, and the context room left — feeds both admission and dispatch,
 * and an empty or truncated reply is never booked as a verified success.
 */

const NOW = Date.parse("2026-10-01T00:00:00.000Z");

const LIVE_REASONING_PROFILES: Readonly<Record<string, ReasoningRouteProfile>> = {
  "reasoning-p/reasoner": {
    reasoningReserveTokens: 1_024,
    expiresAtMs: Date.parse("2026-12-01T00:00:00.000Z"),
    evidence: "test fixture: measured reasoning overhead",
  },
};

const STALE_REASONING_PROFILES: Readonly<Record<string, ReasoningRouteProfile>> = {
  "stale-p/stale-reasoner": {
    reasoningReserveTokens: 1_024,
    expiresAtMs: Date.parse("2026-08-01T00:00:00.000Z"),
    evidence: "test fixture: expired measurement",
  },
};

describe("roleOutputBudget — per-role, per-route output budgeting", () => {
  const budget = (input: Parameters<typeof roleOutputBudget>[0]) =>
    roleOutputBudget({ profiles: LIVE_REASONING_PROFILES, now: NOW, ...input });

  it("gives a measured reasoning route headroom past the R40 500-token starvation trap", () => {
    // R40: north-mini-code spent 457 of a 500-token budget on reasoning and returned nothing.
    // The reviewer demand — measured answer size plus the measured reasoning reserve — must
    // leave a real answer inside the request cap.
    const b = budget({ role: "reviewer", providerId: "reasoning-p", modelId: "reasoner" });
    expect(b.reasoningProfileApplied).toBe(true);
    expect(b.maxTokens).toBe(outputDemandForRole("reviewer") + DEFAULT_REASONING_RESERVE_TOKENS);
    expect(b.outputTokenDemand).toBe(b.maxTokens);
    const planner = budget({ role: "planner", providerId: "reasoning-p", modelId: "reasoner" });
    expect(planner.maxTokens).toBe(1_536 + DEFAULT_REASONING_RESERVE_TOKENS);
  });

  it("protects the reviewer role's measured baseline on an unprofiled route", () => {
    const b = budget({ role: "reviewer", providerId: "plain-p", modelId: "plain" });
    expect(b.maxTokens).toBe(1_024);
    expect(b.outputTokenDemand).toBe(1_024);
    expect(b.reasoningProfileApplied).toBe(false);
  });

  it("keeps a coder's full 4k of generation room whether or not the route is profiled", () => {
    for (const route of [
      { providerId: "reasoning-p", modelId: "reasoner" },
      { providerId: "plain-p", modelId: "plain" },
      {},
    ]) {
      const b = budget({ role: "coder", ...route });
      expect(b.maxTokens).toBe(ROLE_OUTPUT_HARD_CAP_TOKENS);
      expect(b.outputTokenDemand).toBe(ROLE_OUTPUT_HARD_CAP_TOKENS);
    }
  });

  it("adds no reasoning overhead for a route with no measured profile", () => {
    const b = budget({ role: "explorer", providerId: "plain-p", modelId: "plain" });
    expect(b.maxTokens).toBe(1_024);
    expect(b.reasoningProfileApplied).toBe(false);
  });

  it("ignores a profile whose measurement has expired", () => {
    const b = roleOutputBudget({
      role: "reviewer",
      providerId: "stale-p",
      modelId: "stale-reasoner",
      profiles: STALE_REASONING_PROFILES,
      now: NOW,
    });
    expect(b.maxTokens).toBe(1_024);
    expect(b.reasoningProfileApplied).toBe(false);
  });

  it("never exceeds the 4k hard cap or the context room actually left", () => {
    const generous = roleOutputBudget({
      role: "reviewer",
      providerId: "reasoning-p",
      modelId: "reasoner",
      profiles: {
        "reasoning-p/reasoner": {
          reasoningReserveTokens: 100_000,
          expiresAtMs: NOW + 1,
          evidence: "oversized fixture",
        },
      },
      now: NOW,
    });
    expect(generous.outputTokenDemand).toBeLessThanOrEqual(ROLE_OUTPUT_HARD_CAP_TOKENS);
    expect(generous.maxTokens).toBeLessThanOrEqual(ROLE_OUTPUT_HARD_CAP_TOKENS);

    const cramped = budget({ role: "reviewer", providerId: "reasoning-p", modelId: "reasoner", contextTokensRemaining: 300 });
    expect(cramped.maxTokens).toBe(300);
    expect(cramped.contextFits).toBe(true);
    // The reservation still reports the honest need — a hold must cover what the dispatch
    // wants even when the context window can't.
    expect(cramped.outputTokenDemand).toBe(2_048);
    expect(cramped.outputTokenDemand).toBeGreaterThanOrEqual(cramped.maxTokens);

    // R41: zero or negative room means no completion could ever fit — the budget says so
    // rather than masking the overflow behind a degenerate 1-token request.
    const exhausted = budget({ role: "reviewer", providerId: "plain-p", modelId: "plain", contextTokensRemaining: -50 });
    expect(exhausted.contextFits).toBe(false);
    expect(exhausted.maxTokens).toBe(0);
    const zeroRoom = budget({ role: "reviewer", providerId: "plain-p", modelId: "plain", contextTokensRemaining: 0 });
    expect(zeroRoom.contextFits).toBe(false);
    expect(zeroRoom.maxTokens).toBe(0);
  });

  it("reserves the bounded worst case while the route is undecided, so the hold covers every realized dispatch", () => {
    const admission = budget({ role: "reviewer" });
    expect(admission.outputTokenDemand).toBe(outputDemandForRole("reviewer") + DEFAULT_REASONING_RESERVE_TOKENS);
    expect(admission.reasoningProfileApplied).toBe(false); // undecided is not a classification

    const realizedProfiled = budget({ role: "reviewer", providerId: "reasoning-p", modelId: "reasoner" });
    const realizedPlain = budget({ role: "reviewer", providerId: "plain-p", modelId: "plain" });
    expect(admission.outputTokenDemand).toBeGreaterThanOrEqual(realizedProfiled.maxTokens);
    expect(admission.outputTokenDemand).toBeGreaterThanOrEqual(realizedPlain.maxTokens);
  });

  it("honors a run's smaller configured output ceiling", () => {
    const b = budget({ role: "coder", providerId: "plain-p", modelId: "plain", maxOutputTokens: 700 });
    expect(b.maxTokens).toBe(700);
    expect(b.outputTokenDemand).toBe(700);
  });
});

class CapturingProvider implements ProviderAdapter {
  readonly isTestProvider = true;
  readonly requests: ChatRequest[] = [];

  constructor(
    readonly providerId: string,
    private readonly modelId: string,
    private readonly script: (call: number) => StreamEvent[],
  ) {}

  async listModels(): Promise<ProviderModel[]> {
    return [{
      modelId: this.modelId,
      displayName: `${this.providerId} ${this.modelId}`,
      isFree: true,
      freeStatus: "verified_free",
      capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true },
    }];
  }

  async chat(_req: ChatRequest): Promise<ChatResponse> {
    throw new Error("Use streamChat");
  }

  async *streamChat(req: ChatRequest): AsyncIterable<StreamEvent> {
    this.requests.push(req);
    yield* this.script(this.requests.length);
  }

  async healthCheck() {
    return { status: "available" as const };
  }
}

const reviewerReply = (verdict = "pass"): StreamEvent[] => [
  { type: "text_delta", delta: JSON.stringify({ verdict, findings: [], summary: "No issues found." }) },
  { type: "usage", usage: { inputTokens: 60, outputTokens: 90 } },
  { type: "finish", finishReason: "stop" },
];

function fleetRecord(providerId: string, modelId: string, overrides: Partial<FreeModelRecord> = {}): FreeModelRecord {
  return createGenericFreeRecord({ providerId, modelId, displayName: `${providerId} ${modelId}`, ...overrides });
}

describe("R41 output budgeting — wired through executeAgentRun", () => {
  let ws: string;
  let eventStore: EventStore;
  let persistence: ISessionPersistence;
  let firewall: ForgeZero;
  let catalog: InMemoryProviderCatalog;

  const TEST_PROFILES: Readonly<Record<string, ReasoningRouteProfile>> = {
    "reasoning-a/reasoner-a": {
      reasoningReserveTokens: 1_024,
      expiresAtMs: Date.parse("2099-01-01T00:00:00.000Z"),
      evidence: "test fixture",
    },
    // The fabric fixture derives model ids as `${providerId}-model`.
    "reasoning-a/reasoning-a-model": {
      reasoningReserveTokens: 1_024,
      expiresAtMs: Date.parse("2099-01-01T00:00:00.000Z"),
      evidence: "test fixture",
    },
  };

  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), "cf-r41-budget-"));
    eventStore = new EventStore();
    persistence = createSessionPersistence({ dbPath: ":memory:" });
    await persistence.init();
    firewall = new ForgeZero();
    catalog = new InMemoryProviderCatalog();
  });

  afterEach(async () => {
    await persistence.close();
    await rm(ws, { recursive: true, force: true });
  });

  const makeRuntime = (sessionId: string, eightBit?: ReturnType<typeof createEightBitRuntime>) =>
    createAgentRuntime({
      sessionId,
      eventStore,
      persistence,
      firewall,
      providerCatalog: catalog,
      workspacePath: ws,
      reasoningRouteProfiles: TEST_PROFILES,
      ...(eightBit ? { eightBit } : {}),
    });

  const runReviewer = (runtime: ReturnType<typeof createAgentRuntime>, selection?: { providerId: string; modelId: string }, roleRouting = false) =>
    runtime.executeAgentRun({
      runId: `run-${Math.random().toString(36).slice(2, 8)}`,
      agentId: "reviewer-1",
      role: "reviewer",
      goal: "Review the diff",
      workspaceId: "ws-r41",
      workspacePath: ws,
      permissions: { read: true, search: true, write: false, executeCommand: false, network: false },
      structuredOutput: "reviewer",
      ...(selection ? { modelSelection: selection } : {}),
      roleRouting,
    });

  it("asks a pinned measured-reasoning route for the role demand plus its measured reserve", async () => {
    firewall.register(fleetRecord("reasoning-a", "reasoner-a"));
    const provider = new CapturingProvider("reasoning-a", "reasoner-a", () => reviewerReply());
    catalog.register(provider);

    const result = await runReviewer(makeRuntime("sess-r41-pin"), { providerId: "reasoning-a", modelId: "reasoner-a" });

    expect(result.status).toBe("completed");
    expect(provider.requests.length).toBe(1);
    expect(provider.requests[0]!.maxTokens).toBe(2_048);
  });

  it("asks an unprofiled pinned route for exactly the role baseline — no reasoning overhead", async () => {
    firewall.register(fleetRecord("plain-b", "plain-b"));
    const provider = new CapturingProvider("plain-b", "plain-b", () => reviewerReply());
    catalog.register(provider);

    const result = await runReviewer(makeRuntime("sess-r41-plain"), { providerId: "plain-b", modelId: "plain-b" });

    expect(result.status).toBe("completed");
    expect(provider.requests[0]!.maxTokens).toBe(1_024);
  });

  it("reserves at admission exactly the tokens the selected reasoning route is asked for", async () => {
    firewall.register(fleetRecord("reasoning-a", "reasoner-a"));
    const provider = new CapturingProvider("reasoning-a", "reasoner-a", () => reviewerReply());
    catalog.register(provider);
    const eightBit = createEightBitRuntime({ firewall, persistence });
    const selectSpy = vi.spyOn(eightBit, "selectInitialRoute");
    const runtime = makeRuntime("sess-r41-admission", eightBit);

    const result = await runReviewer(runtime, undefined, true);

    expect(result.status).toBe("completed");
    expect(selectSpy).toHaveBeenCalledOnce();
    const admissionDemand = selectSpy.mock.calls[0]![1].outputTokenDemand;
    const dispatchedCap = provider.requests[0]!.maxTokens;
    expect(dispatchedCap).toBe(2_048);
    expect(admissionDemand).toBe(dispatchedCap);
  });

  it("recomputes the budget for the replacement route after a failover rotation", async () => {
    firewall.register(fleetRecord("reasoning-a", "reasoner-a", { benchmarkProfile: { coding: 90, toolCalling: 90, reasoning: 90, longContext: 90, speed: 90 } }));
    firewall.register(fleetRecord("plain-b", "plain-b", { benchmarkProfile: { coding: 40, toolCalling: 40, reasoning: 40, longContext: 40, speed: 40 } }));
    const providerA = new CapturingProvider("reasoning-a", "reasoner-a", () => [
      { type: "error", code: "PROVIDER_RATE_LIMITED", status: 429, message: "429 rate limit exceeded", retryable: true },
    ]);
    const providerB = new CapturingProvider("plain-b", "plain-b", () => reviewerReply());
    catalog.register(providerA);
    catalog.register(providerB);
    const eightBit = createEightBitRuntime({ firewall, persistence });
    const failoverSpy = vi.spyOn(eightBit, "handleTurnFailure");
    const runtime = makeRuntime("sess-r41-rotate", eightBit);

    const result = await runReviewer(runtime, undefined, true);

    expect(result.status).toBe("completed");
    expect(providerA.requests.length).toBe(1);
    expect(providerB.requests.length).toBe(1);
    // The starving route was asked for reasoning headroom; the unprofiled replacement gets
    // the plain role baseline — the budget follows the route, not the run.
    expect(providerA.requests[0]!.maxTokens).toBe(2_048);
    expect(providerB.requests[0]!.maxTokens).toBe(1_024);
    // The re-decide carries the bounded worst case as the flat fallback plus the
    // per-candidate demand — each candidate's hold is exactly what the continuation would
    // place on it.
    const reDecide = failoverSpy.mock.calls[0]![0];
    expect(reDecide.outputTokenDemand).toBe(2_048);
    expect(reDecide.outputTokenDemandFor!("reasoning-a", "reasoner-a")).toBe(2_048);
    expect(reDecide.outputTokenDemandFor!("plain-b", "plain-b")).toBe(1_024);
    expect(reDecide.outputTokenDemandFor!("plain-b", "plain-b")).toBeGreaterThanOrEqual(providerB.requests[0]!.maxTokens!);
  });

  it("counts reasoning tokens in usage and never treats an empty cap-starved reply as verified success", async () => {
    firewall.register(fleetRecord("starved-p", "starved-m"));
    // Replay of the R40 north-mini-code failure shape: the whole budget burns on reasoning,
    // the answer is empty, and the finish reason says the cap was hit.
    const provider = new CapturingProvider("starved-p", "starved-m", () => [
      { type: "usage", usage: { inputTokens: 30, outputTokens: 500, reasoningTokens: 457 } },
      { type: "finish", finishReason: "length" },
    ]);
    catalog.register(provider);
    const eightBit = createEightBitRuntime({ firewall, persistence });
    const successSpy = vi.spyOn(eightBit, "recordSuccess");
    const failureSpy = vi.spyOn(eightBit, "recordFailure");
    const observeSpy = vi.spyOn(eightBit, "observe");
    const runtime = makeRuntime("sess-r41-starved", eightBit);

    const result = await runtime.executeAgentRun({
      runId: "run-r41-starved",
      agentId: "reviewer-starved",
      role: "reviewer",
      goal: "Review the diff",
      workspaceId: "ws-r41",
      workspacePath: ws,
      permissions: { read: true, search: true, write: false, executeCommand: false, network: false },
      structuredOutput: "reviewer",
      modelSelection: { providerId: "starved-p", modelId: "starved-m" },
      executionBudget: { maxModelTurns: 2, maxToolCalls: 5, maxContextTokens: 64_000 },
    });

    expect(result.status).toBe("blocked");
    expect(provider.requests.length).toBe(2); // one bounded re-ask, no blind retry loop
    expect(result.usage.reasoningTokens).toBe(914);
    // An unserved reply is never a verified success — but it is not provider-outage
    // evidence either: no availability failure is recorded and no quota churn is created.
    // What the route earns is the honest role-scoped outcome — it failed to deliver this
    // role's output — which soft-demotes it for this role without touching availability.
    expect(successSpy).not.toHaveBeenCalled();
    expect(failureSpy).not.toHaveBeenCalled();
    const roleOutcomes = observeSpy.mock.calls.filter(([observation]) => observation.kind === "role_outcome");
    expect(roleOutcomes.length).toBeGreaterThanOrEqual(1);
    for (const [observation] of roleOutcomes) {
      expect(observation.kind === "role_outcome" ? observation.outcome : undefined).toBe("role_failed");
      expect(observation.providerId).toBe("starved-p");
      expect(observation.role).toBe("REVIEWER");
    }
  });

  it("blocks before any provider request when the transcript alone fills the route's context window", async () => {
    // The route advertises a 700-token window: the authoritative kernel (~584 tokens) fits,
    // but the measured dispatch (system + role tools + task, ~1.9k tokens) leaves zero room
    // for a completion — so the turn is declined before the wire, never a degenerate
    // 1-token request that could only return truncated output.
    firewall.register(fleetRecord("tiny-ctx", "tiny-ctx", { contextWindow: 700 }));
    const provider = new CapturingProvider("tiny-ctx", "tiny-ctx", () => reviewerReply());
    catalog.register(provider);
    const eightBit = createEightBitRuntime({ firewall, persistence });
    const successSpy = vi.spyOn(eightBit, "recordSuccess");
    const failureSpy = vi.spyOn(eightBit, "recordFailure");
    const runtime = makeRuntime("sess-r41-tinyctx", eightBit);

    const result = await runReviewer(runtime, { providerId: "tiny-ctx", modelId: "tiny-ctx" });

    expect(result.status).toBe("blocked");
    expect(result.error).toBe("AGENT_CONTEXT_BUDGET_EXCEEDED");
    expect(provider.requests.length).toBe(0);
    // Nothing was dispatched, so nothing is recorded against the route's health at all.
    expect(successSpy).not.toHaveBeenCalled();
    expect(failureSpy).not.toHaveBeenCalled();
  });

  it("never re-asks a provider safety refusal — content_filter blocks after a single request", async () => {
    // The provider's safety system refused the dispatch. Re-asking the identical transcript
    // can only draw the same refusal, so the run blocks on the spot — no second request,
    // no bounded repair consumed.
    firewall.register(fleetRecord("filtered-p", "filtered-m"));
    const provider = new CapturingProvider("filtered-p", "filtered-m", () => [
      { type: "usage", usage: { inputTokens: 30, outputTokens: 0 } },
      { type: "finish", finishReason: "content_filter" },
    ]);
    catalog.register(provider);
    const eightBit = createEightBitRuntime({ firewall, persistence });
    const successSpy = vi.spyOn(eightBit, "recordSuccess");
    const observeSpy = vi.spyOn(eightBit, "observe");
    const runtime = makeRuntime("sess-r41-filtered", eightBit);

    const result = await runReviewer(runtime, { providerId: "filtered-p", modelId: "filtered-m" });

    expect(result.status).toBe("blocked");
    expect(provider.requests.length).toBe(1);
    // The refusal is role-scoped evidence — never a verified success.
    expect(successSpy).not.toHaveBeenCalled();
    expect(observeSpy.mock.calls.some(([o]) => o.kind === "role_outcome" && o.outcome === "role_failed")).toBe(true);
  });
});

const OBSERVED_AT = new Date(Date.now() - 60_000).toISOString();
const NO_RESET = "9999-12-31T23:59:59.999Z";

function quotaWindow(overrides: Partial<CapacityWindow> = {}): CapacityWindow {
  return { unit: "requests", limit: 100, remaining: 100, resetAt: NO_RESET, scope: "ORG", observedAt: OBSERVED_AT, authoritative: true, ...overrides };
}

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
    roles: ["PRIMARY_CODING_AGENT", "PLANNER", "REVIEWER", "SUBAGENT", "FAST_REASONER"],
    qualityScore: 70,
    healthy: true,
    enabled: true,
    windows: [quotaWindow(), quotaWindow({ unit: "input_tokens", limit: 2_000_000, remaining: 2_000_000 })],
    ...overrides,
  };
}

function poolFor(route: CapacityRoute): ProviderCapacityPool {
  return {
    poolId: route.capacityPoolId,
    providerId: route.providerId,
    scope: route.capacityPoolScope,
    supplyClass: route.supplyClass,
    windows: route.windows,
    observedAt: OBSERVED_AT,
    authoritative: true,
  };
}

describe("R41 output budgeting — per-candidate admission demand through the Free Fabric", () => {
  let ws: string;
  let eventStore: EventStore;
  let persistence: ISessionPersistence;
  let firewall: ForgeZero;
  let catalog: InMemoryProviderCatalog;

  const TEST_PROFILES: Readonly<Record<string, ReasoningRouteProfile>> = {
    "reasoning-a/reasoning-a-model": {
      reasoningReserveTokens: 1_024,
      expiresAtMs: Date.parse("2099-01-01T00:00:00.000Z"),
      evidence: "test fixture",
    },
  };

  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), "cf-r41-fabric-"));
    eventStore = new EventStore();
    persistence = createSessionPersistence({ dbPath: ":memory:" });
    await persistence.init();
    firewall = new ForgeZero();
    catalog = new InMemoryProviderCatalog();
  });

  afterEach(async () => {
    await persistence.close();
    await rm(ws, { recursive: true, force: true });
  });

  it("admits a qualifying non-reasoning candidate under a tight output window instead of false-waiting on the worst case", async () => {
    // Both pools hold a 1500-token output window with one token already spent (1499
    // remaining). Route A ranks first on quality but carries a live measured reasoning
    // profile, so this dispatch's 2048-token hold clamps to the 1500 limit — and a whole-
    // window hold cannot fit a partial window: denied. Route B is unprofiled: the same
    // dispatch reserves only the 1024 it would actually request, which fits, so B admits
    // and serves. Under the flat worst-case demand both holds would deny and the run would
    // wait on capacity it never needed (the R34 false-wait regression).
    const authority = createEightBitRouteHealthAuthority();
    const tightWindows = (): CapacityWindow[] => [
      quotaWindow(),
      quotaWindow({ unit: "input_tokens", limit: 2_000_000, remaining: 2_000_000 }),
      quotaWindow({ unit: "output_tokens", limit: 1_500, remaining: 1_499 }),
    ];
    const routeA = fabricRoute("reasoning-a", { qualityScore: 95, windows: tightWindows() });
    const routeB = fabricRoute("plain-b", { qualityScore: 70, windows: tightWindows() });
    const fabric = createFreeFabric({
      managedRoutes: () => [routeA, routeB],
      managedPools: () => [poolFor(routeA), poolFor(routeB)],
      userSources: [],
      health: authority,
      reservations: new CapacityReservationLedger({ routes: [], pools: [] }),
    });
    firewall.register(fleetRecord("reasoning-a", "reasoning-a-model"));
    firewall.register(fleetRecord("plain-b", "plain-b-model"));
    const providerA = new CapturingProvider("reasoning-a", "reasoning-a-model", () => reviewerReply());
    const providerB = new CapturingProvider("plain-b", "plain-b-model", () => reviewerReply());
    catalog.register(providerA);
    catalog.register(providerB);
    const runtime = createAgentRuntime({
      sessionId: "sess-r41-quota",
      eventStore,
      persistence,
      firewall,
      providerCatalog: catalog,
      workspacePath: ws,
      reasoningRouteProfiles: TEST_PROFILES,
      routeHealth: authority,
      freeFabric: fabric,
      fabricContext: () => ({ userId: "anonymous", userIdentities: [] }),
    });

    const result = await runtime.executeAgentRun({
      runId: "run-r41-quota",
      agentId: "reviewer-quota",
      role: "reviewer",
      goal: "Review the diff",
      workspaceId: "ws-r41",
      workspacePath: ws,
      permissions: { read: true, search: true, write: false, executeCommand: false, network: false },
      structuredOutput: "reviewer",
      roleRouting: true,
    });

    expect(result.status).toBe("completed");
    // The reasoning-profiled route was denied at admission — it never executed a request —
    // and the qualifying unprofiled route served at exactly the cap its hold reserved:
    // per-candidate demand, not an under-reserved flat number.
    expect(providerA.requests.length).toBe(0);
    expect(providerB.requests.length).toBe(1);
    expect(providerB.requests[0]!.maxTokens).toBe(1_024);
  });
});
