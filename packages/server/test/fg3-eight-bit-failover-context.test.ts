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
import { UserIntentHoldController } from "../src/user-intent-hold.js";

/**
 * FG-3 §56-58: extends the mandatory 8-Bit cross-provider failover scenario to prove the
 * REPLACEMENT model receives the FG-3 Context Kernel (steer state, verification status) inside
 * the handoff — not just the pre-FG-3 objective/changed-files/approval/question fields this
 * scenario already certified in `eight-bit-active-run-failover.test.ts`.
 */

const outputFileContent = "written-by-provider-a-fg3";

class FirstThenOutageProvider implements ProviderAdapter {
  readonly providerId = "provider-a";
  readonly isTestProvider = true;
  callCount = 0;

  async listModels(): Promise<ProviderModel[]> {
    return [{ modelId: "aaa-model", displayName: "AAA Model", isFree: true, freeStatus: "verified_free", capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true } }];
  }

  async chat(_req: ChatRequest): Promise<ChatResponse> {
    throw new Error("Use streamChat");
  }

  async *streamChat(_req: ChatRequest): AsyncIterable<StreamEvent> {
    this.callCount++;
    if (this.callCount === 1) {
      const args = JSON.stringify({ path: "output.txt", content: outputFileContent });
      yield { type: "tool_call_started", toolCallId: "tc-write-a", toolName: "write_file" };
      yield { type: "tool_call_delta", toolCallId: "tc-write-a", delta: args };
      yield { type: "tool_call_completed", toolCallId: "tc-write-a", toolName: "write_file", arguments: args };
      yield { type: "usage", usage: { inputTokens: 50, outputTokens: 20 } };
      yield { type: "finish", finishReason: "tool_calls" };
      return;
    }
    throw new Error("503 Service Unavailable: provider outage");
  }

  async healthCheck() {
    return { status: "available" as const };
  }
}

class ReplacementProvider implements ProviderAdapter {
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

  async *streamChat(req: ChatRequest): AsyncIterable<StreamEvent> {
    this.callCount++;
    this.seenMessages.push(req);
    yield { type: "text_delta", delta: "Task complete." };
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

describe("FG-3 — 8-Bit failover handoff carries the Context Kernel (steer + verification state), never replays a side effect", () => {
  let tmpDir: string;
  let persistence: ISessionPersistence;
  let eventStore: EventStore;
  let firewall: ForgeZero;
  let catalog: InMemoryProviderCatalog;
  let providerA: FirstThenOutageProvider;
  let providerB: ReplacementProvider;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "fg3-failover-ctx-"));
    persistence = createSessionPersistence({ dbPath: ":memory:" });
    await persistence.init();
    eventStore = new EventStore();
    firewall = new ForgeZero();
    firewall.register(createGenericFreeRecord({ providerId: "provider-a", modelId: "aaa-model", displayName: "AAA Model" }));
    firewall.register(createGenericFreeRecord({ providerId: "provider-b", modelId: "zzz-model", displayName: "ZZZ Model" }));
    catalog = new InMemoryProviderCatalog();
    providerA = new FirstThenOutageProvider();
    providerB = new ReplacementProvider();
    catalog.register(providerA);
    catalog.register(providerB);
  });

  afterEach(async () => {
    await persistence.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("[PASS] the replacement model's handoff reflects real verification history and never silently drops a submitted steer", async () => {
    const sessionId = "fg3-failover-ctx-session";
    // A prior (simulated) ForgeVerify attempt already ran and failed for this session — proves
    // the kernel surfaces genuine verification history across the swap rather than defaulting
    // to a fabricated "not run" or "passed" state.
    await persistence.upsertSession({ id: sessionId, title: "t", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: "running" });
    await persistence.upsertWorkItem({
      kind: "verification",
      id: "v1",
      sessionId,
      runId: "prior-run",
      recordType: "attempt",
      planId: "plan-1",
      status: "failed",
      payload: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const userIntentHold = new UserIntentHoldController({ eventStore, persistence });
    const runtime = createAgentRuntime({ sessionId, eventStore, persistence, firewall, providerCatalog: catalog, workspacePath: tmpDir, userIntentHold });
    await runtime.init();

    const steerId = "fg3-steer-1";
    const turnId = await runtime.startTurn("Write output.txt then run node --version");
    // Submitted as early as possible; whichever side of the model boundary it lands on, it must
    // never be silently lost, and the handoff must describe whichever state it actually reached.
    await runtime.steerTurn(turnId, "Also verify error handling paths", steerId);

    const final = await waitForTerminal(runtime, persistence, sessionId, turnId);
    expect(final?.status).toBe("completed");
    expect(final?.providerId).toBe("provider-b");

    // Side effect preserved, never replayed (same base guarantee as the mandatory E2E).
    const written = await fs.readFile(path.join(tmpDir, "output.txt"), "utf-8");
    expect(written).toBe(outputFileContent);
    expect(providerA.callCount).toBe(2);

    const handoffMessage = providerB.seenMessages
      .flatMap((request) => request.messages)
      .find((message) => message.role === "system" && message.content.includes("8-Bit model handoff"))?.content;
    expect(handoffMessage).toBeDefined();

    // FG-3: verification history survives the swap, honestly (not upgraded to "passed").
    expect(handoffMessage).toContain("Latest recorded verification status: failed");
    expect(handoffMessage).not.toMatch(/verification status.{0,10}(passed|complete)/i);

    // FG-3: the steer is never silently dropped — it is either still queued (told to the
    // replacement so it applies it) or already consumed (told not to re-apply it). Exactly one
    // of these must be true; the receipt itself proves which.
    const items = await persistence.getWorkItems(sessionId);
    const steerReceipt = items.find((item) => item.kind === "steer_receipt" && item.steerId === steerId);
    expect(steerReceipt).toBeDefined();
    if (steerReceipt && steerReceipt.kind === "steer_receipt" && steerReceipt.consumedAt) {
      expect(handoffMessage).toContain("do not re-apply it");
    } else {
      expect(handoffMessage).toContain("user steering instruction(s) are queued and not yet applied");
    }

    // Approval reached a genuine terminal decision, exactly the CF-17 authority boundary FG-3
    // must not touch.
    const approvalItems = items.filter((item) => item.kind === "approval");
    expect(approvalItems.length).toBeGreaterThanOrEqual(1);
    for (const approval of approvalItems) expect((approval as { decision?: string }).decision).toBeDefined();
  });
});
