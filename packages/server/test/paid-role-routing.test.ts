import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ForgeZero, createGenericFreeRecord } from "@codeforge/forge-zero";
import {
  type ProviderAdapter,
  type ProviderModel,
  type ChatRequest,
  type ChatResponse,
  type StreamEvent,
  InMemoryProviderCatalog,
} from "@codeforge/providers";
import { EventStore, createSessionPersistence } from "@codeforge/sessions";
import {
  PAID_AUTO_AUTO_MODEL_ID,
  PAID_AUTO_MODELS,
  PAID_AUTO_PROVIDER_ID,
  PaidAutoService,
  type PaidAutoRouteId,
  type PaidRoleVerdict,
} from "@codeforge/paid-auto";
import { ManagedPaidAllowanceLedger, summarizeShillings, ShillingLedger, type ManagedPaidPolicy, type ShillingEntry } from "@codeforge/cloud-usage";
import { createAgentRuntime } from "../src/agent-runtime.js";
import { createWorkspaceEventAdapter } from "../src/workspace-event-adapter.js";

/**
 * R48 C2: `paid-auto/auto` + roleRouting resolves the per-role paid canonical through
 * selectRoleRoute inside executeAgentRun, rotates inside the paid roster on failure, and
 * never consults the free fleet. The underlying provider adapters are scripted — the
 * routing evidence (router.selection/router.failover events, per-route request counts)
 * is what these tests assert on.
 */
class ScriptedPaidUpstream implements ProviderAdapter {
  readonly isTestProvider = true;
  requests = 0;

  constructor(
    readonly providerId: string,
    private readonly behavior: "serve" | "rate_limit" | "flaky" = "serve",
  ) {}

  async listModels(): Promise<ProviderModel[]> {
    return [{
      modelId: "upstream",
      displayName: `${this.providerId} upstream`,
      isFree: false,
      freeStatus: "paid",
      capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true },
    }];
  }

  async chat(_req: ChatRequest): Promise<ChatResponse> {
    throw new Error("Use streamChat");
  }

  async *streamChat(_req: ChatRequest): AsyncIterable<StreamEvent> {
    this.requests++;
    if (this.behavior === "rate_limit") {
      yield { type: "error", code: "RATE_LIMITED", message: "429 rate limit exceeded", retryable: true };
      return;
    }
    if (this.behavior === "flaky" && this.requests === 1) {
      // Retryable timeout — classified ambiguous_execution, so no circuit opens; the
      // runtime's bounded same-route retry is what must absorb it.
      yield { type: "error", code: "TIMEOUT", message: "request timed out", retryable: true };
      return;
    }
    yield { type: "text_delta", delta: "Task completed." };
    yield { type: "finish", finishReason: "stop" };
  }

  async healthCheck() {
    return { status: "available" as const };
  }
}

const credentials = {
  get: () => "test-key",
  set: () => undefined,
  delete: () => true,
  has: () => true,
};

function qualifiedRoutes(): Partial<Record<PaidAutoRouteId, { state: "READY"; commercialEligibility: "verified"; privacy: "verified"; capabilityParity: "verified"; certification: "CERTIFIED" }>> {
  return Object.fromEntries(PAID_AUTO_MODELS.flatMap((model) => [model.direct, model.fallback]).map((route) => [route.routeId, {
    state: "READY",
    commercialEligibility: "verified",
    privacy: "verified",
    capabilityParity: "verified",
    certification: "CERTIFIED",
  }])) as never;
}

function verdict(model: string, role: string, status: PaidRoleVerdict["status"]): PaidRoleVerdict {
  return { canonicalModelId: model as PaidRoleVerdict["canonicalModelId"], role, status, measuredAt: new Date().toISOString(), source: "test" };
}

function paidService(verdicts: readonly PaidRoleVerdict[], upstreams: Partial<Record<"openai" | "zai" | "alibaba" | "deepseek" | "openrouter", ProviderAdapter>>): PaidAutoService {
  return new PaidAutoService({
    credentialStore: credentials,
    paidExecutionEnabled: true,
    openRouterFallbackEnabled: true,
    routeQualifications: qualifiedRoutes(),
    roleVerdicts: verdicts,
    adapters: upstreams,
  });
}

const ROLE_RUN = {
  role: "coder" as const,
  goal: "Do the thing",
  workspaceId: "ws-paid-role",
  permissions: { read: true, search: true, write: false, executeCommand: false, network: false },
  modelSelection: { providerId: PAID_AUTO_PROVIDER_ID, modelId: PAID_AUTO_AUTO_MODEL_ID },
  roleRouting: true,
};

