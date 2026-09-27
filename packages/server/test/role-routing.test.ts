import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ForgeZero, createGenericFreeRecord, type FreeModelRecord } from "@codeforge/forge-zero";
import {
  type ProviderAdapter,
  type ProviderModel,
  type ChatRequest,
  type ChatResponse,
  type StreamEvent,
  InMemoryProviderCatalog,
} from "@codeforge/providers";
import { EventStore, createSessionPersistence } from "@codeforge/sessions";
import { createEightBitRuntime, type ModelQualificationReceipt, type RoleQualificationResult } from "@codeforge/eight-bit";
import type { FreeCloudRoutingHooks } from "@codeforge/model-registry";
import { createAgentRuntime, eightBitRoleForAgentRole } from "../src/agent-runtime.js";
import { createSubagentManager } from "../src/subagent-manager.js";
import { createWorkspaceEventAdapter } from "../src/workspace-event-adapter.js";

class ScriptedFleetProvider implements ProviderAdapter {
  readonly providerId: string;
  readonly isTestProvider = true;
  /** When true, every model request fails with a provider rate-limit error. */
  failWithRateLimit = false;
  requests = 0;

  constructor(providerId: string) {
    this.providerId = providerId;
  }

  async listModels(): Promise<ProviderModel[]> {
    return [{
      modelId: "default",
      displayName: "Scripted Fleet Model",
      isFree: true,
      freeStatus: "verified_free",
      capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true },
    }];
  }

  async chat(_req: ChatRequest): Promise<ChatResponse> {
    throw new Error("Use streamChat");
  }

  async *streamChat(req: ChatRequest): AsyncIterable<StreamEvent> {
    this.requests++;
    if (this.failWithRateLimit) {
      yield { type: "error", message: "429 rate limit exceeded, retry later", retryable: true };
      return;
    }
    const systemPrompt = req.messages.find((message) => message.role === "system")?.content ?? "";
    if (systemPrompt.includes("CodeForge Explorer")) {
      yield { type: "text_delta", delta: JSON.stringify({ summary: "Mapped the fixture workspace.", findings: [], evidence: [] }) };
      yield { type: "finish", finishReason: "stop" };
      return;
    }
    if (systemPrompt.includes("CodeForge Reviewer")) {
      yield { type: "text_delta", delta: JSON.stringify({ verdict: "pass", findings: [], summary: "No issues found." }) };
      yield { type: "finish", finishReason: "stop" };
      return;
    }
    yield { type: "text_delta", delta: "Task completed." };
    yield { type: "finish", finishReason: "stop" };
  }

  async healthCheck() {
    return { status: "available" as const };
  }
}

function fleetRecord(providerId: string, modelId: string, overrides: Partial<FreeModelRecord> = {}): FreeModelRecord {
  return createGenericFreeRecord({
    providerId,
    modelId,
    displayName: `${providerId} ${modelId}`,
    ...overrides,
  });
}

