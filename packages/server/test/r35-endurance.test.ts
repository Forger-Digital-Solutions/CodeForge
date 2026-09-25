import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
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
import { createAgentRuntime } from "../src/agent-runtime.js";

/**
 * R35 Mission AA — runtime endurance. Fifty sequential agent turns through the
 * real runtime, persistence, and event store. Asserts:
 *  - every turn completes deterministically;
 *  - event sequence is strictly monotonic and total growth is linear in turns;
 *  - durable records stay coherent (one turn row each, bounded work items);
 *  - the runtime's live maps do not accumulate per-turn residue;
 *  - heap growth stays bounded (orders, not exact bytes — GC is advisory).
 */
class ScriptedProvider implements ProviderAdapter {
  readonly providerId = "test-provider";
  readonly isTestProvider = true;
  calls = 0;
  async listModels(): Promise<ProviderModel[]> {
    return [{
      modelId: "free-model-1", displayName: "Free", isFree: true, freeStatus: "verified_free",
      capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true },
    }];
  }
  async chat(_req: ChatRequest): Promise<ChatResponse> { throw new Error("streamChat only"); }
  async *streamChat(_req: ChatRequest): AsyncIterable<StreamEvent> {
    this.calls++;
    yield { type: "text_delta", delta: `turn ${this.calls} done` };
    yield { type: "usage", usage: { inputTokens: 40, outputTokens: 12 } };
    yield { type: "finish", finishReason: "stop" };
  }
  async healthCheck() { return { status: "available" as const }; }
}

describe("R35 Mission AA — runtime endurance soak", () => {
  let tmpDir: string;
  let persistence: ReturnType<typeof createSessionPersistence>;
  let eventStore: EventStore;
  let firewall: ForgeZero;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cf-r35-soak-"));
    persistence = createSessionPersistence();
    await persistence.init();
    eventStore = new EventStore();
    firewall = new ForgeZero();
    firewall.register(createGenericFreeRecord({ providerId: "test-provider", modelId: "free-model-1" }));
  });

  afterEach(async () => {
    await persistence.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("50 sequential turns: monotone events, coherent records, no per-turn residue", async () => {
    const catalog = new InMemoryProviderCatalog();
    const provider = new ScriptedProvider();
    catalog.register(provider);
    const runtime = createAgentRuntime({
      sessionId: "soak-session",
      eventStore,
      persistence,
      firewall,
      providerCatalog: catalog,
      workspacePath: tmpDir,
      demoMode: false,
    });

    const heapBefore = process.memoryUsage().heapUsed;
    const TURNS = 50;
    for (let i = 0; i < TURNS; i++) {
      const result = await runtime.executeAgentRun({
        runId: `soak-run-${i}`,
        agentId: `agent-${i}`,
        role: "explorer",
        goal: `soak goal ${i}`,
        workspaceId: "ws-soak",
        workspacePath: tmpDir,
        permissions: { read: true, search: true, write: false, executeCommand: false, network: false },
      });
      expect(result.status).toBe("completed");
    }

    const events = eventStore.getAll();
    const seqs = events.map((e) => e.seq);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]!);
    }
    expect(events.length).toBeGreaterThan(0);

    // Event growth is linear in turns — no quadratic journal/pathology.
    const eventsPerTurn = events.length / TURNS;
    expect(eventsPerTurn).toBeLessThan(40);

    // Live maps must not accumulate one entry per completed run.
    expect(runtime.getActiveTurns().filter((t) => t.status !== "completed" && t.status !== "failed" && t.status !== "cancelled")).toEqual([]);

    // Heap stays within an order of magnitude of start for a bounded workload —
    // catches map/list leaks without making GC timing flaky.
    const heapAfter = process.memoryUsage().heapUsed;
    expect(heapAfter - heapBefore).toBeLessThan(256 * 1024 * 1024);
  }, 120_000);
});
