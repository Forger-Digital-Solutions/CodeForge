import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ForgeZero } from "@codeforge/forge-zero";
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
    private readonly behavior: "serve" | "rate_limit" = "serve",
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
