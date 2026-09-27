import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { createAgentRuntime } from "../src/agent-runtime.js";
import { createSubagentManager } from "../src/subagent-manager.js";
import { createWorkspaceEventAdapter } from "../src/workspace-event-adapter.js";

class ScriptedProvider implements ProviderAdapter {
  readonly providerId: string;
  readonly isTestProvider = true;
  failWithRateLimit = false;
  /** Tool calls to emit once before finishing; each entry fires on one request. */
  pendingToolCalls: Array<{ name: string; arguments: string }> = [];
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
      yield { type: "error", code: "PROVIDER_RATE_LIMITED", message: "429 rate limit exceeded", retryable: true, status: 429 };
      return;
    }
    const pending = this.pendingToolCalls.shift();
    if (pending) {
      yield { type: "tool_call_completed", toolCallId: `call-${this.requests}`, toolName: pending.name, arguments: pending.arguments };
      yield { type: "finish", finishReason: "tool_calls" };
      return;
    }
    const systemPrompt = req.messages.find((message) => message.role === "system")?.content ?? "";
    if (systemPrompt.includes("CodeForge Explorer")) {
      yield { type: "text_delta", delta: JSON.stringify({ summary: "Mapped.", findings: [], evidence: [] }) };
    } else {
      yield { type: "text_delta", delta: "Task completed." };
    }
    yield { type: "finish", finishReason: "stop" };
  }

  async healthCheck() {
    return { status: "available" as const };
  }
}

function fleetRecord(providerId: string, modelId: string, overrides: Partial<FreeModelRecord> = {}): FreeModelRecord {
  return createGenericFreeRecord({ providerId, modelId, displayName: `${providerId} ${modelId}`, ...overrides });
}

describe("R50 failover productive-turn budget", () => {
  let ws: string;
  let eventStore: EventStore;
  let persistence: ReturnType<typeof createSessionPersistence>;
  let firewall: ForgeZero;

  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), "cf-r50-budget-"));
    await writeFile(join(ws, "note.txt"), "fixture");
    eventStore = new EventStore();
    persistence = createSessionPersistence({ dbPath: ":memory:" });
    firewall = new ForgeZero();
    persistence.upsertSession({
      id: "sess-r50",
      title: "R50 Failover Budget",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "idle",
    });
  });

  afterEach(async () => {
    persistence.close();
    await rm(ws, { recursive: true, force: true });
  });

  function buildRuntime(catalog: InMemoryProviderCatalog) {
    const runtime = createAgentRuntime({
      sessionId: "sess-r50",
      eventStore,
      persistence,
      firewall,
      providerCatalog: catalog,
      workspacePath: ws,
    });
    const adapter = createWorkspaceEventAdapter({ sessionId: "sess-r50", eventStore, persistence });
    return createSubagentManager({ persistence, agentRuntime: runtime, r1Enabled: true });
  }

  const spawnExplorer = (manager: ReturnType<typeof buildRuntime>, parentRunId: string, maxModelTurns: number) =>
    manager.spawnChildAgent({
      parentRunId,
      sessionId: "sess-r50",
      agentId: "explorer",
      task: "Map the fixture workspace",
      workspacePath: ws,
      structuredOutput: "explorer",
      executionBudget: { maxModelTurns },
    });

  it("grants a bounded extra turn after failover so the replacement route can converge", async () => {
    firewall.register(fleetRecord("fleet-a", "model-a", { benchmarkProfile: { coding: 90, toolCalling: 90, reasoning: 90, longContext: 90, speed: 90 } }));
    firewall.register(fleetRecord("fleet-b", "model-b", { benchmarkProfile: { coding: 40, toolCalling: 40, reasoning: 40, longContext: 40, speed: 40 } }));
    const catalog = new InMemoryProviderCatalog();
    const providerA = new ScriptedProvider("fleet-a");
    providerA.failWithRateLimit = true;
    const providerB = new ScriptedProvider("fleet-b");
    providerB.pendingToolCalls.push({ name: "read_file", arguments: JSON.stringify({ path: "note.txt" }) });
    catalog.register(providerA);
    catalog.register(providerB);
    const manager = buildRuntime(catalog);

    const result = await spawnExplorer(manager, "run-r50-1", 1);

    expect(result.status).toBe("completed");
    expect(providerB.requests).toBe(2);
    expect(eventStore.getAll().some((event) => event.type === "router.failover")).toBe(true);
  });

  it("without failover the same turn budget stays exhausted (no free turns)", async () => {
    firewall.register(fleetRecord("fleet-b", "model-b"));
    const catalog = new InMemoryProviderCatalog();
    const providerB = new ScriptedProvider("fleet-b");
    providerB.pendingToolCalls.push({ name: "read_file", arguments: JSON.stringify({ path: "note.txt" }) });
    catalog.register(providerB);
    const manager = buildRuntime(catalog);

    const result = await spawnExplorer(manager, "run-r50-2", 1);

    expect(result.status).toBe("blocked");
    expect(result.summary).toContain("AGENT_MODEL_TURN_LIMIT");
    expect(providerB.requests).toBe(1);
  });

  it("the failover grant is capped: a non-converging replacement still hits the hard ceiling", async () => {
    firewall.register(fleetRecord("fleet-a", "model-a", { benchmarkProfile: { coding: 90, toolCalling: 90, reasoning: 90, longContext: 90, speed: 90 } }));
    firewall.register(fleetRecord("fleet-b", "model-b", { benchmarkProfile: { coding: 40, toolCalling: 40, reasoning: 40, longContext: 40, speed: 40 } }));
    const catalog = new InMemoryProviderCatalog();
    const providerA = new ScriptedProvider("fleet-a");
    providerA.failWithRateLimit = true;
    const providerB = new ScriptedProvider("fleet-b");
    for (let i = 0; i < 10; i++) {
      providerB.pendingToolCalls.push({ name: "read_file", arguments: JSON.stringify({ path: "note.txt" }) });
    }
    catalog.register(providerA);
    catalog.register(providerB);
    const manager = buildRuntime(catalog);

    const result = await spawnExplorer(manager, "run-r50-3", 1);

    // 1 base turn + grant (≤ FAILOVER_TURN_GRANT_CAP): never unbounded.
    expect(result.status).toBe("blocked");
    expect(result.summary).toContain("AGENT_MODEL_TURN_LIMIT");
    expect(providerB.requests).toBeLessThanOrEqual(3);
  });
});
