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
import { EventStore, createSessionPersistence, type ISessionPersistence } from "@codeforge/sessions";
import { createAgentRuntime } from "../src/agent-runtime.js";

class AlwaysFailsProvider implements ProviderAdapter {
  readonly providerId: string;
  readonly isTestProvider = true;
  callCount = 0;
  constructor(providerId: string, private message: string) {
    this.providerId = providerId;
  }
  async listModels(): Promise<ProviderModel[]> {
    return [{ modelId: `${this.providerId}-model`, displayName: this.providerId, isFree: true, freeStatus: "verified_free", capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true } }];
  }
  async chat(_req: ChatRequest): Promise<ChatResponse> {
    throw new Error("Use streamChat");
  }
  async *streamChat(_req: ChatRequest, _signal?: AbortSignal): AsyncIterable<StreamEvent> {
    this.callCount++;
    throw new Error(this.message);
  }
  async healthCheck() {
    return { status: "available" as const };
  }
}

class TextOnlyProvider implements ProviderAdapter {
  readonly providerId: string;
  readonly isTestProvider = true;
  callCount = 0;
  constructor(providerId: string, private modelSuffix: string) {
    this.providerId = providerId;
  }
  async listModels(): Promise<ProviderModel[]> {
    return [{ modelId: `${this.providerId}-${this.modelSuffix}`, displayName: this.providerId, isFree: true, freeStatus: "verified_free", capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true } }];
  }
  async chat(_req: ChatRequest): Promise<ChatResponse> {
    throw new Error("Use streamChat");
  }
  async *streamChat(_req: ChatRequest, _signal?: AbortSignal): AsyncIterable<StreamEvent> {
    this.callCount++;
    yield { type: "text_delta", delta: "Done." };
    yield { type: "finish", finishReason: "stop" };
  }
  async healthCheck() {
    return { status: "available" as const };
  }
}

async function waitForTerminal(runtime: ReturnType<typeof createAgentRuntime>, turnId: string) {
  for (let i = 0; i < 100; i++) {
    const state = runtime.getTurn(turnId);
    if (state?.status === "completed" || state?.status === "failed") return state;
    await new Promise((r) => setTimeout(r, 50));
  }
  return runtime.getTurn(turnId);
}

describe("8-Bit — restart recovery and exact-pin safety (mandatory certification scenarios)", () => {
  let tmpDir: string;
  let persistence: ISessionPersistence;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "eight-bit-restart-"));
    persistence = createSessionPersistence({ dbPath: ":memory:" });
    await persistence.init();
  });

  afterEach(async () => {
    await persistence.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("[PASS] restart recovery: after a rotation, a brand-new AgentRuntime (same persistence) never re-selects the dead route", async () => {
    const sessionId = "restart-session";

    // --- "Process 1": rotate away from provider-a ---
    const eventStore1 = new EventStore();
    const firewall1 = new ForgeZero();
    firewall1.register(createGenericFreeRecord({ providerId: "provider-a", modelId: "aaa-model", displayName: "AAA" }));
    firewall1.register(createGenericFreeRecord({ providerId: "provider-b", modelId: "zzz-model", displayName: "ZZZ" }));
    const catalog1 = new InMemoryProviderCatalog();
    const providerAFails = new AlwaysFailsProvider("provider-a", "503 provider outage");
    const providerBWorks = new TextOnlyProvider("provider-b", "model");
    catalog1.register(providerAFails);
    catalog1.register(providerBWorks);

    const runtime1 = createAgentRuntime({ sessionId, eventStore: eventStore1, persistence, firewall: firewall1, providerCatalog: catalog1, workspacePath: tmpDir });
    await runtime1.init();
    const turnId1 = await runtime1.startTurn("First task");
    const final1 = await waitForTerminal(runtime1, turnId1);
    expect(final1?.status).toBe("completed");
    expect(final1?.providerId).toBe("provider-b");
    expect(providerAFails.callCount).toBe(1);

    // --- "Process 2": brand-new runtime, brand-new ForgeZero (simulates a real restart —
    // provider-a is still catalog-registered/"still exists"; only 8-Bit's persisted health
    // state can prevent re-selecting it). ---
    const eventStore2 = new EventStore();
    const firewall2 = new ForgeZero();
    firewall2.register(createGenericFreeRecord({ providerId: "provider-a", modelId: "aaa-model", displayName: "AAA" }));
    firewall2.register(createGenericFreeRecord({ providerId: "provider-b", modelId: "zzz-model", displayName: "ZZZ" }));
    const catalog2 = new InMemoryProviderCatalog();
    const providerAStillDead = new AlwaysFailsProvider("provider-a", "503 provider outage");
    const providerBStillWorks = new TextOnlyProvider("provider-b", "model");
    catalog2.register(providerAStillDead);
    catalog2.register(providerBStillWorks);

    const runtime2 = createAgentRuntime({ sessionId, eventStore: eventStore2, persistence, firewall: firewall2, providerCatalog: catalog2, workspacePath: tmpDir });
    await runtime2.init(); // <-- restores 8-Bit route/health state from the SAME persistence

    const turnId2 = await runtime2.startTurn("Second task after restart");
    const final2 = await waitForTerminal(runtime2, turnId2);

    expect(final2?.status).toBe("completed");
    expect(final2?.providerId).toBe("provider-b");
    // The critical assertion: the dead route was never even attempted post-restart.
    expect(providerAStillDead.callCount).toBe(0);
  });

  it("[PASS] exact pin: when the user explicitly pinned Provider A, its failure is surfaced — 8-Bit never silently substitutes a replacement", async () => {
    const sessionId = "exact-pin-session";
    const eventStore = new EventStore();
    const firewall = new ForgeZero();
    firewall.register(createGenericFreeRecord({ providerId: "provider-a", modelId: "aaa-model", displayName: "AAA" }));
    firewall.register(createGenericFreeRecord({ providerId: "provider-b", modelId: "zzz-model", displayName: "ZZZ" }));
    const catalog = new InMemoryProviderCatalog();
    const providerA = new AlwaysFailsProvider("provider-a", "503 provider outage");
    const providerB = new TextOnlyProvider("provider-b", "model");
    catalog.register(providerA);
    catalog.register(providerB);

    const runtime = createAgentRuntime({
      sessionId,
      eventStore,
      persistence,
      firewall,
      providerCatalog: catalog,
      workspacePath: tmpDir,
    });
    await runtime.init();
    runtime.setModelSelection({ providerId: "provider-a", modelId: "aaa-model" });

    const turnId = await runtime.startTurn("Task with exact pin");
    const final = await waitForTerminal(runtime, turnId);

    // The turn fails (the real failure is surfaced) rather than silently succeeding on a
    // substituted provider — 8-Bit must never replace an exact pin automatically.
    expect(final?.status).toBe("failed");
    expect(final?.providerId).toBe("provider-a");
    expect(providerB.callCount).toBe(0);

    const items = await persistence.getWorkItems(sessionId);
    const receipts = items.filter((i) => i.kind === "eight_bit_decision_receipt");
    expect(receipts.some((r: any) => r.receipt.action === "EXACT_PIN_FAILED")).toBe(true);
  });
});
