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

/**
 * 8-Bit mandatory certification scenario (V1 spec §44 / brief §85): a CODER turn starts on
 * Provider A, which does real work (edits a file), then becomes unavailable mid-turn. 8-Bit
 * must stop sending new requests to A, preserve authoritative runtime state, select Provider B,
 * and resume the SAME turn without re-executing A's already-completed side effect.
 */

const outputFileContent = "written-by-provider-a";

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

  async *streamChat(_req: ChatRequest, _signal?: AbortSignal): AsyncIterable<StreamEvent> {
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
    // Mid-turn outage: Provider A becomes unavailable AFTER its tool call already completed
    // and was fed back into the conversation — this is the safe boundary 8-Bit fails over at.
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

  async *streamChat(req: ChatRequest, _signal?: AbortSignal): AsyncIterable<StreamEvent> {
    this.callCount++;
    this.seenMessages.push(req);
    if (this.callCount === 1) {
      const args = JSON.stringify({ command: "node --version" });
      yield { type: "tool_call_started", toolCallId: "tc-cmd-b", toolName: "run_command" };
      yield { type: "tool_call_delta", toolCallId: "tc-cmd-b", delta: args };
      yield { type: "tool_call_completed", toolCallId: "tc-cmd-b", toolName: "run_command", arguments: args };
      yield { type: "usage", usage: { inputTokens: 40, outputTokens: 10 } };
      yield { type: "finish", finishReason: "tool_calls" };
      return;
    }
    yield { type: "text_delta", delta: "Task complete." };
    yield { type: "finish", finishReason: "stop" };
  }

  async healthCheck() {
    return { status: "available" as const };
  }
}

/** Drives the turn to completion, auto-approving any tool approvals it hits along the way
 * (write_file/edit_file require approval by default) so the test proves failover behavior
 * without being about approval UX. Approval mechanics themselves are exercised for real here —
 * this is not a bypass, it is the same `resolveApproval` call a real client makes. */
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

describe("8-Bit — active-run cross-provider failover E2E (mandatory certification scenario)", () => {
  let tmpDir: string;
  let persistence: ISessionPersistence;
  let eventStore: EventStore;
  let firewall: ForgeZero;
  let catalog: InMemoryProviderCatalog;
  let providerA: FirstThenOutageProvider;
  let providerB: ReplacementProvider;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "eight-bit-failover-"));
    persistence = createSessionPersistence({ dbPath: ":memory:" });
    await persistence.init();
    eventStore = new EventStore();
    firewall = new ForgeZero();
    // "aaa-model" ranks first alphabetically (ForgeRouter's deterministic modelId tiebreak on
    // equal score), so adaptive routing deterministically starts the turn on Provider A.
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

  it("[PASS] preserves the completed edit, does not replay it, rotates to Provider B, and completes the turn", async () => {
    const sessionId = "eight-bit-e2e-session";
    const runtime = createAgentRuntime({
      sessionId,
      eventStore,
      persistence,
      firewall,
      providerCatalog: catalog,
      workspacePath: tmpDir,
    });
    await runtime.init();

    const turnId = await runtime.startTurn("Write output.txt then run node --version");
    const final = await waitForTerminal(runtime, persistence, sessionId, turnId);

    expect(final?.status).toBe("completed");
    expect(final?.providerId).toBe("provider-b");
    expect(final?.modelId).toBe("zzz-model");

    // The file Provider A wrote before the outage is still there — the side effect was never
    // lost, and it was produced exactly once (Provider A's success path only ran once).
    const written = await fs.readFile(path.join(tmpDir, "output.txt"), "utf-8");
    expect(written).toBe(outputFileContent);
    expect(providerA.callCount).toBe(2); // one success, one throw — never retried against A again
    expect(providerB.callCount).toBe(2); // one tool call, one final text response

    // Provider B actually saw the tool call and result Provider A produced — proof the
    // conversation (and therefore the completed side effect) was preserved across the swap,
    // not rebuilt from scratch and not replayed.
    const lastRequestSeenByB = providerB.seenMessages.at(-1)!;
    const sawWriteToolCall = lastRequestSeenByB.messages.some(
      (m) => m.role === "assistant" && m.toolCalls?.some((tc) => tc.function.name === "write_file"),
    );
    expect(sawWriteToolCall).toBe(true);
    const sawHandoffNotice = lastRequestSeenByB.messages.some((m) => m.role === "system" && m.content.includes("8-Bit model handoff"));
    expect(sawHandoffNotice).toBe(true);

    // The write_file tool call/result is recorded exactly once in the durable event log — not
    // duplicated by the failover.
    const events = eventStore.getBySession(sessionId);
    const writeCompletedEvents = events.filter((e: any) => e.type === "tool.call_completed" && e.payload?.toolCallId === "tc-write-a");
    expect(writeCompletedEvents).toHaveLength(1);

    // A structured router.failover event and 8-Bit status events were actually emitted.
    expect(events.some((e: any) => e.type === "router.failover")).toBe(true);
    const statusEvents = events.filter((e: any) => e.type === "eightbit.status");
    expect(statusEvents.some((e: any) => e.payload.event === "ROUTE_ROTATION_STARTED")).toBe(true);
    expect(statusEvents.some((e: any) => e.payload.event === "ROUTE_READY")).toBe(true);
    for (const e of statusEvents) {
      expect(typeof e.payload.accessibleText).toBe("string");
      expect(e.payload.accessibleText.length).toBeGreaterThan(0);
    }

    // 8-Bit persisted an inspectable, non-secret decision receipt for the rotation.
    const items = await persistence.getWorkItems(sessionId);
    const receipts = items.filter((i) => i.kind === "eight_bit_decision_receipt");
    expect(receipts.length).toBeGreaterThanOrEqual(1);
    const rotateReceipt = receipts.find((r: any) => r.receipt.action === "ROTATE");
    expect(rotateReceipt).toBeDefined();
    const receiptJson = JSON.stringify(rotateReceipt);
    expect(receiptJson).not.toContain("sk-");
    expect(receiptJson).not.toContain(outputFileContent);

    // CF-17 approval state is untouched by the failover itself: the write_file approval this
    // test resolved reached a real terminal decision (not left dangling, not double-resolved,
    // not silently satisfied by 8-Bit), and no question was ever created by 8-Bit.
    const approvalItems = items.filter((i) => i.kind === "approval");
    expect(approvalItems.length).toBeGreaterThanOrEqual(1);
    for (const a of approvalItems) expect((a as any).decision).toBeDefined();
    expect(items.some((i) => i.kind === "question")).toBe(false);
  });
});
