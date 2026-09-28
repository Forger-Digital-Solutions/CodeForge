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

/**
 * R52 Phase N — provider hammering / retry amplification.
 *
 * The invariant is request count, not outcome: a permanently failing route must not be
 * retried inside a run, and a failover must never multiply provider calls beyond the
 * hard-capped turn grant. The metric is `provider calls per logical turn` — a 429 storm
 * that produced more calls than turns is a hammering bug.
 */

class ScriptedProvider implements ProviderAdapter {
  readonly providerId: string;
  readonly isTestProvider = true;
  failWithRateLimit = false;
  failWithServerError = false;
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
    if (this.failWithServerError) {
      yield { type: "error", code: "PROVIDER_SERVER_ERROR", message: "500 internal error", retryable: true, status: 500 };
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

describe("R52 Phase N — retry amplification / provider hammering", () => {
  let ws: string;
  let eventStore: EventStore;
  let persistence: ReturnType<typeof createSessionPersistence>;
  let firewall: ForgeZero;

  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), "cf-r52-amp-"));
    await writeFile(join(ws, "note.txt"), "fixture");
    eventStore = new EventStore();
    persistence = createSessionPersistence({ dbPath: ":memory:" });
    firewall = new ForgeZero();
    persistence.upsertSession({
      id: "sess-r52",
      title: "R52 Amplification",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "idle",
    });
  });

  afterEach(async () => {
    persistence.close();
    await rm(ws, { recursive: true, force: true });
  });

  function spawnExplorer(catalog: InMemoryProviderCatalog, parentRunId: string, maxModelTurns: number) {
    const runtime = createAgentRuntime({
      sessionId: "sess-r52", eventStore, persistence, firewall,
      providerCatalog: catalog, workspacePath: ws,
    });
    const manager = createSubagentManager({ persistence, agentRuntime: runtime, r1Enabled: true });
    return manager.spawnChildAgent({
      parentRunId, sessionId: "sess-r52", agentId: "explorer",
      task: "Map the fixture workspace", workspacePath: ws,
      structuredOutput: "explorer", executionBudget: { maxModelTurns },
    });
  }

  it("a permanently-429 primary is hit once-ish, never retried in a loop — calls/turn stays ~1", async () => {
    firewall.register(fleetRecord("fleet-a", "model-a", { benchmarkProfile: { coding: 90, toolCalling: 90, reasoning: 90, longContext: 90, speed: 90 } }));
    firewall.register(fleetRecord("fleet-b", "model-b", { benchmarkProfile: { coding: 40, toolCalling: 40, reasoning: 40, longContext: 40, speed: 40 } }));
    const catalog = new InMemoryProviderCatalog();
    const providerA = new ScriptedProvider("fleet-a");
    providerA.failWithRateLimit = true;
    const providerB = new ScriptedProvider("fleet-b");
    catalog.register(providerA);
    catalog.register(providerB);

    const result = await spawnExplorer(catalog, "run-amp-1", 4);

    // The 429 route is tried, observed failing, and rotated — not retried turn after turn.
    expect(providerA.requests).toBeLessThanOrEqual(2);
    // The healthy replacement serves the turn(s).
    expect(providerB.requests).toBeGreaterThanOrEqual(1);
    expect(providerB.requests).toBeLessThanOrEqual(4);
    // Amplification: total wire calls never exceed logical turns by more than the
    // bounded failover edge — no storm against either provider.
    expect(providerA.requests + providerB.requests).toBeLessThanOrEqual(5);
  });

  it("a 5xx-failing primary behaves identically — bounded calls, honest rotation", async () => {
    firewall.register(fleetRecord("fleet-a", "model-a", { benchmarkProfile: { coding: 90, toolCalling: 90, reasoning: 90, longContext: 90, speed: 90 } }));
    firewall.register(fleetRecord("fleet-b", "model-b", { benchmarkProfile: { coding: 40, toolCalling: 40, reasoning: 40, longContext: 40, speed: 40 } }));
    const catalog = new InMemoryProviderCatalog();
    const providerA = new ScriptedProvider("fleet-a");
    providerA.failWithServerError = true;
    const providerB = new ScriptedProvider("fleet-b");
    catalog.register(providerA);
    catalog.register(providerB);

    await spawnExplorer(catalog, "run-amp-2", 4);

    expect(providerA.requests).toBeLessThanOrEqual(2);
    expect(providerB.requests).toBeLessThanOrEqual(4);
  });

  it("when every route keeps failing the run blocks with a bounded wire count — no spin", async () => {
    firewall.register(fleetRecord("fleet-a", "model-a", { benchmarkProfile: { coding: 90, toolCalling: 90, reasoning: 90, longContext: 90, speed: 90 } }));
    firewall.register(fleetRecord("fleet-b", "model-b", { benchmarkProfile: { coding: 40, toolCalling: 40, reasoning: 40, longContext: 40, speed: 40 } }));
    const catalog = new InMemoryProviderCatalog();
    const providerA = new ScriptedProvider("fleet-a");
    providerA.failWithRateLimit = true;
    const providerB = new ScriptedProvider("fleet-b");
    providerB.failWithRateLimit = true;
    catalog.register(providerA);
    catalog.register(providerB);

    const result = await spawnExplorer(catalog, "run-amp-3", 4);

    expect(result.status).not.toBe("completed");
    // Each route gets at most its initial attempt + the bounded failover edges —
    // never a retry loop on either provider.
    expect(providerA.requests).toBeLessThanOrEqual(2);
    expect(providerB.requests).toBeLessThanOrEqual(2);
    expect(providerA.requests + providerB.requests).toBeLessThanOrEqual(4);
  });
});