describe("R1 role-aware SubAgent routing", () => {
  let ws: string;
  let eventStore: EventStore;
  let persistence: ReturnType<typeof createSessionPersistence>;
  let firewall: ForgeZero;

  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), "cf-role-routing-"));
    eventStore = new EventStore();
    persistence = createSessionPersistence({ dbPath: ":memory:" });
    firewall = new ForgeZero();
    persistence.upsertSession({
      id: "sess-role-routing",
      title: "Role Routing Test Session",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "idle",
    });
  });

  afterEach(async () => {
    persistence.close();
    await rm(ws, { recursive: true, force: true });
  });

  it("maps agent task roles onto 8-Bit role contracts", () => {
    expect(eightBitRoleForAgentRole("explorer")).toBe("EXPLORER");
    expect(eightBitRoleForAgentRole("planner")).toBe("PLANNER");
    expect(eightBitRoleForAgentRole("coder")).toBe("CODER");
    expect(eightBitRoleForAgentRole("reviewer")).toBe("REVIEWER");
    expect(eightBitRoleForAgentRole("anything-else")).toBe("CODER");
  });

  it("resolves an R1 worker's route through the fleet and records the served model on the worker record", async () => {
    firewall.register(fleetRecord("fleet-a", "model-a", { codingScore: 80 }));
    const catalog = new InMemoryProviderCatalog();
    const provider = new ScriptedFleetProvider("fleet-a");
    catalog.register(provider);
    const runtime = createAgentRuntime({
      sessionId: "sess-role-routing",
      eventStore,
      persistence,
      firewall,
      providerCatalog: catalog,
      workspacePath: ws,
    });
    const adapter = createWorkspaceEventAdapter({ sessionId: "sess-role-routing", eventStore, persistence });
    const manager = createSubagentManager({ persistence, agentRuntime: runtime, r1Enabled: true });

    const result = await manager.spawnChildAgent({
      parentRunId: "run-role-1",
      sessionId: "sess-role-routing",
      agentId: "explorer",
      task: "Map the fixture workspace",
      workspacePath: ws,
      structuredOutput: "explorer",
      adapter,
    });

    expect(result.status).toBe("completed");
    expect(provider.requests).toBeGreaterThan(0);
    const worker = (await persistence.getWorkItemsByKind("subagent_run")).find((item) => item.kind === "subagent_run");
    expect(worker?.model).toEqual({ providerId: "fleet-a", modelId: "model-a" });
    const selection = eventStore.getAll().find((event) => event.type === "router.selection");
    expect(selection).toBeDefined();
    expect(selection?.payload).toMatchObject({ providerId: "fleet-a", modelId: "model-a" });
  });

  it("fails closed when the fleet exists but no route satisfies the role contract", async () => {
    firewall.register(fleetRecord("fleet-a", "model-a", { capabilities: { text: true, coding: true, toolCalling: false, vision: false, structuredOutput: true, longContext: false } }));
    const catalog = new InMemoryProviderCatalog();
    catalog.register(new ScriptedFleetProvider("fleet-a"));
    const runtime = createAgentRuntime({
      sessionId: "sess-role-routing",
      eventStore,
      persistence,
      firewall,
      providerCatalog: catalog,
      workspacePath: ws,
    });
    const adapter = createWorkspaceEventAdapter({ sessionId: "sess-role-routing", eventStore, persistence });
    const manager = createSubagentManager({ persistence, agentRuntime: runtime, r1Enabled: true });

    const result = await manager.spawnChildAgent({
      parentRunId: "run-role-2",
      sessionId: "sess-role-routing",
      agentId: "explorer",
      task: "Map the fixture workspace",
      workspacePath: ws,
      structuredOutput: "explorer",
      adapter,
    });

    expect(result.status).toBe("failed");
    expect(result.summary).toContain("No eligible free route for role");
  });

  it("rotates a role-routed worker to another free provider after a rate limit and completes", async () => {
    firewall.register(fleetRecord("fleet-a", "model-a", { benchmarkProfile: { coding: 90, toolCalling: 90, reasoning: 90, longContext: 90, speed: 90 } }));
    firewall.register(fleetRecord("fleet-b", "model-b", { benchmarkProfile: { coding: 40, toolCalling: 40, reasoning: 40, longContext: 40, speed: 40 } }));
    const catalog = new InMemoryProviderCatalog();
    const providerA = new ScriptedFleetProvider("fleet-a");
    providerA.failWithRateLimit = true;
    const providerB = new ScriptedFleetProvider("fleet-b");
    catalog.register(providerA);
    catalog.register(providerB);
    const runtime = createAgentRuntime({
      sessionId: "sess-role-routing",
      eventStore,
      persistence,
      firewall,
      providerCatalog: catalog,
      workspacePath: ws,
    });
    const adapter = createWorkspaceEventAdapter({ sessionId: "sess-role-routing", eventStore, persistence });
    const manager = createSubagentManager({ persistence, agentRuntime: runtime, r1Enabled: true });

    const result = await manager.spawnChildAgent({
      parentRunId: "run-role-3",
      sessionId: "sess-role-routing",
      agentId: "explorer",
      task: "Map the fixture workspace",
      workspacePath: ws,
      structuredOutput: "explorer",
      adapter,
    });

    expect(result.status).toBe("completed");
    expect(providerA.requests).toBeGreaterThan(0);
    expect(providerB.requests).toBeGreaterThan(0);
    expect(eventStore.getAll().some((event) => event.type === "router.failover")).toBe(true);
    const worker = (await persistence.getWorkItemsByKind("subagent_run")).find((item) => item.kind === "subagent_run");
    expect(worker?.model).toEqual({ providerId: "fleet-b", modelId: "model-b" });
  });

  it("never substitutes an explicitly selected model when its provider fails", async () => {
    firewall.register(fleetRecord("fleet-a", "model-a"));
    firewall.register(fleetRecord("fleet-b", "model-b"));
    const catalog = new InMemoryProviderCatalog();
    const providerA = new ScriptedFleetProvider("fleet-a");
    providerA.failWithRateLimit = true;
    const providerB = new ScriptedFleetProvider("fleet-b");
    catalog.register(providerA);
    catalog.register(providerB);
    const runtime = createAgentRuntime({
      sessionId: "sess-role-routing",
      eventStore,
      persistence,
      firewall,
      providerCatalog: catalog,
      workspacePath: ws,
    });
    const adapter = createWorkspaceEventAdapter({ sessionId: "sess-role-routing", eventStore, persistence });

    const result = await runtime.executeAgentRun({
      runId: "run-exact-1",
      agentId: "agent-exact",
      role: "coder",
      goal: "Do the thing",
      workspaceId: "ws-exact",
      workspacePath: ws,
      permissions: { read: true, search: true, write: false, executeCommand: false, network: false },
      modelSelection: { providerId: "fleet-a", modelId: "model-a" },
      roleRouting: true,
      adapter,
    });

    expect(result.status).toBe("failed");
    expect(providerB.requests).toBe(0);
    expect(eventStore.getAll().some((event) => event.type === "router.failover")).toBe(false);
  });

  it("fails closed with PROVIDER_MODEL_UNAVAILABLE when no eligible free route exists (no 'default' model reach-through)", async () => {
    // RC2 §14: the former catalog fallback (`modelId: "default"`) could reach a provider with an
    // invalid model. With no fleet route and no firewall-eligible free model, the run must fail
    // truthfully instead of blindly routing.
    const catalog = new InMemoryProviderCatalog();
    const provider = new ScriptedFleetProvider("scripted-only");
    catalog.register(provider);
    const runtime = createAgentRuntime({
      sessionId: "sess-role-routing",
      eventStore,
      persistence,
      firewall,
      providerCatalog: catalog,
      workspacePath: ws,
    });
    const adapter = createWorkspaceEventAdapter({ sessionId: "sess-role-routing", eventStore, persistence });
    const manager = createSubagentManager({ persistence, agentRuntime: runtime, r1Enabled: true });

    const result = await manager.spawnChildAgent({
      parentRunId: "run-role-4",
      sessionId: "sess-role-routing",
      agentId: "explorer",
      task: "Map the fixture workspace",
      workspacePath: ws,
      structuredOutput: "explorer",
      adapter,
    });

    expect(result.status).toBe("failed");
    expect(provider.requests).toBe(0);
    expect(result.summary).toContain("PROVIDER_MODEL_UNAVAILABLE");
  });

  it("keeps the legacy deterministic fallback when a firewall-eligible free route exists", async () => {
    const catalog = new InMemoryProviderCatalog();
    const provider = new ScriptedFleetProvider("scripted-only");
    catalog.register(provider);
    firewall.register(fleetRecord("scripted-only", "model-a"));
    const runtime = createAgentRuntime({
      sessionId: "sess-role-routing",
      eventStore,
      persistence,
      firewall,
      providerCatalog: catalog,
      workspacePath: ws,
    });
    const adapter = createWorkspaceEventAdapter({ sessionId: "sess-role-routing", eventStore, persistence });
    const manager = createSubagentManager({ persistence, agentRuntime: runtime, r1Enabled: true });

    const result = await manager.spawnChildAgent({
      parentRunId: "run-role-4b",
      sessionId: "sess-role-routing",
      agentId: "explorer",
      task: "Map the fixture workspace",
      workspacePath: ws,
      structuredOutput: "explorer",
      adapter,
    });

    expect(result.status).toBe("completed");
    expect(provider.requests).toBeGreaterThan(0);
  });

  it("keeps default behavior unchanged when role routing is not requested", async () => {
    firewall.register(fleetRecord("fleet-a", "model-a"));
    const catalog = new InMemoryProviderCatalog();
    catalog.register(new ScriptedFleetProvider("fleet-a"));
    const runtime = createAgentRuntime({
      sessionId: "sess-role-routing",
      eventStore,
      persistence,
      firewall,
      providerCatalog: catalog,
      workspacePath: ws,
    });
    const adapter = createWorkspaceEventAdapter({ sessionId: "sess-role-routing", eventStore, persistence });
    const manager = createSubagentManager({ persistence, agentRuntime: runtime });

    const result = await manager.spawnChildAgent({
      parentRunId: "run-role-5",
      sessionId: "sess-role-routing",
      agentId: "explorer",
      task: "Map the fixture workspace",
      workspacePath: ws,
      structuredOutput: "explorer",
      adapter,
    });

    expect(result.status).toBe("completed");
    expect(eventStore.getAll().some((event) => event.type === "router.selection")).toBe(false);
  });
});

