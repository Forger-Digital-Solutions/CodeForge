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
import { ERROR_CODES } from "@codeforge/agent";

class LoopScriptedProvider implements ProviderAdapter {
  readonly providerId: string;
  readonly isTestProvider = true;
  private callCount = 0;
  private mode: "repeat_same" | "oscillate" | "exceed_budget" | "error_recovery";

  constructor(providerId: string, mode: "repeat_same" | "oscillate" | "exceed_budget" | "error_recovery") {
    this.providerId = providerId;
    this.mode = mode;
  }

  async listModels(): Promise<ProviderModel[]> {
    return [{ modelId: "test-model", displayName: "Test Model", isFree: true, freeStatus: "verified_free", capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true } }];
  }

  async chat(_req: ChatRequest): Promise<ChatResponse> { throw new Error("Use streamChat"); }

  async *streamChat(_req: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    this.callCount++;

    if (this.mode === "repeat_same") {
      // Calls same tool with same argument indefinitely
      yield { type: "tool_call_started", toolCallId: `tc-${this.callCount}`, toolName: "read_file" };
      yield { type: "tool_call_completed", toolCallId: `tc-${this.callCount}`, toolName: "read_file", arguments: JSON.stringify({ path: "loop.txt" }) };
      yield { type: "usage", usage: { inputTokens: 50, outputTokens: 20 } };
      yield { type: "finish", finishReason: "tool_calls" };
      return;
    }

    if (this.mode === "oscillate") {
      // Oscillates between tool A and tool B
      const isEven = this.callCount % 2 === 0;
      const toolName = isEven ? "list_files" : "read_file";
      const args = isEven ? { path: "." } : { path: "a.txt" };
      yield { type: "tool_call_started", toolCallId: `tc-${this.callCount}`, toolName };
      yield { type: "tool_call_completed", toolCallId: `tc-${this.callCount}`, toolName, arguments: JSON.stringify(args) };
      yield { type: "usage", usage: { inputTokens: 50, outputTokens: 20 } };
      yield { type: "finish", finishReason: "tool_calls" };
      return;
    }

    if (this.mode === "exceed_budget") {
      // Calls different tools until budget halts it
      yield { type: "tool_call_started", toolCallId: `tc-${this.callCount}`, toolName: "read_file" };
      yield { type: "tool_call_completed", toolCallId: `tc-${this.callCount}`, toolName: "read_file", arguments: JSON.stringify({ path: `file-${this.callCount}.txt` }) };
      yield { type: "usage", usage: { inputTokens: 50, outputTokens: 20 } };
      yield { type: "finish", finishReason: "tool_calls" };
      return;
    }

    if (this.mode === "error_recovery") {
      if (this.callCount === 1) {
        // First try reading a non-existent file
        yield { type: "tool_call_started", toolCallId: "tc-1", toolName: "read_file" };
        yield { type: "tool_call_completed", toolCallId: "tc-1", toolName: "read_file", arguments: JSON.stringify({ path: "missing.txt" }) };
        yield { type: "usage", usage: { inputTokens: 50, outputTokens: 20 } };
        yield { type: "finish", finishReason: "tool_calls" };
      } else if (this.callCount === 2) {
        // Recover and create file
        yield { type: "tool_call_started", toolCallId: "tc-2", toolName: "write_file" };
        yield { type: "tool_call_completed", toolCallId: "tc-2", toolName: "write_file", arguments: JSON.stringify({ path: "created.txt", content: "hello world" }) };
        yield { type: "usage", usage: { inputTokens: 80, outputTokens: 30 } };
        yield { type: "finish", finishReason: "tool_calls" };
      } else {
        yield { type: "text_delta", delta: "Recovered from the missing file and created created.txt." };
        yield { type: "finish", finishReason: "stop" };
      }
    }
  }

  async healthCheck() { return { status: "available" as const }; }
}