describe("R48 C2 — paid per-role routing in executeAgentRun", () => {
  let ws: string;
  let eventStore: EventStore;
  let persistence: ReturnType<typeof createSessionPersistence>;

  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), "cf-paid-role-"));
    eventStore = new EventStore();
    persistence = createSessionPersistence({ dbPath: ":memory:" });
    persistence.upsertSession({
      id: "sess-paid-role",
      title: "Paid Role Routing Test Session",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "idle",
    });
  });

  afterEach(async () => {
    persistence.close();
    await rm(ws, { recursive: true, force: true });
  });

  function runtime(paidAuto: PaidAutoService | undefined): ReturnType<typeof createAgentRuntime> {
    const catalog = new InMemoryProviderCatalog();
    if (paidAuto) catalog.register(paidAuto.asProviderAdapter());
    return createAgentRuntime({
      sessionId: "sess-paid-role",
      eventStore,
      persistence,
      firewall: new ForgeZero(),
      providerCatalog: catalog,
      workspacePath: ws,
      paidAuto,
    });
  }

  it("resolves paid-auto/auto to the qualified canonical and dispatches through its route", async () => {
    const alibaba = new ScriptedPaidUpstream("alibaba");
    const zai = new ScriptedPaidUpstream("zai");
    const paidAuto = paidService(
      [verdict("qwen3.8-flash", "CODER", "QUALIFIED"), verdict("glm-5.3-flash", "CODER", "QUALIFIED")],
      { alibaba, zai },
    );
    const adapter = createWorkspaceEventAdapter({ sessionId: "sess-paid-role", eventStore, persistence });

    const result = await runtime(paidAuto).executeAgentRun({
      runId: "run-paid-role-1",
      agentId: "agent-paid-1",
      workspacePath: ws,
      adapter,
      ...ROLE_RUN,
    });

    expect(result.status).toBe("completed");
    // qwen (cheapest qualified) won the role selection and served through its direct route.
    expect(alibaba.requests).toBeGreaterThan(0);
    expect(zai.requests).toBe(0);
    const selection = eventStore.getAll().find((event) => event.type === "router.selection");
    expect(selection?.payload).toMatchObject({ providerId: PAID_AUTO_PROVIDER_ID, modelId: "qwen3.8-flash" });
    const shillings = await persistence.getWorkItemsByKind("shilling_entry");
    expect(shillings.length).toBeGreaterThan(0);
    expect(shillings[0]).toMatchObject({ entry: { sourceClass: "MANAGED_PAID", conversion: { confidence: "UNKNOWN" }, shConsumed: null, managedSpendUsd: null } });
  });

  it("only selects paid models authorized by the resolved user roster", async () => {
    const alibaba = new ScriptedPaidUpstream("alibaba");
    const zai = new ScriptedPaidUpstream("zai");
    const paidAuto = paidService([verdict("qwen3.8-flash", "CODER", "QUALIFIED"), verdict("glm-5.3-flash", "CODER", "QUALIFIED")], { alibaba, zai });
    const result = await runtime(paidAuto).executeAgentRun({
      runId: "run-paid-roster", agentId: "agent-paid-roster", workspacePath: ws,
      rosterAllowance: { freeRoutes: [], paidModelIds: ["glm-5.3-flash"], userRoutes: [] },
      ...ROLE_RUN,
    });
    expect(result.status).toBe("completed");
    expect(zai.requests).toBeGreaterThan(0);
    expect(alibaba.requests).toBe(0);
  });

  it("does not rotate to an unselected paid model after provider failure", async () => {
    const alibaba = new ScriptedPaidUpstream("alibaba", "rate_limit");
    const openrouter = new ScriptedPaidUpstream("openrouter", "rate_limit");
    const zai = new ScriptedPaidUpstream("zai");
    const paidAuto = paidService([verdict("qwen3.8-flash", "CODER", "QUALIFIED"), verdict("glm-5.3-flash", "CODER", "QUALIFIED")], { alibaba, openrouter, zai });
    const result = await runtime(paidAuto).executeAgentRun({
      runId: "run-paid-roster-failover", agentId: "agent-paid-roster-failover", workspacePath: ws,
      rosterAllowance: { freeRoutes: [], paidModelIds: ["qwen3.8-flash"], userRoutes: [] },
      ...ROLE_RUN,
    });
    expect(result.status).not.toBe("completed");
    expect(zai.requests).toBe(0);
  });

  it("rotates inside the paid roster when the selected canonical fails — never the free fleet", async () => {
    // qwen: both its routes die on 429 → circuit opens → the canonical is exhausted.
    // glm (next qualified) serves the run through its zai direct route.
    const alibaba = new ScriptedPaidUpstream("alibaba", "rate_limit");
    const openrouter = new ScriptedPaidUpstream("openrouter", "rate_limit");
    const zai = new ScriptedPaidUpstream("zai");
    const paidAuto = paidService(
      [verdict("qwen3.8-flash", "CODER", "QUALIFIED"), verdict("glm-5.3-flash", "CODER", "QUALIFIED")],
      { alibaba, openrouter, zai },
    );
    const adapter = createWorkspaceEventAdapter({ sessionId: "sess-paid-role", eventStore, persistence });

    const result = await runtime(paidAuto).executeAgentRun({
      runId: "run-paid-role-2",
      agentId: "agent-paid-2",
      workspacePath: ws,
      adapter,
      ...ROLE_RUN,
    });

    expect(result.status).toBe("completed");
    expect(alibaba.requests).toBeGreaterThan(0);
    expect(openrouter.requests).toBeGreaterThan(0);
    expect(zai.requests).toBeGreaterThan(0);
    const failover = eventStore.getAll().find((event) => event.type === "router.failover");
    expect(failover?.payload).toMatchObject({
      fromModelId: `${PAID_AUTO_PROVIDER_ID}/qwen3.8-flash`,
      toModelId: `${PAID_AUTO_PROVIDER_ID}/glm-5.3-flash`,
    });
    // Every recorded failover stayed inside the paid roster — no free route was consulted.
    for (const event of eventStore.getAll().filter((e) => e.type === "router.failover")) {
      expect(String((event.payload as { fromModelId?: string }).fromModelId)).toContain(`${PAID_AUTO_PROVIDER_ID}/`);
      expect(String((event.payload as { toModelId?: string }).toModelId)).toContain(`${PAID_AUTO_PROVIDER_ID}/`);
    }
  });

  it("fails closed with PROVIDER_UNAVAILABLE when no model is qualified for the role", async () => {
    const alibaba = new ScriptedPaidUpstream("alibaba");
    const paidAuto = paidService(
      PAID_AUTO_MODELS.map((model) => verdict(model.canonicalModelId, "CODER", "NOT_QUALIFIED")),
      { alibaba },
    );
    const adapter = createWorkspaceEventAdapter({ sessionId: "sess-paid-role", eventStore, persistence });

    const result = await runtime(paidAuto).executeAgentRun({
      runId: "run-paid-role-3",
      agentId: "agent-paid-3",
      workspacePath: ws,
      adapter,
      ...ROLE_RUN,
    });

    expect(result.status).toBe("failed");
    expect(result.summary).toContain("PROVIDER_UNAVAILABLE");
    expect(result.summary).toContain("no_qualified_role_route");
    expect(alibaba.requests).toBe(0);
  });

  it("probation fallback — a PROBATION route serves only after the QUALIFIED route dies", async () => {
    // glm is QUALIFIED (outranks probation regardless of price); qwen is PROBATION.
    const zai = new ScriptedPaidUpstream("zai", "rate_limit");
    const openrouter = new ScriptedPaidUpstream("openrouter", "rate_limit");
    const alibaba = new ScriptedPaidUpstream("alibaba");
    const paidAuto = paidService(
      [verdict("glm-5.3-flash", "CODER", "QUALIFIED"), verdict("qwen3.8-flash", "CODER", "PROBATION")],
      { zai, openrouter, alibaba },
    );
    const adapter = createWorkspaceEventAdapter({ sessionId: "sess-paid-role", eventStore, persistence });

    const result = await runtime(paidAuto).executeAgentRun({
      runId: "run-paid-role-5",
      agentId: "agent-paid-5",
      workspacePath: ws,
      adapter,
      ...ROLE_RUN,
    });

    expect(result.status).toBe("completed");
    expect(zai.requests).toBeGreaterThan(0);
    expect(alibaba.requests).toBeGreaterThan(0);
    const failover = eventStore.getAll().find((event) => event.type === "router.failover");
    expect(failover?.payload).toMatchObject({
      fromModelId: `${PAID_AUTO_PROVIDER_ID}/glm-5.3-flash`,
      toModelId: `${PAID_AUTO_PROVIDER_ID}/qwen3.8-flash`,
    });
  });

  it("bounded same-route retry — a retryable non-circuit failure retries the same canonical once", async () => {
    const alibaba = new ScriptedPaidUpstream("alibaba", "flaky");
    const zai = new ScriptedPaidUpstream("zai");
    const paidAuto = paidService(
      [verdict("qwen3.8-flash", "CODER", "QUALIFIED"), verdict("glm-5.3-flash", "CODER", "QUALIFIED")],
      { alibaba, zai },
    );
    const adapter = createWorkspaceEventAdapter({ sessionId: "sess-paid-role", eventStore, persistence });

    const result = await runtime(paidAuto).executeAgentRun({
      runId: "run-paid-role-6",
      agentId: "agent-paid-6",
      workspacePath: ws,
      adapter,
      ...ROLE_RUN,
    });

    expect(result.status).toBe("completed");
    expect(alibaba.requests).toBe(2);
    // A same-route retry is not a failover — the roster was never rotated.
    expect(zai.requests).toBe(0);
    expect(eventStore.getAll().some((event) => event.type === "router.failover")).toBe(false);
  });

  it("roster exhausted — every canonical dead fails the run; no free route is substituted", async () => {
    const alibaba = new ScriptedPaidUpstream("alibaba", "rate_limit");
    const zai = new ScriptedPaidUpstream("zai", "rate_limit");
    const openrouter = new ScriptedPaidUpstream("openrouter", "rate_limit");
    const paidAuto = paidService(
      [verdict("qwen3.8-flash", "CODER", "QUALIFIED"), verdict("glm-5.3-flash", "CODER", "QUALIFIED")],
      { alibaba, zai, openrouter },
    );
    const adapter = createWorkspaceEventAdapter({ sessionId: "sess-paid-role", eventStore, persistence });

    const result = await runtime(paidAuto).executeAgentRun({
      runId: "run-paid-role-7",
      agentId: "agent-paid-7",
      workspacePath: ws,
      adapter,
      ...ROLE_RUN,
    });

    expect(result.status).toBe("failed");
    expect(alibaba.requests).toBeGreaterThan(0);
    expect(zai.requests).toBeGreaterThan(0);
  });

  it("reviewer independence — preferIndependentFromPoolId demotes the implementer's paid route", async () => {
    // qwen is cheapest and QUALIFIED — without the hint it wins. The implementer ran on
    // qwen's direct route, so the reviewer must prefer glm's independent pool instead.
    const alibaba = new ScriptedPaidUpstream("alibaba");
    const zai = new ScriptedPaidUpstream("zai");
    const paidAuto = paidService(
      [verdict("qwen3.8-flash", "REVIEWER", "QUALIFIED"), verdict("glm-5.3-flash", "REVIEWER", "QUALIFIED")],
      { alibaba, zai },
    );
    const adapter = createWorkspaceEventAdapter({ sessionId: "sess-paid-role", eventStore, persistence });

    const result = await runtime(paidAuto).executeAgentRun({
      runId: "run-paid-role-8",
      agentId: "agent-paid-8",
      role: "reviewer",
      goal: "Review the diff",
      workspaceId: "ws-paid-role",
      workspacePath: ws,
      permissions: { read: true, search: true, write: false, executeCommand: false, network: false },
      modelSelection: { providerId: PAID_AUTO_PROVIDER_ID, modelId: PAID_AUTO_AUTO_MODEL_ID },
      roleRouting: true,
      preferIndependentFromPoolId: "qwen3.8-flash:direct",
      adapter,
    });

    expect(result.status).toBe("completed");
    expect(zai.requests).toBeGreaterThan(0);
    expect(alibaba.requests).toBe(0);
    const selection = eventStore.getAll().find((event) => event.type === "router.selection");
    expect(selection?.payload).toMatchObject({ providerId: PAID_AUTO_PROVIDER_ID, modelId: "glm-5.3-flash" });
    expect((selection?.payload as { reasons?: string[] }).reasons).toContain("INDEPENDENT_POOL_PREFERRED");
    // The same-pool candidate stayed reachable (demoted, not excluded) and says so.
    expect(result.routePoolId).toBe("glm-5.3-flash:direct");
  });

  it("same-pool fallback — when the only executable route is the implementer's, it serves with SAME_POOL evidence", async () => {
    const alibaba = new ScriptedPaidUpstream("alibaba");
    // Only qwen's direct route is READY — every other candidate is unqualified-for-exec,
    // so the demoted same-pool route is the only thing that can serve.
    const routes = Object.fromEntries(PAID_AUTO_MODELS.flatMap((model) => [model.direct, model.fallback]).map((route) => [route.routeId, {
      state: "NOT_CONFIGURED" as const,
      commercialEligibility: "verified" as const,
      privacy: "verified" as const,
      capabilityParity: "verified" as const,
      certification: "CERTIFIED" as const,
    }])) as Partial<Record<PaidAutoRouteId, { state: "NOT_CONFIGURED"; commercialEligibility: "verified"; privacy: "verified"; capabilityParity: "verified"; certification: "CERTIFIED" }>>;
    routes["qwen3.8-flash:direct"] = { state: "READY", commercialEligibility: "verified", privacy: "verified", capabilityParity: "verified", certification: "CERTIFIED" };
    const paidAuto = new PaidAutoService({
      credentialStore: credentials,
      paidExecutionEnabled: true,
      openRouterFallbackEnabled: true,
      routeQualifications: routes,
      roleVerdicts: [verdict("qwen3.8-flash", "REVIEWER", "QUALIFIED")],
      adapters: { alibaba },
    });
    const adapter = createWorkspaceEventAdapter({ sessionId: "sess-paid-role", eventStore, persistence });

    const result = await runtime(paidAuto).executeAgentRun({
      runId: "run-paid-role-9",
      agentId: "agent-paid-9",
      role: "reviewer",
      goal: "Review the diff",
      workspaceId: "ws-paid-role",
      workspacePath: ws,
      permissions: { read: true, search: true, write: false, executeCommand: false, network: false },
      modelSelection: { providerId: PAID_AUTO_PROVIDER_ID, modelId: PAID_AUTO_AUTO_MODEL_ID },
      roleRouting: true,
      preferIndependentFromPoolId: "qwen3.8-flash:direct",
      adapter,
    });

    expect(result.status).toBe("completed");
    expect(alibaba.requests).toBeGreaterThan(0);
    const selection = eventStore.getAll().find((event) => event.type === "router.selection");
    expect((selection?.payload as { reasons?: string[] }).reasons).toContain("SAME_POOL_FALLBACK");
  });

  it("paid-auto/auto without a Paid Auto service fails closed instead of guessing", async () => {
    const adapter = createWorkspaceEventAdapter({ sessionId: "sess-paid-role", eventStore, persistence });
    const result = await runtime(undefined).executeAgentRun({
      runId: "run-paid-role-4",
      agentId: "agent-paid-4",
      workspacePath: ws,
      adapter,
      ...ROLE_RUN,
    });

    expect(result.status).toBe("failed");
    expect(result.summary).toContain("PROVIDER_UNAVAILABLE");
  });
});