/**
 * R41: production role-quality wiring — the AgentRuntime reads each candidate's persisted
 * qualification receipt through the optional FreeCloudRoutingHooks.getQualificationReceipt
 * and feeds the certified roleQualityAdvice into both initial selection and the failover
 * re-decide. No receipt (or no hook) contributes a zero adjustment; nothing here re-runs
 * or re-scores the evidence.
 */
function roleResult(status: RoleQualificationResult["status"], passed: boolean[], role: RoleQualificationResult["role"]): RoleQualificationResult {
  const at = new Date().toISOString();
  return {
    role,
    status,
    testCases: passed.map((p, i) => ({ caseId: `c${i}`, category: "reasoning", passed: p, hardFailure: false, latencyMs: 10, retries: 0 })),
    hardFailures: [],
    startedAt: at,
    completedAt: at,
  };
}

function receipt(providerId: string, modelId: string, roleResults: Partial<Record<string, RoleQualificationResult>>): ModelQualificationReceipt {
  const at = new Date().toISOString();
  return {
    suiteVersion: "R10_FREE_QUALIFICATION_V1",
    providerId,
    modelId,
    modelDisplayName: modelId,
    accessClass: "FREE_ROUTED",
    freeStatus: "verified_free",
    roleResults: roleResults as ModelQualificationReceipt["roleResults"],
    startedAt: at,
    completedAt: at,
    totalLatencyMs: 100,
    qualificationState: "QUALIFIED",
    hardFailureRoles: [],
  };
}

