import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
    expect(eightBitRoleForAgentRole("explorer")).toBe("TOOL_AGENT");
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

  it("keeps the legacy deterministic fallback when no fleet route is registered", async () => {
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