/** A scripted paid upstream that reports provider usage for OBSERVED settlement. */
class MeteredPaidUpstream extends ScriptedPaidUpstream {
  override async *streamChat(_req: ChatRequest): AsyncIterable<StreamEvent> {
    this.requests++;
    yield { type: "text_delta", delta: "Task completed." };
    yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
    yield { type: "finish", finishReason: "stop" };
  }
}

function managedPolicy(overrides: Partial<ManagedPaidPolicy> = {}): ManagedPaidPolicy {
  return {
    ownerUserId: "alice",
    entitlement: "PAID",
    costMode: "BALANCED",
    includedAllowanceUsd: 10,
    overageEnabled: false,
    hardMaximumUsd: 20,
    userOwnedAllowed: false,
    paidLeadAllowed: false,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("R55 wave 2 — managed-paid allowance accounting in executeAgentRun", () => {
  let ws: string;
  let eventStore: EventStore;
  let persistence: ReturnType<typeof createSessionPersistence>;

  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), "cf-paid-accounting-"));
    eventStore = new EventStore();
    persistence = createSessionPersistence({ dbPath: ":memory:" });
    persistence.upsertSession({
      id: "sess-paid-role",
      title: "Paid Role Routing Test Session",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "idle",
    });
  });

  afterEach(async () => {
    persistence.close();
    await rm(ws, { recursive: true, force: true });
  });

  function accountedRuntime(paidAuto: PaidAutoService | undefined, policy: ManagedPaidPolicy) {
    const catalog = new InMemoryProviderCatalog();
    if (paidAuto) catalog.register(paidAuto.asProviderAdapter());
    return createAgentRuntime({
      sessionId: "sess-paid-role",
      eventStore,
      persistence,
      firewall: new ForgeZero(),
      providerCatalog: catalog,
      workspacePath: ws,
      paidAuto,
      managedPaidPolicy: policy,
      managedPaidLedger: new ManagedPaidAllowanceLedger(persistence),
      userId: "alice",
    });
  }

  const PAID_ALLOWANCE = { freeRoutes: [], paidModelIds: ["qwen3.8-flash", "glm-5.3-flash"], userRoutes: [] };

  it("settles the attempt OBSERVED from provider-reported usage and reports it as managedSpendUsd", async () => {
    const alibaba = new MeteredPaidUpstream("alibaba");
    const paidAuto = paidService([verdict("qwen3.8-flash", "CODER", "QUALIFIED"), verdict("glm-5.3-flash", "CODER", "QUALIFIED")], { alibaba });
    const adapter = createWorkspaceEventAdapter({ sessionId: "sess-paid-role", eventStore, persistence });
    const rt = accountedRuntime(paidAuto, managedPolicy());
    await rt.init();

    const result = await rt.executeAgentRun({
      runId: "run-paid-observed", agentId: "agent-paid-obs", workspacePath: ws,
      rosterAllowance: PAID_ALLOWANCE, userId: "alice",
      ...ROLE_RUN, adapter,
    });
    expect(result.status).toBe("completed");
    expect(alibaba.requests).toBeGreaterThan(0);

    const receipts = await persistence.getWorkItemsByKind("managed_paid_receipt");
    expect(receipts).toHaveLength(1);
    // 10 in × $0.113/M + 5 out × $0.382/M = $0.00000304 → 3 integer USD micros charged.
    const receipt = (receipts[0] as unknown as { receipt: { chargedUsdMicros: number; confidence: string; actualUsdMicros: number | null; ownerUserId: string } }).receipt;
    expect(receipt.confidence).toBe("OBSERVED");
    expect(receipt.actualUsdMicros).toBe(3);
    expect(receipt.chargedUsdMicros).toBe(3);
    expect(receipt.ownerUserId).toBe("alice");

    const shillings = await persistence.getWorkItemsByKind("shilling_entry");
    const entry = (shillings[0] as unknown as { entry: { sourceClass: string; managedSpendUsd: number | null; userProviderSpendUsd: number | null; costConfidence: string } }).entry;
    expect(entry.sourceClass).toBe("MANAGED_PAID");
    expect(entry.managedSpendUsd).toBe(receipt.chargedUsdMicros / 1e6);
    expect(entry.userProviderSpendUsd).toBeNull();
    expect(entry.costConfidence).toBe("OBSERVED");
  });

  it("settles the reserved estimate as ESTIMATED when the provider reports no usage", async () => {
    const alibaba = new ScriptedPaidUpstream("alibaba");
    const paidAuto = paidService([verdict("qwen3.8-flash", "CODER", "QUALIFIED")], { alibaba });
    const rt = accountedRuntime(paidAuto, managedPolicy());
    await rt.init();
    const result = await rt.executeAgentRun({
      runId: "run-paid-estimated", agentId: "agent-paid-est", workspacePath: ws,
      rosterAllowance: { freeRoutes: [], paidModelIds: ["qwen3.8-flash"], userRoutes: [] }, userId: "alice",
      ...ROLE_RUN,
    });
    expect(result.status).toBe("completed");
    const receipts = await persistence.getWorkItemsByKind("managed_paid_receipt");
    expect(receipts).toHaveLength(1);
    const receipt = (receipts[0] as unknown as { receipt: { chargedUsdMicros: number; confidence: string; actualUsdMicros: number | null; estimatedUsdMicros: number } }).receipt;
    expect(receipt.confidence).toBe("ESTIMATED");
    expect(receipt.actualUsdMicros).toBeNull();
    expect(receipt.chargedUsdMicros).toBe(receipt.estimatedUsdMicros);
    expect(receipt.chargedUsdMicros).toBeGreaterThan(0);
    const entry = ((await persistence.getWorkItemsByKind("shilling_entry"))[0] as unknown as { entry: { managedSpendUsd: number | null; costConfidence: string } }).entry;
    expect(entry.managedSpendUsd).toBe(receipt.chargedUsdMicros / 1e6);
    expect(entry.costConfidence).toBe("ESTIMATED");
  });

  it("fails before the wire on a stale/UNKNOWN route price — MANAGED_PAID_COST_UNKNOWN", async () => {
    // deepseek's direct route has pricing.status UNKNOWN in the registry — an attempt at
    // it can never be priced, so it must refuse before touching the upstream.
    const deepseek = new ScriptedPaidUpstream("deepseek");
    const paidAuto = paidService([verdict("deepseek-v4.1-flash", "CODER", "QUALIFIED")], { deepseek });
    const rt = accountedRuntime(paidAuto, managedPolicy());
    await rt.init();
    const result = await rt.executeAgentRun({
      runId: "run-paid-unpriced", agentId: "agent-paid-unpriced", workspacePath: ws,
      rosterAllowance: { freeRoutes: [], paidModelIds: ["deepseek-v4.1-flash"], userRoutes: [] }, userId: "alice",
      ...ROLE_RUN,
    });
    expect(result.status).toBe("failed");
    expect(deepseek.requests).toBe(0);
    expect(await persistence.getWorkItemsByKind("managed_paid_receipt")).toHaveLength(0);
  });

  it("fails a paid-only role before the wire when the hard maximum is exhausted", async () => {
    const alibaba = new ScriptedPaidUpstream("alibaba");
    const paidAuto = paidService([verdict("qwen3.8-flash", "CODER", "QUALIFIED")], { alibaba });
    const rt = accountedRuntime(paidAuto, managedPolicy({ hardMaximumUsd: 0.000001, includedAllowanceUsd: 0.000001 }));
    await rt.init();
    const result = await rt.executeAgentRun({
      runId: "run-paid-exhausted", agentId: "agent-paid-exhausted", workspacePath: ws,
      rosterAllowance: { freeRoutes: [], paidModelIds: ["qwen3.8-flash"], userRoutes: [] }, userId: "alice",
      ...ROLE_RUN,
    });
    expect(result.status).toBe("failed");
    expect(alibaba.requests).toBe(0);
    // The refusal is atomic — a rejected reserve never lands a durable reservation row.
    const reservations = await persistence.getWorkItemsByKind("managed_paid_reservation");
    expect(reservations).toHaveLength(0);
  });

  it("a roster-admitted free route serves without touching the paid ledger", async () => {
    const free = new ScriptedPaidUpstream("free-test");
    const alibaba = new ScriptedPaidUpstream("alibaba");
    const paidAuto = paidService([verdict("qwen3.8-flash", "CODER", "QUALIFIED")], { alibaba });
    const catalog = new InMemoryProviderCatalog();
    catalog.register(free);
    catalog.register(paidAuto.asProviderAdapter());
    const firewall = new ForgeZero();
    firewall.register(createGenericFreeRecord({ providerId: "free-test", modelId: "upstream", displayName: "free-test upstream" }));
    const rt = createAgentRuntime({
      sessionId: "sess-paid-role", eventStore, persistence, firewall,
      providerCatalog: catalog, workspacePath: ws, paidAuto,
      managedPaidPolicy: managedPolicy(), managedPaidLedger: new ManagedPaidAllowanceLedger(persistence),
      userId: "alice",
    });
    await rt.init();
    const result = await rt.executeAgentRun({
      runId: "run-free-selected", agentId: "agent-free-selected", workspacePath: ws,
      modelSelection: { providerId: "free-test", modelId: "upstream" },
      rosterAllowance: { freeRoutes: [{ providerId: "free-test", modelId: "upstream" }], paidModelIds: ["qwen3.8-flash"], userRoutes: [] },
      roleRouting: true, userId: "alice",
      role: "coder", goal: "Do the thing", workspaceId: "ws-paid-role",
      permissions: { read: true, search: true, write: false, executeCommand: false, network: false },
    });
    expect(result.status).toBe("completed");
    expect(free.requests).toBeGreaterThan(0);
    expect(alibaba.requests).toBe(0);
    expect(await persistence.getWorkItemsByKind("managed_paid_reservation")).toHaveLength(0);
    expect(await persistence.getWorkItemsByKind("managed_paid_receipt")).toHaveLength(0);
  });

  it("fails closed with MANAGED_PAID_ACCOUNTING_FAILED when settle fails after a served response — no retry, no failover", async () => {
    const alibaba = new ScriptedPaidUpstream("alibaba");
    const zai = new ScriptedPaidUpstream("zai");
    const paidAuto = paidService([verdict("qwen3.8-flash", "CODER", "QUALIFIED"), verdict("glm-5.3-flash", "CODER", "QUALIFIED")], { alibaba, zai });
    // A ledger whose settle write dies mid-commit: the provider already served, so the
    // run must stop with the accounting identity — rotating would double-bill inference.
    class FailingSettleLedger extends ManagedPaidAllowanceLedger {
      override async settle(): Promise<never> {
        throw new Error("simulated receipt write failure");
      }
    }
    const catalog = new InMemoryProviderCatalog();
    catalog.register(paidAuto.asProviderAdapter());
    const rt = createAgentRuntime({
      sessionId: "sess-paid-role", eventStore, persistence, firewall: new ForgeZero(),
      providerCatalog: catalog, workspacePath: ws, paidAuto,
      managedPaidPolicy: managedPolicy(), managedPaidLedger: new FailingSettleLedger(persistence),
      userId: "alice",
    });
    await rt.init();
    const result = await rt.executeAgentRun({
      runId: "run-paid-settle-fail", agentId: "agent-paid-settle-fail", workspacePath: ws,
      rosterAllowance: { freeRoutes: [], paidModelIds: ["qwen3.8-flash", "glm-5.3-flash"], userRoutes: [] }, userId: "alice",
      ...ROLE_RUN,
    });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("MANAGED_PAID_ACCOUNTING_FAILED");
    // Exactly one provider call happened — no duplicate inference for a ledger failure.
    expect(alibaba.requests).toBe(1);
    expect(zai.requests).toBe(0);
    // The reservation survives OPEN for reconciliation; no receipt was written.
    const reservations = await persistence.getWorkItemsByKind("managed_paid_reservation");
    expect(reservations).toHaveLength(1);
    expect((reservations[0] as unknown as { reservation: { status: string } }).reservation.status).toBe("OPEN");
    expect(await persistence.getWorkItemsByKind("managed_paid_receipt")).toHaveLength(0);
  });

  it("records every charged paid attempt — an estimated failover loss plus an observed success", async () => {
    const alibaba = new ScriptedPaidUpstream("alibaba", "rate_limit");
    const openrouter = new ScriptedPaidUpstream("openrouter", "rate_limit");
    const zai = new MeteredPaidUpstream("zai");
    const paidAuto = paidService(
      [verdict("qwen3.8-flash", "CODER", "QUALIFIED"), verdict("glm-5.3-flash", "CODER", "QUALIFIED")],
      { alibaba, openrouter, zai },
    );
    const rt = accountedRuntime(paidAuto, managedPolicy());
    await rt.init();
    const result = await rt.executeAgentRun({
      runId: "run-paid-failover-charges", agentId: "agent-paid-failover-charges", workspacePath: ws,
      rosterAllowance: { freeRoutes: [], paidModelIds: ["qwen3.8-flash", "glm-5.3-flash"], userRoutes: [] }, userId: "alice",
      ...ROLE_RUN,
    });
    expect(result.status).toBe("completed");
    expect(zai.requests).toBeGreaterThan(0);
    const entries = (await persistence.getWorkItemsByKind("shilling_entry"))
      .map((item) => (item as unknown as { entry: ShillingEntry }).entry)
      .filter((entry) => entry.taskId === "run-paid-failover-charges");
    // One ESTIMATED charge for the dead qwen attempt (raw usage null — the provider never
    // reported) plus one OBSERVED charge for the serving glm attempt — two attempts, two
    // entries, no turn-level duplicate.
    expect(entries).toHaveLength(2);
    const estimated = entries.find((entry) => entry.costConfidence === "ESTIMATED")!;
    const observed = entries.find((entry) => entry.costConfidence === "OBSERVED")!;
    expect(estimated.sourceClass).toBe("MANAGED_PAID");
    expect(estimated.providerId).toBe("alibaba");
    expect(estimated.rawUsage).toBeNull();
    expect(estimated.managedSpendUsd).not.toBeNull();
    expect(observed.sourceClass).toBe("MANAGED_PAID");
    expect(observed.providerId).toBe("zai");
    expect(observed.rawUsage).toBe(15);
    // glm: 10 in × $0.15/M + 5 out × $0.50/M = $0.000004 → 4 integer micros.
    expect(observed.managedSpendUsd).toBe(0.000004);
    // Task totals reflect both attempts; Sh stays null — no defensible conversion evidence.
    const summary = summarizeShillings("run-paid-failover-charges", entries);
    expect(summary.requestCount).toBe(2);
    expect(summary.managedSpendUsd).toBeCloseTo((estimated.managedSpendUsd ?? 0) + (observed.managedSpendUsd ?? 0), 9);
    expect(summary.shConsumed).toBeNull();
    expect(summary.bySourceClass.MANAGED_PAID).toBeNull();
    // Replay is idempotent: re-recording the same entries duplicates nothing.
    const ledger = new ShillingLedger(persistence);
    for (const entry of entries) expect(await ledger.record(entry)).toBe(false);
    expect(await persistence.getWorkItemsByKind("shilling_entry")).toHaveLength(2);
  });

  it("stamps exact canonical identity on paid decision receipts — successor selection and economy pin", async () => {
    const alibaba = new MeteredPaidUpstream("alibaba");
    const paidAuto = paidService([verdict("qwen3.8-flash", "CODER", "QUALIFIED")], { alibaba });
    const rt = accountedRuntime(paidAuto, managedPolicy());
    await rt.init();
    const decisionCandidates = [
      { modelId: "qwen3.8-flash", providerId: "alibaba", providerModelId: "qwen3.8-flash", familyId: "qwen", version: "3.8", sourceClass: "MANAGED_PAID" as const, lifecycle: "ACTIVE" as const },
      { modelId: "gpt-5.6-luna", providerId: "openai", providerModelId: "gpt-5.6-luna", familyId: "luna", version: "5.6", sourceClass: "MANAGED_PAID" as const, lifecycle: "ACTIVE_ECONOMY" as const },
    ];
    const decision = { ownerUserId: "alice", rosterUpdatedAt: "2026-10-01T00:00:00.000Z", role: "CODER" as const, candidates: decisionCandidates };
    const result = await rt.executeAgentRun({
      runId: "run-paid-receipt-successor", agentId: "agent-paid-receipt-succ", workspacePath: ws,
      rosterAllowance: { freeRoutes: [], paidModelIds: ["qwen3.8-flash"], userRoutes: [], decision }, userId: "alice",
      ...ROLE_RUN,
    });
    expect(result.status).toBe("completed");
    const receipts = (await persistence.getWorkItemsByKind("forgeauto_decision_receipt"))
      .map((item) => (item as unknown as { decision: { selected: Record<string, unknown>; unmatchedSelected?: boolean; reasonCodes: string[] } }).decision);
    expect(receipts.length).toBeGreaterThan(0);
    // The selected value is the allowed candidate itself — canonical id, family, exact
    // version, sourceClass, lifecycle — not the bare provider/model pair.
    expect(receipts[0]!.selected).toMatchObject({ modelId: "qwen3.8-flash", providerId: "alibaba", familyId: "qwen", version: "3.8", sourceClass: "MANAGED_PAID", lifecycle: "ACTIVE" });
    expect(receipts[0]!.unmatchedSelected).toBeUndefined();

    // An explicit pin on the economy predecessor names that exact version on its receipt.
    const openai = new MeteredPaidUpstream("openai");
    const paidPin = paidService([verdict("gpt-5.6-luna", "CODER", "QUALIFIED")], { openai });
    const catalog = new InMemoryProviderCatalog();
    catalog.register(paidPin.asProviderAdapter());
    const pinnedRt = createAgentRuntime({
      sessionId: "sess-paid-role", eventStore, persistence, firewall: new ForgeZero(),
      providerCatalog: catalog, workspacePath: ws, paidAuto: paidPin,
      managedPaidPolicy: managedPolicy(), managedPaidLedger: new ManagedPaidAllowanceLedger(persistence),
      userId: "alice",
    });
    await pinnedRt.init();
    const pinned = await pinnedRt.executeAgentRun({
      runId: "run-paid-receipt-pin", agentId: "agent-paid-receipt-pin", workspacePath: ws,
      modelSelection: { providerId: "paid-auto", modelId: "gpt-5.6-luna" },
      rosterAllowance: { freeRoutes: [], paidModelIds: ["gpt-5.6-luna"], userRoutes: [], decision: { ...decision, candidates: [decisionCandidates[1]!] } }, userId: "alice",
      role: "coder", goal: "Do the thing", workspaceId: "ws-paid-role",
      permissions: { read: true, search: true, write: false, executeCommand: false, network: false },
    });
    expect(pinned.status).toBe("completed");
    const pinReceipts = (await persistence.getWorkItemsByKind("forgeauto_decision_receipt"))
      .map((item) => (item as unknown as { decision: { runId: string; selected: Record<string, unknown>; unmatchedSelected?: boolean } }).decision)
      .filter((d) => d.runId === "run-paid-receipt-pin");
    expect(pinReceipts.length).toBeGreaterThan(0);
    expect(pinReceipts[0]!.selected).toMatchObject({ modelId: "gpt-5.6-luna", familyId: "luna", version: "5.6", lifecycle: "ACTIVE_ECONOMY" });
    expect(pinReceipts[0]!.unmatchedSelected).toBeUndefined();
  });

  it("every cost mode keeps the paid selection inside the roster allowance", async () => {
    for (const costMode of ["CHEAPEST", "BALANCED", "MAXIMUM_INTELLIGENCE", "CUSTOM"] as const) {
      const alibaba = new ScriptedPaidUpstream("alibaba");
      const zai = new ScriptedPaidUpstream("zai");
      const paidAuto = paidService([verdict("qwen3.8-flash", "CODER", "QUALIFIED"), verdict("glm-5.3-flash", "CODER", "QUALIFIED")], { alibaba, zai });
      const rt = accountedRuntime(paidAuto, managedPolicy({ costMode }));
      await rt.init();
      // Roster admits only glm — no cost mode may reach qwen regardless of ordering.
      const result = await rt.executeAgentRun({
        runId: `run-paid-mode-${costMode.toLowerCase()}`, agentId: `agent-mode-${costMode.toLowerCase()}`, workspacePath: ws,
        rosterAllowance: { freeRoutes: [], paidModelIds: ["glm-5.3-flash"], userRoutes: [] }, userId: "alice",
        ...ROLE_RUN,
      });
      expect(result.status).toBe("completed");
      expect(zai.requests).toBeGreaterThan(0);
      expect(alibaba.requests).toBe(0);
    }
  });
});
