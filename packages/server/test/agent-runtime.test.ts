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
import { createAgentRuntime, AgentRuntime } from "../src/agent-runtime.js";
import { ERROR_CODES } from "@codeforge/agent";

class DeterministicScriptedProvider implements ProviderAdapter {
  readonly providerId: string;
  readonly isTestProvider = true;
  private responses: Array<(req: ChatRequest) => AsyncIterable<StreamEvent>>;
  private callCount = 0;

  constructor(providerId: string, responses: Array<(req: ChatRequest) => AsyncIterable<StreamEvent>>) {
    this.providerId = providerId;
    this.responses = responses;
  }

  async listModels(): Promise<ProviderModel[]> {
    return [
      {
        modelId: "scripted-free",
        displayName: "Scripted Free Model",
        isFree: true,
        freeStatus: "verified_free",
        capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true },
      },
    ];
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    throw new Error("Use streamChat");
  }

  async *streamChat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    const handler = this.responses[this.callCount] ?? this.responses[this.responses.length - 1];
    this.callCount++;
    if (!handler) {
      yield { type: "text_delta", delta: "Default response" };
      yield { type: "finish", finishReason: "stop" };
      return;
    }
    for await (const ev of handler(req)) {
      if (signal?.aborted) return;
      yield ev;
    }
  }

  async healthCheck() {
    return { status: "available" as const };
  }
}

