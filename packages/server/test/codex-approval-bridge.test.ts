import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ForgeZero, createGenericFreeRecord } from "@codeforge/forge-zero";
import {
  InMemoryProviderCatalog,
  type ChatRequest,
  type ChatResponse,
  type ProviderAdapter,
  type ProviderExecutionContext,
  type ProviderModel,
  type ProviderToolExecutionRequest,
  type ProviderToolExecutionResult,
  type StreamEvent,
} from "@codeforge/providers";
import { EventStore, createSessionPersistence } from "@codeforge/sessions";
import { createAgentRuntime, type AgentRuntime } from "../src/agent-runtime.js";

class CodexBridgeFixture implements ProviderAdapter {
  readonly providerId = "codex-account";
  readonly isTestProvider = true;
  runtime?: AgentRuntime;
  lastResult?: ProviderToolExecutionResult;
  streamStarts = 0;

  async listModels(): Promise<ProviderModel[]> {
    return [{
      modelId: "default",
      displayName: "Codex fixture",
      isFree: true,
      freeStatus: "verified_free",
      capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true },
    }];
  }

  async chat(_req: ChatRequest): Promise<ChatResponse> {
    throw new Error("Use streamChatWithContext");
  }

  async streamChat(_req: ChatRequest): Promise<ChatResponse> {
    throw new Error("Context-aware stream was not used");
  }

  async *streamChatWithContext(
    _req: ChatRequest,
    context: ProviderExecutionContext,
    signal?: AbortSignal,
  ): AsyncIterable<StreamEvent> {
    this.streamStarts += 1;
    if (!this.runtime || !signal) throw new Error("Fixture runtime is unavailable");
    const request: ProviderToolExecutionRequest = {
      ...context,
      providerId: this.providerId,
      processSessionId: "process-r6",
      providerThreadId: "codex-thread-r6",
      providerTurnId: "codex-turn-r6",
      serverRequestId: "server-request-r6",
      toolCallId: "tool-call-r6",
      namespace: "codeforge",
      toolName: "write_file",
      arguments: { path: "approved.txt", content: "executed once" },
      signal,
    };
    this.lastResult = await this.runtime.executeProviderTool(request);
    yield { type: "text_delta", delta: this.lastResult.output };
    yield { type: "finish", finishReason: "stop" };
  }

  async healthCheck() {
    return { status: "available" as const };
  }
}

async function waitFor<T>(read: () => T | undefined, message: string): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

describe("Codex dynamic-tool approval bridge", () => {
  let workspacePath: string;
  let persistence: ReturnType<typeof createSessionPersistence>;
  let runtime: AgentRuntime;
  let fixture: CodexBridgeFixture;
  let firewall: ForgeZero;

  beforeEach(async () => {
    workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "codeforge-codex-bridge-"));
    persistence = createSessionPersistence();
    const model = createGenericFreeRecord();
    model.providerId = "codex-account";
    model.modelId = "default";
    model.capabilities.toolCalling = true;
    firewall = new ForgeZero();
    firewall.register(model);
    fixture = new CodexBridgeFixture();
    const catalog = new InMemoryProviderCatalog();
    catalog.register(fixture);
    runtime = createAgentRuntime({
      sessionId: "session-r6",
      eventStore: new EventStore(),
      persistence,
      firewall,
      providerCatalog: catalog,
      workspacePath,
    });
    fixture.runtime = runtime;
    runtime.setModelSelection({ providerId: "codex-account", modelId: "default" });
  });

  afterEach(async () => {
    persistence.close();
    await fs.rm(workspacePath, { recursive: true, force: true });
  });

  it("persists full correlation and executes exactly once only after approval", async () => {
    await runtime.startTurn("Create the approved file");
    const approval = await waitFor(
      () => runtime.getApprovalService().getAllPending()[0],
      "Codex bridge approval was not created",
    );
    expect(runtime.getAllPendingApprovals().map((item) => item.approvalId)).toEqual([approval.approvalId]);
    await expect(fs.stat(path.join(workspacePath, "approved.txt"))).rejects.toThrow();
    const stored = await persistence.getWorkItem(approval.approvalId);
    expect(stored).toMatchObject({
      kind: "approval",
      correlation: {
        providerId: "codex-account",
        processSessionId: "process-r6",
        codeForgeSessionId: "session-r6",
        codeForgeTurnId: approval.turnId,
        providerThreadId: "codex-thread-r6",
        providerTurnId: "codex-turn-r6",
        serverRequestId: "server-request-r6",
        providerToolCallId: "tool-call-r6",
        intendedAction: "write_file",
      },
    });
    await runtime.resolveApproval(approval.approvalId, "allow_once");
    await waitFor(() => fixture.lastResult, "Approved Codex tool did not finish");
    expect(fixture.lastResult).toMatchObject({ success: true });
    expect(await fs.readFile(path.join(workspacePath, "approved.txt"), "utf8")).toBe("executed once");
  });

  it("does not execute after denial", async () => {
    await runtime.startTurn("Attempt a denied file write");
    const approval = await waitFor(
      () => runtime.getApprovalService().getAllPending()[0],
      "Codex bridge approval was not created",
    );
    await runtime.resolveApproval(approval.approvalId, "deny");
    await waitFor(() => fixture.lastResult, "Denied Codex tool did not settle");
    expect(fixture.lastResult).toMatchObject({ success: false });
    await expect(fs.stat(path.join(workspacePath, "approved.txt"))).rejects.toThrow();
  });

  it("cancels the pending bridge operation with its CodeForge turn", async () => {
    const turnId = await runtime.startTurn("Attempt a cancelled file write");
    await waitFor(
      () => runtime.getApprovalService().getAllPending()[0],
      "Codex bridge approval was not created",
    );
    await runtime.cancelTurn(turnId, "test cancellation");
    await waitFor(() => fixture.lastResult, "Cancelled Codex tool did not settle");
    expect(fixture.lastResult).toMatchObject({ success: false });
    await expect(fs.stat(path.join(workspacePath, "approved.txt"))).rejects.toThrow();
  });

  it("revalidates an exact Codex pin at execution time without automatic substitution", async () => {
    firewall.unregister("codex-account", "default");
    const turnId = await runtime.startTurn("Do not substitute another provider");
    const failed = await waitFor(
      () => runtime.getTurn(turnId)?.status === "failed" ? runtime.getTurn(turnId) : undefined,
      "Unavailable exact Codex turn did not fail",
    );
    expect(failed?.error).toContain("Exact model codex-account::default is no longer registered");
    expect(fixture.streamStarts).toBe(0);
  });
});
