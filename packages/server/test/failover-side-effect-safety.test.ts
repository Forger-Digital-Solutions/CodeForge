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

class ProviderAWithSideEffectThenOutage implements ProviderAdapter {
  readonly providerId = "provider-a";
  readonly isTestProvider = true;
  callCount = 0;

  async listModels(): Promise<ProviderModel[]> {
    return [{ modelId: "aaa-model", displayName: "AAA Model", isFree: true, freeStatus: "verified_free", capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true } }];
  }

  async chat(_req: ChatRequest): Promise<ChatResponse> {
    throw new Error("Use streamChat");
  }

  async *streamChat(_req: ChatRequest, _signal?: AbortSignal): AsyncIterable<StreamEvent> {
    this.callCount++;
    if (this.callCount === 1) {
      // Non-idempotent tool operation: increments counter file on disk
      const cmd = `node -e "const fs = require('fs'); const p = 'counter.txt'; const val = Number(fs.readFileSync(p, 'utf8')); fs.writeFileSync(p, String(val + 1));"`;
      const args = JSON.stringify({ command: cmd });
      yield { type: "tool_call_started", toolCallId: "tc-counter-increment", toolName: "run_command" };
      yield { type: "tool_call_delta", toolCallId: "tc-counter-increment", delta: args };
      yield { type: "tool_call_completed", toolCallId: "tc-counter-increment", toolName: "run_command", arguments: args };
      yield { type: "usage", usage: { inputTokens: 40, outputTokens: 20 } };
      yield { type: "finish", finishReason: "tool_calls" };
      return;
    }
    // Mid-turn outage AFTER the non-idempotent side effect completed and was added to history
    throw new Error("503 Service Unavailable: simulated upstream outage during active turn");
  }

  async healthCheck() {
    return { status: "available" as const };
  }
}

class ProviderBFailoverTarget implements ProviderAdapter {
  readonly providerId = "provider-b";
  readonly isTestProvider = true;
  callCount = 0;
  seenMessages: ChatRequest[] = [];

  async listModels(): Promise<ProviderModel[]> {
    return [{ modelId: "zzz-model", displayName: "ZZZ Model", isFree: true, freeStatus: "verified_free", capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true } }];
  }

  async chat(_req: ChatRequest): Promise<ChatResponse> {
    throw new Error("Use streamChat");
  }

  async *streamChat(req: ChatRequest, _signal?: AbortSignal): AsyncIterable<StreamEvent> {
    this.callCount++;
    this.seenMessages.push(req);
    // Directly complete the turn without re-running any tools
    yield { type: "text_delta", delta: "Successfully resumed from safe failover boundary and completed turn." };
    yield { type: "finish", finishReason: "stop" };
  }

  async healthCheck() {
    return { status: "available" as const };
  }
}

async function waitForTerminal(
  runtime: ReturnType<typeof createAgentRuntime>,
  persistence: ISessionPersistence,
  sessionId: string,
  turnId: string,
) {
  const approved = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const state = runtime.getTurn(turnId);
    if (state?.status === "completed" || state?.status === "failed") return state;
    if (state?.status === "waiting_for_approval") {
      const items = await persistence.getWorkItems(sessionId);
      const pending = items.find((it) => it.kind === "approval" && it.turnId === turnId && !it.decision && !approved.has(it.id));
      if (pending) {
        approved.add(pending.id);
        await runtime.resolveApproval(pending.id, "allow_once");
      }
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return runtime.getTurn(turnId);
}

describe("Side-effect replay safety during active-run failover (R2 spec §24)", () => {
  let tmpDir: string;
  let persistence: ISessionPersistence;
  let eventStore: EventStore;
  let firewall: ForgeZero;
  let catalog: InMemoryProviderCatalog;
  let providerA: ProviderAWithSideEffectThenOutage;
  let providerB: ProviderBFailoverTarget;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codeforge-side-effect-"));
    persistence = createSessionPersistence({ dbPath: ":memory:" });
    await persistence.init();
    eventStore = new EventStore();
    firewall = new ForgeZero();
    firewall.register(createGenericFreeRecord({ providerId: "provider-a", modelId: "aaa-model", displayName: "AAA Model" }));
    firewall.register(createGenericFreeRecord({ providerId: "provider-b", modelId: "zzz-model", displayName: "ZZZ Model" }));
    catalog = new InMemoryProviderCatalog();
    providerA = new ProviderAWithSideEffectThenOutage();
    providerB = new ProviderBFailoverTarget();
    catalog.register(providerA);
    catalog.register(providerB);

    // Initialize counter file to "0"
    await fs.writeFile(path.join(tmpDir, "counter.txt"), "0", "utf8");
  });

  afterEach(async () => {
    await persistence.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("proves non-idempotent tool operation executes strictly once and is never replayed across failover", async () => {
    const sessionId = "failover-side-effect-session";
    const runtime = createAgentRuntime({
      sessionId,
      eventStore,
      persistence,
      firewall,
      providerCatalog: catalog,
      workspacePath: tmpDir,
    });
    await runtime.init();

    const turnId = await runtime.startTurn("Increment counter file then finish");
    const final = await waitForTerminal(runtime, persistence, sessionId, turnId);

    expect(final?.status).toBe("completed");
    expect(final?.providerId).toBe("provider-b");
    expect(final?.modelId).toBe("zzz-model");

    // The counter file MUST be "1", proving the non-idempotent command was executed exactly once
    const counterContent = await fs.readFile(path.join(tmpDir, "counter.txt"), "utf8");
    expect(counterContent.trim()).toBe("1");

    // Provider A was called twice: 1) requested tool call, 2) threw 503 on next stream
    expect(providerA.callCount).toBe(2);

    // Provider B was called once to finish the turn
    expect(providerB.callCount).toBe(1);

    // Provider B received the completed tool call and output in message history
    const lastRequestToB = providerB.seenMessages[0]!;
    const toolMsg = lastRequestToB.messages.find((m) => m.role === "tool" && m.toolCallId === "tc-counter-increment");
    expect(toolMsg).toBeDefined();

    // Durable event store recorded the tool call completed event exactly once
    const events = eventStore.getBySession(sessionId);
    const completedToolEvents = events.filter(
      (e: any) => e.type === "tool.call_completed" && e.payload?.toolCallId === "tc-counter-increment",
    );
    expect(completedToolEvents).toHaveLength(1);

    // Structured failover event was recorded
    expect(events.some((e: any) => e.type === "router.failover")).toBe(true);
  });
});