describe("AgentRuntime — Production Invocation & Lifecycle Certification (CF-07)", () => {
  let tmpDir: string;
  let persistence: ReturnType<typeof createSessionPersistence>;
  let eventStore: EventStore;
  let firewall: ForgeZero;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cf-runtime-test-"));
    persistence = createSessionPersistence();
    eventStore = new EventStore();
    firewall = new ForgeZero();
    firewall.register(createGenericFreeRecord());
  });

  afterEach(async () => {
    persistence.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("executes a standalone Explorer run that discovers files and returns structured advisory findings", async () => {
    // Setup workspace file
    await fs.writeFile(path.join(tmpDir, "index.ts"), "export const codeforge = 'autonomous';", "utf-8");

    const catalog = new InMemoryProviderCatalog();
    const provider = new DeterministicScriptedProvider("test-provider", [
      // Turn 1: Model calls list_files
      async function* () {
        yield { type: "tool_call_started", toolCallId: "tc-1", toolName: "list_files" };
        yield { type: "tool_call_delta", toolCallId: "tc-1", delta: JSON.stringify({ path: "." }) };
        yield { type: "tool_call_completed", toolCallId: "tc-1", toolName: "list_files", arguments: JSON.stringify({ path: "." }) };
        yield { type: "usage", usage: { inputTokens: 50, outputTokens: 20 } };
        yield { type: "finish", finishReason: "tool_calls" };
      },
      // Turn 2: Model finishes with exploration summary
      async function* () {
        yield { type: "text_delta", delta: "Exploration completed. Found index.ts as main entry point." };
        yield { type: "usage", usage: { inputTokens: 100, outputTokens: 30 } };
        yield { type: "finish", finishReason: "stop" };
      },
    ]);
    catalog.register(provider);

    const runtime = createAgentRuntime({
      sessionId: "test-session",
      eventStore,
      persistence,
      firewall,
      providerCatalog: catalog,
      workspacePath: tmpDir,
    });

    const result = await runtime.executeAgentRun({
      runId: "run-explorer-1",
      agentId: "explorer",
      role: "explorer",
      goal: "Map entry points",
      workspaceId: "ws-1",
      workspacePath: tmpDir,
      permissions: { read: true, search: true, write: false, executeCommand: false, network: false },
    });

    expect(result.status).toBe("completed");
    expect(result.stopReason).toBe("completed");
    expect(result.toolExecutions.length).toBe(1);
    expect(result.toolExecutions[0]!.toolName).toBe("list_files");
    expect(result.toolExecutions[0]!.success).toBe(true);
    expect(result.findings.length).toBeGreaterThanOrEqual(1);
    expect(result.findings[0]!.severity).toBe("advisory");
    expect(result.usage.requestCount).toBe(2);
    expect(result.usage.toolCount).toBe(1);
  });

  it("executes a standalone Coder run that edits files and tracks modified files accurately", async () => {
    const srcFile = path.join(tmpDir, "calculator.ts");
    await fs.writeFile(srcFile, "export function add(a: number, b: number) { return a - b; }", "utf-8");

    const catalog = new InMemoryProviderCatalog();
    const provider = new DeterministicScriptedProvider("test-provider", [
      // Turn 1: Model reads file
      async function* () {
        yield { type: "tool_call_started", toolCallId: "tc-read", toolName: "read_file" };
        yield { type: "tool_call_completed", toolCallId: "tc-read", toolName: "read_file", arguments: JSON.stringify({ path: "calculator.ts" }) };
        yield { type: "usage", usage: { inputTokens: 40, outputTokens: 15 } };
        yield { type: "finish", finishReason: "tool_calls" };
      },
      // Turn 2: Model edits file
      async function* () {
        yield { type: "tool_call_started", toolCallId: "tc-edit", toolName: "edit_file" };
        yield {
          type: "tool_call_completed",
          toolCallId: "tc-edit",
          toolName: "edit_file",
          arguments: JSON.stringify({ path: "calculator.ts", oldText: "return a - b;", newText: "return a + b;" }),
        };
        yield { type: "usage", usage: { inputTokens: 80, outputTokens: 30 } };
        yield { type: "finish", finishReason: "tool_calls" };
      },
      // Turn 3: Model concludes
      async function* () {
        yield { type: "text_delta", delta: "Fixed add function to perform addition." };
        yield { type: "usage", usage: { inputTokens: 120, outputTokens: 25 } };
        yield { type: "finish", finishReason: "stop" };
      },
    ]);
    catalog.register(provider);

    const runtime = createAgentRuntime({
      sessionId: "test-session",
      eventStore,
      persistence,
      firewall,
      providerCatalog: catalog,
      workspacePath: tmpDir,
    });

    const result = await runtime.executeAgentRun({
      runId: "run-coder-1",
      agentId: "coder",
      role: "coder",
      goal: "Fix calculator add bug",
      workspaceId: "ws-1",
      workspacePath: tmpDir,
      permissions: { read: true, search: true, write: true, executeCommand: true, network: false },
    });

    expect(result.status).toBe("completed");
    expect(result.filesChanged).toContain("calculator.ts");
    const updatedContent = await fs.readFile(srcFile, "utf-8");
    expect(updatedContent).toContain("return a + b;");
  });

  it("handles Reviewer run using validated findings rather than prose", async () => {
    const catalog = new InMemoryProviderCatalog();
    const provider = new DeterministicScriptedProvider("test-provider", [
      async function* () {
        yield { type: "text_delta", delta: JSON.stringify({ verdict: "revision_required", findings: [{ id: "syntax", severity: "blocking", category: "correctness", message: "Syntax error in main.ts", evidence: "main.ts:4" }], summary: "A blocking syntax error must be fixed." }) };
        yield { type: "usage", usage: { inputTokens: 60, outputTokens: 30 } };
        yield { type: "finish", finishReason: "stop" };
      },
    ]);
    catalog.register(provider);

    const runtime = createAgentRuntime({
      sessionId: "test-session",
      eventStore,
      persistence,
      firewall,
      providerCatalog: catalog,
      workspacePath: tmpDir,
    });

    const result = await runtime.executeAgentRun({
      runId: "run-reviewer-1",
      agentId: "reviewer",
      role: "reviewer",
      goal: "Review diff",
      workspaceId: "ws-1",
      workspacePath: tmpDir,
      permissions: { read: true, search: true, write: false, executeCommand: false, network: false },
      diff: "+ export broken syntax {",
      verificationEvidence: "SyntaxError: Unexpected token",
      structuredOutput: "reviewer",
    });

    expect(result.status).toBe("blocked");
    expect(result.findings.some((f) => f.severity === "blocking")).toBe(true);
    expect(result.structuredData).toMatchObject({ verdict: "revision_required" });
  });

  it("repairs malformed structured Planner output once, then returns typed data", async () => {
    const catalog = new InMemoryProviderCatalog();
    catalog.register(new DeterministicScriptedProvider("test-provider", [
      async function* () { yield { type: "text_delta", delta: "not json" }; yield { type: "finish", finishReason: "stop" }; },
      async function* () { yield { type: "text_delta", delta: JSON.stringify({ summary: "Implement safely", tasks: [{ id: "code", title: "Code", objective: "Implement change", dependencies: [], assignedRole: "coder" }] }) }; yield { type: "finish", finishReason: "stop" }; },
    ]));
    const runtime = createAgentRuntime({ sessionId: "test-session", eventStore, persistence, firewall, providerCatalog: catalog, workspacePath: tmpDir });
    const result = await runtime.executeAgentRun({
      runId: "run-planner-repair", agentId: "planner", role: "planner", goal: "Plan change", workspaceId: "ws-1", workspacePath: tmpDir,
      permissions: { read: true, search: true, write: false, executeCommand: false, network: false }, structuredOutput: "planner",
    });
    expect(result.status).toBe("completed");
    expect(result.usage.requestCount).toBe(2);
    expect(result.structuredData).toMatchObject({ summary: "Implement safely", tasks: [{ id: "code", assignedRole: "coder" }] });
  });

  it("fails closed after bounded malformed structured output repairs", async () => {
    const catalog = new InMemoryProviderCatalog();
    catalog.register(new DeterministicScriptedProvider("test-provider", [
      async function* () { yield { type: "text_delta", delta: "{\"verdict\":\"pass\"}" }; yield { type: "finish", finishReason: "stop" }; },
    ]));
    const runtime = createAgentRuntime({ sessionId: "test-session", eventStore, persistence, firewall, providerCatalog: catalog, workspacePath: tmpDir });
    const result = await runtime.executeAgentRun({
      runId: "run-review-invalid", agentId: "reviewer", role: "reviewer", goal: "Review", workspaceId: "ws-1", workspacePath: tmpDir,
      permissions: { read: true, search: true, write: false, executeCommand: false, network: false }, structuredOutput: "reviewer", maxStructuredOutputRepairs: 0,
    });
    expect(result.status).toBe("blocked");
    expect(result.error).toBe(ERROR_CODES.AGENT_INVALID_STRUCTURED_OUTPUT);
  });

  it("propagates cancellation immediately when AbortSignal is triggered", async () => {
    const catalog = new InMemoryProviderCatalog();
    const abortController = new AbortController();

    const provider = new DeterministicScriptedProvider("test-provider", [
      async function* () {
        abortController.abort();
        yield { type: "text_delta", delta: "Partial text" };
        yield { type: "finish", finishReason: "stop" };
      },
    ]);
    catalog.register(provider);

    const runtime = createAgentRuntime({
      sessionId: "test-session",
      eventStore,
      persistence,
      firewall,
      providerCatalog: catalog,
      workspacePath: tmpDir,
    });

    const result = await runtime.executeAgentRun({
      runId: "run-cancel-1",
      agentId: "coder",
      role: "coder",
      goal: "Cancel test",
      workspaceId: "ws-1",
      workspacePath: tmpDir,
      permissions: { read: true, search: true, write: true, executeCommand: true, network: false },
      signal: abortController.signal,
    });

    expect(result.status).toBe("cancelled");
    expect(result.stopReason).toBe("cancelled");
  });

  it("fails closed when an exact model request is unavailable (no silent substitution)", async () => {
    const catalog = new InMemoryProviderCatalog();
    const runtime = createAgentRuntime({
      sessionId: "test-session",
      eventStore,
      persistence,
      firewall,
      providerCatalog: catalog,
      workspacePath: tmpDir,
    });

    const result = await runtime.executeAgentRun({
      runId: "run-exact-fail",
      agentId: "coder",
      role: "coder",
      goal: "Exact model test",
      workspaceId: "ws-1",
      workspacePath: tmpDir,
      permissions: { read: true, search: true, write: true, executeCommand: true, network: false },
      modelSelection: { providerId: "nonexistent-provider", modelId: "gpt-5-pro" },
    });

    expect(result.status).toBe("failed");
    expect(result.error).toContain(ERROR_CODES.PROVIDER_MODEL_UNAVAILABLE);
  });
});