function freeCloudHooks(
  receipts: Map<string, ModelQualificationReceipt>,
  capacityAdvice: (providerId: string, modelId: string) => { scoreAdjustment: number; reasonCodes: string[] } = () => ({ scoreAdjustment: 0, reasonCodes: ["CAPACITY_UNOBSERVED"] }),
): FreeCloudRoutingHooks {
  return {
    isForgeAutoEligible: () => true,
    canonicalIdOf: (providerId, modelId) => `${providerId}/${modelId}`,
    sameModelAlternates: () => [],
    recordRouteFailure: () => undefined,
    recordRouteSuccess: () => undefined,
    quotaRemaining: () => undefined,
    capacityRoutingAdvice: capacityAdvice,
    getQualificationReceipt: (providerId, modelId) => receipts.get(`${providerId}::${modelId}`),
  };
}

describe("R41 role-quality routing wiring", () => {
  let ws: string;
  let eventStore: EventStore;
  let persistence: ReturnType<typeof createSessionPersistence>;

  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), "cf-roleq-routing-"));
    eventStore = new EventStore();
    persistence = createSessionPersistence({ dbPath: ":memory:" });
  });

  afterEach(async () => {
    persistence.close();
    await rm(ws, { recursive: true, force: true });
  });

  it("a fresher multi-case qualified REVIEWER route wins the run over an equally eligible weaker one", async () => {
    const firewall = new ForgeZero();
    // Identical capability profiles → identical global scores; the modelId tiebreak alone
    // would pick aaa-weak. Only the role evidence can reorder this pair.
    firewall.register(fleetRecord("fleet-a", "aaa-weak"));
    firewall.register(fleetRecord("fleet-b", "zzz-qualified"));
    const catalog = new InMemoryProviderCatalog();
    const providerA = new ScriptedFleetProvider("fleet-a");
    const providerB = new ScriptedFleetProvider("fleet-b");
    catalog.register(providerA);
    catalog.register(providerB);
    const receipts = new Map<string, ModelQualificationReceipt>([
      ["fleet-a::aaa-weak", receipt("fleet-a", "aaa-weak", { REVIEWER: roleResult("NOT_QUALIFIED", [false, false, false, false], "REVIEWER") })],
      ["fleet-b::zzz-qualified", receipt("fleet-b", "zzz-qualified", { REVIEWER: roleResult("QUALIFIED", [true, true, true, true], "REVIEWER") })],
    ]);
    const eightBit = createEightBitRuntime({ firewall, persistence });
    const selectSpy = vi.spyOn(eightBit, "selectInitialRoute");
    const runtime = createAgentRuntime({
      sessionId: "sess-roleq",
      eventStore,
      persistence,
      firewall,
      providerCatalog: catalog,
      workspacePath: ws,
      freeCloud: freeCloudHooks(receipts),
      eightBit,
    });

    const result = await runtime.executeAgentRun({
      runId: "run-roleq-1",
      agentId: "reviewer-roleq",
      role: "reviewer",
      goal: "Review the diff",
      workspaceId: "ws-roleq",
      workspacePath: ws,
      permissions: { read: true, search: true, write: false, executeCommand: false, network: false },
      structuredOutput: "reviewer",
      roleRouting: true,
    });

    expect(result.status).toBe("completed");
    // The production callback reached selection and carried the evidence: the qualified
    // route beat the alphabetically-first weaker peer, and served the run.
    expect(selectSpy).toHaveBeenCalledOnce();
    expect(typeof selectSpy.mock.calls[0]![1].roleQualityAdjustment).toBe("function");
    expect(typeof selectSpy.mock.calls[0]![1].roleQualificationTierFor).toBe("function");
    expect(selectSpy.mock.calls[0]![1].roleQualificationTierFor!("fleet-b", "zzz-qualified")).toBe("QUALIFIED");
    const advice = selectSpy.mock.calls[0]![1].roleQualityAdjustment!("fleet-b", "zzz-qualified");
    expect(advice.scoreAdjustment).toBeGreaterThan(0);
    expect(providerB.requests).toBeGreaterThan(0);
    expect(providerA.requests).toBe(0);
  });

  it("failover re-decision stays role-aware — the qualified free candidate wins the rotation", async () => {
    const firewall = new ForgeZero();
    // aaa-failed serves then dies on a 429; of the survivors, bbb-weak would win the
    // modelId tiebreak — role evidence must land the rotation on zzz-qualified.
    firewall.register(fleetRecord("fleet-a", "aaa-failed"));
    firewall.register(fleetRecord("fleet-b", "bbb-weak"));
    firewall.register(fleetRecord("fleet-c", "zzz-qualified"));
    const catalog = new InMemoryProviderCatalog();
    const providerA = new ScriptedFleetProvider("fleet-a");
    providerA.failWithRateLimit = true;
    const providerB = new ScriptedFleetProvider("fleet-b");
    const providerC = new ScriptedFleetProvider("fleet-c");
    catalog.register(providerA);
    catalog.register(providerB);
    catalog.register(providerC);
    const receipts = new Map<string, ModelQualificationReceipt>([
      // aaa-failed is equally qualified, so it wins the initial selection on the modelId
      // tiebreak — and is then excluded by its own 429 for the re-decide.
      ["fleet-a::aaa-failed", receipt("fleet-a", "aaa-failed", { REVIEWER: roleResult("QUALIFIED", [true, true, true, true], "REVIEWER") })],
      ["fleet-b::bbb-weak", receipt("fleet-b", "bbb-weak", { REVIEWER: roleResult("NOT_QUALIFIED", [false, false, false, false], "REVIEWER") })],
      ["fleet-c::zzz-qualified", receipt("fleet-c", "zzz-qualified", { REVIEWER: roleResult("QUALIFIED", [true, true, true, true], "REVIEWER") })],
    ]);
    const eightBit = createEightBitRuntime({ firewall, persistence });
    const failoverSpy = vi.spyOn(eightBit, "handleTurnFailure");
    const runtime = createAgentRuntime({
      sessionId: "sess-roleq-fo",
      eventStore,
      persistence,
      firewall,
      providerCatalog: catalog,
      workspacePath: ws,
      freeCloud: freeCloudHooks(receipts),
      eightBit,
    });

    const result = await runtime.executeAgentRun({
      runId: "run-roleq-fo",
      agentId: "reviewer-fo",
      role: "reviewer",
      goal: "Review the diff",
      workspaceId: "ws-roleq-fo",
      workspacePath: ws,
      permissions: { read: true, search: true, write: false, executeCommand: false, network: false },
      structuredOutput: "reviewer",
      roleRouting: true,
    });

    expect(result.status).toBe("completed");
    expect(providerA.requests).toBeGreaterThan(0);
    // aaa-failed is alphabetically first and was admitted initially (no receipt → zero);
    // after its 429 the role-aware re-decide must land on zzz-qualified, not bbb-weak.
    expect(failoverSpy).toHaveBeenCalledOnce();
    expect(typeof failoverSpy.mock.calls[0]![0].roleQualityAdjustment).toBe("function");
    expect(typeof failoverSpy.mock.calls[0]![0].roleQualificationTierFor).toBe("function");
    expect(providerB.requests).toBe(0);
    expect(providerC.requests).toBeGreaterThan(0);
  });

  it("a route whose current receipt rejects the role (NOT_QUALIFIED / HARD_FAILURE / another role's verdict) cannot be chosen over a QUALIFIED alternate", async () => {
    const firewall = new ForgeZero();
    // Every preferred route outranks the alternate on capability score — only the
    // per-role qualification gate can stop them.
    firewall.register(fleetRecord("fleet-a", "preferred-notq", { benchmarkProfile: { coding: 95, toolCalling: 95, reasoning: 95, longContext: 95, speed: 95 } }));
    firewall.register(fleetRecord("fleet-b", "preferred-hard", { benchmarkProfile: { coding: 90, toolCalling: 90, reasoning: 90, longContext: 90, speed: 90 } }));
    firewall.register(fleetRecord("fleet-c", "preferred-planner", { benchmarkProfile: { coding: 85, toolCalling: 85, reasoning: 85, longContext: 85, speed: 85 } }));
    firewall.register(fleetRecord("fleet-d", "zzz-alternate", { benchmarkProfile: { coding: 40, toolCalling: 40, reasoning: 40, longContext: 40, speed: 40 } }));
    const catalog = new InMemoryProviderCatalog();
    const providers = ["fleet-a", "fleet-b", "fleet-c", "fleet-d"].map((id) => new ScriptedFleetProvider(id));
    providers.forEach((provider) => catalog.register(provider));
    const receipts = new Map<string, ModelQualificationReceipt>([
      ["fleet-a::preferred-notq", receipt("fleet-a", "preferred-notq", { REVIEWER: roleResult("NOT_QUALIFIED", [false, false, false, false], "REVIEWER") })],
      ["fleet-b::preferred-hard", receipt("fleet-b", "preferred-hard", { REVIEWER: roleResult("HARD_FAILURE", [false], "REVIEWER") })],
      // A QUALIFIED CODER verdict never substitutes for an unmeasured REVIEWER role.
      ["fleet-c::preferred-planner", receipt("fleet-c", "preferred-planner", { CODER: roleResult("QUALIFIED", [true, true, true, true], "CODER") })],
      ["fleet-d::zzz-alternate", receipt("fleet-d", "zzz-alternate", { REVIEWER: roleResult("QUALIFIED", [true, true, true, true], "REVIEWER") })],
    ]);
    const runtime = createAgentRuntime({
      sessionId: "sess-roleq-gate",
      eventStore,
      persistence,
      firewall,
      providerCatalog: catalog,
      workspacePath: ws,
      freeCloud: freeCloudHooks(receipts),
      eightBit: createEightBitRuntime({ firewall, persistence }),
    });

    const result = await runtime.executeAgentRun({
      runId: "run-roleq-gate",
      agentId: "reviewer-gate",
      role: "reviewer",
      goal: "Review the diff",
      workspaceId: "ws-roleq-gate",
      workspacePath: ws,
      permissions: { read: true, search: true, write: false, executeCommand: false, network: false },
      structuredOutput: "reviewer",
      roleRouting: true,
    });

    expect(result.status).toBe("completed");
    expect(providers[0]!.requests).toBe(0);
    expect(providers[1]!.requests).toBe(0);
    expect(providers[2]!.requests).toBe(0);
    expect(providers[3]!.requests).toBeGreaterThan(0);
    const selection = eventStore.getAll().find((event) => event.type === "router.selection");
    expect(selection?.payload).toMatchObject({ providerId: "fleet-d", modelId: "zzz-alternate" });
  });

  it("EXPLORER falls back to a legacy TOOL_AGENT verdict when no EXPLORER result exists; other roles never substitute", async () => {
    const firewall = new ForgeZero();
    firewall.register(fleetRecord("fleet-a", "tool-agent-legacy"));
    firewall.register(fleetRecord("fleet-b", "explorer-failed"));
    firewall.register(fleetRecord("fleet-c", "planner-only"));
    const catalog = new InMemoryProviderCatalog();
    const providerA = new ScriptedFleetProvider("fleet-a");
    const providerB = new ScriptedFleetProvider("fleet-b");
    const providerC = new ScriptedFleetProvider("fleet-c");
    catalog.register(providerA);
    catalog.register(providerB);
    catalog.register(providerC);
    const receipts = new Map<string, ModelQualificationReceipt>([
      // Pre-EXPLORER receipt: only the legacy TOOL_AGENT verdict exists → serves as fallback.
      ["fleet-a::tool-agent-legacy", receipt("fleet-a", "tool-agent-legacy", { TOOL_AGENT: roleResult("QUALIFIED", [true, true, true, true], "TOOL_AGENT") })],
      ["fleet-b::explorer-failed", receipt("fleet-b", "explorer-failed", { EXPLORER: roleResult("NOT_QUALIFIED", [false, false], "EXPLORER") })],
      ["fleet-c::planner-only", receipt("fleet-c", "planner-only", { PLANNER: roleResult("QUALIFIED", [true, true, true, true], "PLANNER") })],
    ]);
    const runtime = createAgentRuntime({
      sessionId: "sess-roleq-explorer",
      eventStore,
      persistence,
      firewall,
      providerCatalog: catalog,
      workspacePath: ws,
      freeCloud: freeCloudHooks(receipts),
      eightBit: createEightBitRuntime({ firewall, persistence }),
    });

    const result = await runtime.executeAgentRun({
      runId: "run-roleq-explorer",
      agentId: "explorer-roleq",
      role: "explorer",
      goal: "Map the workspace",
      workspaceId: "ws-roleq-explorer",
      workspacePath: ws,
      permissions: { read: true, search: true, write: false, executeCommand: false, network: false },
      structuredOutput: "explorer",
      roleRouting: true,
    });

    expect(result.status).toBe("completed");
    expect(providerA.requests).toBeGreaterThan(0);
    expect(providerB.requests).toBe(0);
    expect(providerC.requests).toBe(0);
  });

  it("a capacity-exhausted QUALIFIED route yields to a healthy PROBATION route — no false wait", async () => {
    const firewall = new ForgeZero();
    // aaa-qualified wins the modelId tiebreak on identical scores; only the availability
    // tier can put the probation route in front of it.
    firewall.register(fleetRecord("fleet-a", "aaa-qualified"));
    firewall.register(fleetRecord("fleet-b", "zzz-probation"));
    const catalog = new InMemoryProviderCatalog();
    const providerA = new ScriptedFleetProvider("fleet-a");
    const providerB = new ScriptedFleetProvider("fleet-b");
    catalog.register(providerA);
    catalog.register(providerB);
    const receipts = new Map<string, ModelQualificationReceipt>([
      ["fleet-a::aaa-qualified", receipt("fleet-a", "aaa-qualified", { REVIEWER: roleResult("QUALIFIED", [true, true, true, true], "REVIEWER") })],
      ["fleet-b::zzz-probation", receipt("fleet-b", "zzz-probation", { REVIEWER: roleResult("PROBATION", [true, false, true], "REVIEWER") })],
    ]);
    const runtime = createAgentRuntime({
      sessionId: "sess-roleq-cap",
      eventStore,
      persistence,
      firewall,
      providerCatalog: catalog,
      workspacePath: ws,
      freeCloud: freeCloudHooks(receipts, (providerId) =>
        providerId === "fleet-a"
          ? { scoreAdjustment: 0, reasonCodes: ["KNOWN_CAPACITY_EXHAUSTED"] }
          : { scoreAdjustment: 0, reasonCodes: ["CAPACITY_UNOBSERVED"] }),
      eightBit: createEightBitRuntime({ firewall, persistence }),
    });

    const result = await runtime.executeAgentRun({
      runId: "run-roleq-cap",
      agentId: "reviewer-cap",
      role: "reviewer",
      goal: "Review the diff",
      workspaceId: "ws-roleq-cap",
      workspacePath: ws,
      permissions: { read: true, search: true, write: false, executeCommand: false, network: false },
      structuredOutput: "reviewer",
      roleRouting: true,
    });

    expect(result.status).toBe("completed");
    expect(providerA.requests).toBe(0);
    expect(providerB.requests).toBeGreaterThan(0);
  });

  it("failover skips a capacity-exhausted QUALIFIED route for a healthy PROBATION fallback", async () => {
    const firewall = new ForgeZero();
    firewall.register(fleetRecord("fleet-a", "aaa-failed"));
    firewall.register(fleetRecord("fleet-b", "bbb-qualified"));
    firewall.register(fleetRecord("fleet-c", "ccc-probation"));
    const catalog = new InMemoryProviderCatalog();
    const providerA = new ScriptedFleetProvider("fleet-a");
    providerA.failWithRateLimit = true;
    const providerB = new ScriptedFleetProvider("fleet-b");
    const providerC = new ScriptedFleetProvider("fleet-c");
    catalog.register(providerA);
    catalog.register(providerB);
    catalog.register(providerC);
    const receipts = new Map<string, ModelQualificationReceipt>([
      ["fleet-a::aaa-failed", receipt("fleet-a", "aaa-failed", { REVIEWER: roleResult("QUALIFIED", [true, true, true, true], "REVIEWER") })],
      ["fleet-b::bbb-qualified", receipt("fleet-b", "bbb-qualified", { REVIEWER: roleResult("QUALIFIED", [true, true, true, true], "REVIEWER") })],
      ["fleet-c::ccc-probation", receipt("fleet-c", "ccc-probation", { REVIEWER: roleResult("PROBATION", [true, false, true], "REVIEWER") })],
    ]);
    const runtime = createAgentRuntime({
      sessionId: "sess-roleq-fo-cap",
      eventStore,
      persistence,
      firewall,
      providerCatalog: catalog,
      workspacePath: ws,
      freeCloud: freeCloudHooks(receipts, (providerId) =>
        providerId === "fleet-b"
          ? { scoreAdjustment: 0, reasonCodes: ["KNOWN_CAPACITY_EXHAUSTED"] }
          : { scoreAdjustment: 0, reasonCodes: ["CAPACITY_UNOBSERVED"] }),
      eightBit: createEightBitRuntime({ firewall, persistence }),
    });

    const result = await runtime.executeAgentRun({
      runId: "run-roleq-fo-cap",
      agentId: "reviewer-fo-cap",
      role: "reviewer",
      goal: "Review the diff",
      workspaceId: "ws-roleq-fo-cap",
      workspacePath: ws,
      permissions: { read: true, search: true, write: false, executeCommand: false, network: false },
      structuredOutput: "reviewer",
      roleRouting: true,
    });

    expect(result.status).toBe("completed");
    expect(providerA.requests).toBeGreaterThan(0);
    // bbb-qualified outranks ccc-probation on the qualification tier, but its exhausted
    // capacity puts it on the lower availability tier — the rotation lands on probation.
    expect(providerB.requests).toBe(0);
    expect(providerC.requests).toBeGreaterThan(0);
  });
});