describe("AgentRuntime — Tool-Use & Loop Detection Matrix (CF-07)", () => {
  let tmpDir: string;
  let persistence: ReturnType<typeof createSessionPersistence>;
  let eventStore: EventStore;
  let firewall: ForgeZero;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cf-tool-loop-test-"));
    persistence = createSessionPersistence();
    eventStore = new EventStore();
    firewall = new ForgeZero();
    firewall.register(createGenericFreeRecord());
  });

  afterEach(async () => {
    persistence.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("detects 3-turn identical tool call loops and fails closed as blocked with AGENT_TOOL_LOOP_DETECTED", async () => {
    const catalog = new InMemoryProviderCatalog();
    catalog.register(new LoopScriptedProvider("test-provider", "repeat_same"));

    const runtime = createAgentRuntime({
      sessionId: "loop-session",
      eventStore,
      persistence,
      firewall,
      providerCatalog: catalog,
      workspacePath: tmpDir,
    });

    const result = await runtime.executeAgentRun({
      runId: "run-loop-3",
      agentId: "coder",
      role: "coder",
      goal: "Test 3x identical call loop",
      workspaceId: "ws-1",
      workspacePath: tmpDir,
      permissions: { read: true, search: true, write: true, executeCommand: true, network: false },
    });

    expect(result.status).toBe("blocked");
    expect(result.stopReason).toBe("tool_loop_detected");
    expect(result.error).toBe(ERROR_CODES.AGENT_TOOL_LOOP_DETECTED);
  });

  it("detects 6-turn tool oscillation loops (A-B-A-B-A-B) and fails closed as blocked with AGENT_TOOL_LOOP_DETECTED", async () => {
    const catalog = new InMemoryProviderCatalog();
    catalog.register(new LoopScriptedProvider("test-provider", "oscillate"));

    const runtime = createAgentRuntime({
      sessionId: "osc-session",
      eventStore,
      persistence,
      firewall,
      providerCatalog: catalog,
      workspacePath: tmpDir,
    });

    const result = await runtime.executeAgentRun({
      runId: "run-osc-6",
      agentId: "coder",
      role: "coder",
      goal: "Test oscillation loop",
      workspaceId: "ws-1",
      workspacePath: tmpDir,
      permissions: { read: true, search: true, write: true, executeCommand: true, network: false },
    });

    expect(result.status).toBe("blocked");
    expect(result.stopReason).toBe("tool_loop_detected");
    expect(result.error).toBe(ERROR_CODES.AGENT_TOOL_LOOP_DETECTED);
  });

  it("halts when execution budget is exhausted (maxToolCalls) and blocks without claiming completion", async () => {
    const catalog = new InMemoryProviderCatalog();
    catalog.register(new LoopScriptedProvider("test-provider", "exceed_budget"));

    const runtime = createAgentRuntime({
      sessionId: "budget-session",
      eventStore,
      persistence,
      firewall,
      providerCatalog: catalog,
      workspacePath: tmpDir,
    });

    const result = await runtime.executeAgentRun({
      runId: "run-budget-limit",
      agentId: "coder",
      role: "coder",
      goal: "Test budget exhaustion",
      workspaceId: "ws-1",
      workspacePath: tmpDir,
      permissions: { read: true, search: true, write: true, executeCommand: true, network: false },
      executionBudget: {
        maxModelTurns: 20,
        maxToolCalls: 4,
        maxContextTokens: 32000,
      },
    });

    expect(result.status).toBe("blocked");
    expect(result.stopReason).toBe("budget_exhausted");
    expect(result.toolExecutions.length).toBe(4);
  });

  it("handles tool errors gracefully and allows model to recover", async () => {
    const catalog = new InMemoryProviderCatalog();
    catalog.register(new LoopScriptedProvider("test-provider", "error_recovery"));

    const runtime = createAgentRuntime({
      sessionId: "recovery-session",
      eventStore,
      persistence,
      firewall,
      providerCatalog: catalog,
      workspacePath: tmpDir,
    });

    const result = await runtime.executeAgentRun({
      runId: "run-recovery-1",
      agentId: "coder",
      role: "coder",
      goal: "Test error recovery",
      workspaceId: "ws-1",
      workspacePath: tmpDir,
      permissions: { read: true, search: true, write: true, executeCommand: true, network: false },
      executionBudget: {
        maxModelTurns: 3,
        maxToolCalls: 5,
        maxContextTokens: 32000,
      },
    });

    expect(result.toolExecutions.length).toBe(2);
    expect(result.toolExecutions[0]!.success).toBe(false); // First tool failed
    expect(result.toolExecutions[1]!.success).toBe(true);  // Second tool succeeded
    expect(result.filesChanged).toContain("created.txt");
  });
});