describe("R48 — bounded capacity wait on QUEUED fabric verdicts", () => {
  let ws: string;
  let eventStore: EventStore;
  let persistence: ReturnType<typeof createSessionPersistence>;
  let firewall: ForgeZero;

  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), "cf-capacity-wait-"));
    eventStore = new EventStore();
    persistence = createSessionPersistence({ dbPath: ":memory:" });
    firewall = new ForgeZero();
    persistence.upsertSession({
      id: "sess-capacity-wait",
      title: "Capacity Wait Test Session",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "idle",
    });
  });

  afterEach(async () => {
    persistence.close();
    await rm(ws, { recursive: true, force: true });
  });

  function runtimeWithScriptedEightBit(scripted: Array<Record<string, unknown>>) {
    firewall.register(fleetRecord("fleet-a", "model-a"));
    const catalog = new InMemoryProviderCatalog();
    const provider = new ScriptedFleetProvider("fleet-a");
    catalog.register(provider);
    const realModel = firewall.getModel("fleet-a", "model-a");
    const eightBit = createEightBitRuntime({ firewall, persistence });
    const selectInitialRoute = vi.spyOn(eightBit, "selectInitialRoute").mockImplementation(async () => {
      const next = scripted.shift() ?? scripted[scripted.length - 1];
      return (next?.outcome === "selected" ? { ...next, model: realModel } : next) as never;
    });
    const runtime = createAgentRuntime({
      sessionId: "sess-capacity-wait",
      eventStore,
      persistence,
      firewall,
      providerCatalog: catalog,
      workspacePath: ws,
      eightBit,
    });
    const adapter = createWorkspaceEventAdapter({ sessionId: "sess-capacity-wait", eventStore, persistence });
    return { runtime, adapter, provider, selectInitialRoute };
  }

  const runArgs = {
    agentId: "coder-wait",
    role: "coder" as const,
    goal: "Do the thing",
    workspaceId: "ws-capacity-wait",
    permissions: { read: true, search: true, write: false, executeCommand: false, network: false },
    roleRouting: true,
  };

  it("a near-term QUEUED verdict waits once then re-decides — no false failure", async () => {
    const { runtime, adapter, provider, selectInitialRoute } = runtimeWithScriptedEightBit([
      { outcome: "no_eligible_route", reasonCodes: ["FABRIC_QUEUED_FOR_CAPACITY"], queued: { nextAvailableAt: new Date(Date.now() + 1_500).toISOString() } },
      { outcome: "selected", model: { providerId: "fleet-a", modelId: "model-a" }, score: 80, reasons: ["ADMITTED"] },
    ]);

    const started = Date.now();
    const result = await runtime.executeAgentRun({ runId: "run-cap-wait-1", workspacePath: ws, adapter, ...runArgs });

    if (result.status !== "completed") console.log("cap-wait-1 summary:", result.summary);
    expect(result.status).toBe("completed");
    expect(provider.requests).toBeGreaterThan(0);
    expect(selectInitialRoute).toHaveBeenCalledTimes(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(800);
    const waitEvent = eventStore.getAll().find((e) => e.type === "subagent.progress" && String((e.payload as { message?: string }).message ?? "").includes("capacity returns"));
    expect(waitEvent).toBeDefined();
  });

  it("a QUEUED verdict beyond the horizon fails closed without waiting", async () => {
    const { runtime, adapter, selectInitialRoute } = runtimeWithScriptedEightBit([
      { outcome: "no_eligible_route", reasonCodes: ["FABRIC_QUEUED_FOR_CAPACITY"], queued: { nextAvailableAt: new Date(Date.now() + 3_600_000).toISOString() } },
      { outcome: "selected", model: { providerId: "fleet-a", modelId: "model-a" }, score: 80, reasons: ["ADMITTED"] },
    ]);

    const started = Date.now();
    const result = await runtime.executeAgentRun({ runId: "run-cap-wait-2", workspacePath: ws, adapter, ...runArgs });

    expect(result.status).toBe("failed");
    expect(result.summary).toContain("PROVIDER_UNAVAILABLE");
    expect(selectInitialRoute).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("a stale reset (nextAvailableAt already past) re-decides immediately — the queue answer aged out", async () => {
    const { runtime, adapter, provider, selectInitialRoute } = runtimeWithScriptedEightBit([
      { outcome: "no_eligible_route", reasonCodes: ["FABRIC_QUEUED_FOR_CAPACITY"], queued: { nextAvailableAt: new Date(Date.now() - 500).toISOString() } },
      { outcome: "selected", model: { providerId: "fleet-a", modelId: "model-a" }, score: 80, reasons: ["ADMITTED"] },
    ]);

    const started = Date.now();
    const result = await runtime.executeAgentRun({ runId: "run-cap-wait-4", workspacePath: ws, adapter, ...runArgs });

    expect(result.status).toBe("completed");
    expect(provider.requests).toBeGreaterThan(0);
    expect(selectInitialRoute).toHaveBeenCalledTimes(2);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("a DENIED verdict never waits — re-decide is not attempted", async () => {
    const { runtime, adapter, selectInitialRoute } = runtimeWithScriptedEightBit([
      { outcome: "no_eligible_route", reasonCodes: ["FABRIC_DENIED_NO_SUPPLY", "NO_ROLE_QUALIFIED_ROUTE"] },
      { outcome: "selected", model: { providerId: "fleet-a", modelId: "model-a" }, score: 80, reasons: ["ADMITTED"] },
    ]);

    const result = await runtime.executeAgentRun({ runId: "run-cap-wait-3", workspacePath: ws, adapter, ...runArgs });

    expect(result.status).toBe("failed");
    expect(result.summary).toContain("NO_ROLE_QUALIFIED_ROUTE");
    expect(selectInitialRoute).toHaveBeenCalledTimes(1);
  });
});
