import { describe, it, expect, afterAll } from "vitest";
import { ForgeZero, createGenericFreeRecord } from "@codeforge/forge-zero";
import {
  type ProviderAdapter,
  type ProviderModel,
  type ChatRequest,
  type ChatResponse,
  type StreamEvent,
  InMemoryProviderCatalog,
  ProviderCapacityGovernor,
} from "@codeforge/providers";
import { EventStore, createSessionPersistence } from "@codeforge/sessions";
import { createAgentRuntime } from "../src/agent-runtime.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createLease, createTaskAuthority } from "@codeforge/permissions";

class RecordingProvider implements ProviderAdapter {
  readonly providerId = "boundary-provider";
  readonly isTestProvider = true;
  readonly requests: ChatRequest[] = [];

  async listModels(): Promise<ProviderModel[]> {
    return [{
      modelId: "boundary-model",
      displayName: "Boundary Model",
      isFree: true,
      freeStatus: "verified_free",
      capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true },
    }];
  }

  async chat(_request: ChatRequest): Promise<ChatResponse> {
    throw new Error("Use streamChat");
  }

  async *streamChat(request: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    this.requests.push(structuredClone(request));
    if (signal?.aborted) return;
    yield { type: "text_delta", delta: request.messages.at(-1)?.content.includes("second") ? "second answer" : "first answer" };
    yield { type: "finish", finishReason: "stop" };
  }

  async healthCheck() { return { status: "available" as const }; }
}

class ToolThenSilentProvider extends RecordingProvider {
  private calls = 0;

  override async *streamChat(request: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    this.requests.push(structuredClone(request));
    if (signal?.aborted) return;
    this.calls += 1;
    if (this.calls === 1) {
      yield { type: "tool_call_started", toolCallId: "list-root", toolName: "list_files" };
      yield { type: "tool_call_completed", toolCallId: "list-root", toolName: "list_files", arguments: JSON.stringify({ path: "." }) };
      yield { type: "finish", finishReason: "tool_calls" };
      return;
    }
    yield { type: "finish", finishReason: "stop" };
  }
}

describe("AgentRuntime durable turn boundaries", () => {
  const persistence = createSessionPersistence();
  const eventStore = new EventStore();

  afterAll(async () => {
    await persistence.close();
  });

  it("isolates model history per turn and persists the final response", async () => {
    const provider = new RecordingProvider();
    const catalog = new InMemoryProviderCatalog();
    catalog.register(provider);
    const firewall = new ForgeZero();
    firewall.register(createGenericFreeRecord({ providerId: provider.providerId, modelId: "boundary-model" }));
    const capacityGovernor = new ProviderCapacityGovernor({
      limits: { [provider.providerId]: { maxTokensPerMinute: 100_000, maxRequestsPerMinute: 100, maxConcurrent: 1 } },
    });
    const runtime = createAgentRuntime({
      sessionId: "turn-boundary",
      eventStore,
      persistence,
      firewall,
      providerCatalog: catalog,
      capacityGovernor,
    });
    runtime.setModelSelection({ providerId: provider.providerId, modelId: "boundary-model" });

    const waitForCompletion = async (turnId: string): Promise<void> => {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const turn = await persistence.getTurn(turnId);
        if (turn?.status === "completed") return;
        if (turn?.status === "failed") throw new Error(turn.error ?? "turn failed");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Turn ${turnId} did not complete`);
    };

    const firstTurn = await runtime.startTurn("first request");
    await waitForCompletion(firstTurn);
    const secondTurn = await runtime.startTurn("second request");
    await waitForCompletion(secondTurn);

    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[0]!.messages.some((message) => message.content.includes("first request"))).toBe(true);
    expect(provider.requests[1]!.messages.some((message) => message.content.includes("first request"))).toBe(false);
    expect(provider.requests[1]!.messages.some((message) => message.content.includes("second request"))).toBe(true);
    expect(capacityGovernor.getCapacityReport(provider.providerId).rpmUsed).toBe(2);
    const systemPrompt = provider.requests[0]!.messages.find((message) => message.role === "system")?.content ?? "";
    expect(systemPrompt).toContain("smallest complete change");
    expect(systemPrompt).toContain("stop using tools once the requirements and checks pass");
    expect(systemPrompt).toContain("Execution environment:");
    expect(systemPrompt).toContain(process.platform === "win32" ? "cmd.exe /d /c" : "-c");

    const finalResponse = await persistence.getWorkItem(`agent-final-response-${secondTurn}`);
    expect(finalResponse).toMatchObject({
      kind: "agent_final_response",
      turnId: secondTurn,
      status: "completed",
      response: "second answer",
    });
  });

  it("persists an explicit runtime summary when a verified tool run ends without model prose", async () => {
    const provider = new ToolThenSilentProvider();
    const catalog = new InMemoryProviderCatalog();
    catalog.register(provider);
    const firewall = new ForgeZero();
    firewall.register(createGenericFreeRecord({ providerId: provider.providerId, modelId: "boundary-model" }));
    const runtime = createAgentRuntime({
      sessionId: "turn-boundary-silent-final",
      eventStore,
      persistence,
      firewall,
      providerCatalog: catalog,
    });
    runtime.setModelSelection({ providerId: provider.providerId, modelId: "boundary-model" });

    const turnId = await runtime.startTurn("inspect then finish");
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if ((await persistence.getTurn(turnId))?.status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect((await persistence.getTurn(turnId))?.status).toBe("completed");

    expect(await persistence.getWorkItem(`agent-final-response-${turnId}`)).toMatchObject({
      kind: "agent_final_response",
      turnId,
      status: "completed",
      response: "Completed the requested work.",
      source: "runtime_completion_summary",
    });
  });

  it("persists a final response for direct autonomous runs as well as chat turns", async () => {
    const provider = new ToolThenSilentProvider();
    const catalog = new InMemoryProviderCatalog();
    catalog.register(provider);
    const firewall = new ForgeZero();
    firewall.register(createGenericFreeRecord({ providerId: provider.providerId, modelId: "boundary-model" }));
    const runtime = createAgentRuntime({
      sessionId: "turn-boundary-direct-run",
      eventStore,
      persistence,
      firewall,
      providerCatalog: catalog,
    });
    runtime.setModelSelection({ providerId: provider.providerId, modelId: "boundary-model" });

    const runId = "direct-tool-then-silent";
    const result = await runtime.executeAgentRun({
      runId,
      agentId: "coder",
      role: "coder",
      goal: "Inspect the workspace then finish.",
      workspaceId: "boundary-workspace",
      workspacePath: `${process.cwd()}/packages/server/test/fixtures`,
      permissions: { read: true, search: true, write: false, executeCommand: false, network: false },
    });

    expect(result).toMatchObject({
      status: "completed",
      summary: "Completed the requested work.",
    });
    expect(provider.requests[0]!.messages.find(message => message.role === "system")?.content).toContain("Execution environment:");
    expect(await persistence.getWorkItem(`agent-final-response-${runId}`)).toMatchObject({
      kind: "agent_final_response",
      runId,
      turnId: runId,
      status: "completed",
      response: "Completed the requested work.",
      source: "runtime_completion_summary",
    });
  });

  it("returns an exact post-edit hash that permits a second guarded interactive edit", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "cf-chained-edit-"));
    await fs.writeFile(path.join(workspace, "note.txt"), "alpha beta");
    class ChainedEditsProvider extends RecordingProvider {
      private calls = 0;
      override async *streamChat(request: ChatRequest): AsyncIterable<StreamEvent> {
        this.requests.push(structuredClone(request));
        this.calls++;
        if (this.calls > 3) {
          yield { type: "text_delta", delta: "Finished two guarded edits." };
          yield { type: "finish", finishReason: "stop" };
          return;
        }
        const toolName = this.calls === 1 ? "read_file" : "edit_file";
        const hash = request.messages.at(-1)?.content.match(/\[hash:([a-f0-9]{64})\]/)?.[1];
        const args = this.calls === 1 ? { path: "note.txt" } : {
          path: "note.txt", oldText: this.calls === 2 ? "alpha" : "beta",
          newText: this.calls === 2 ? "first" : "second", expectedHash: hash ?? "missing-full-hash",
        };
        yield { type: "tool_call_started", toolCallId: `edit-chain-${this.calls}`, toolName };
        yield { type: "tool_call_completed", toolCallId: `edit-chain-${this.calls}`, toolName, arguments: JSON.stringify(args) };
        yield { type: "finish", finishReason: "tool_calls" };
      }
    }
    const provider = new ChainedEditsProvider();
    const catalog = new InMemoryProviderCatalog();
    catalog.register(provider);
    const firewall = new ForgeZero();
    firewall.register(createGenericFreeRecord({ providerId: provider.providerId, modelId: "boundary-model" }));
    const authority = createTaskAuthority(createLease({ sessionId: "chained-edit", workspaceRoot: workspace, permissionMode: "auto_review", planMode: "auto" }));
    const runtime = createAgentRuntime({ sessionId: "chained-edit", eventStore, persistence, firewall, providerCatalog: catalog, workspacePath: workspace, authorityFor: () => authority });
    runtime.setModelSelection({ providerId: provider.providerId, modelId: "boundary-model" });
    try {
      const turnId = await runtime.startTurn("Replace alpha with first and beta with second in note.txt.");
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (["completed", "failed"].includes((await persistence.getTurn(turnId))?.status ?? "")) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect((await persistence.getTurn(turnId))?.status).toBe("completed");
      expect(await fs.readFile(path.join(workspace, "note.txt"), "utf8")).toBe("first second");
      const afterFirst = createHash("sha256").update("first beta").digest("hex");
      expect(provider.requests[2]!.messages.at(-1)?.content).toContain(`[hash:${afterFirst}]`);
    } finally {
      await runtime.shutdown();
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it("preserves the eligibility reason when an exact route is temporarily unavailable", async () => {
    const provider = new RecordingProvider();
    const catalog = new InMemoryProviderCatalog();
    catalog.register(provider);
    const firewall = new ForgeZero();
    firewall.register(createGenericFreeRecord({
      providerId: provider.providerId,
      modelId: "boundary-model",
      health: {
        status: "rate_limited",
        lastCheckedAt: new Date().toISOString(),
        retryAfter: Date.now() + 60_000,
      },
    }));
    const runtime = createAgentRuntime({
      sessionId: "turn-boundary-temporarily-ineligible",
      eventStore,
      persistence,
      firewall,
      providerCatalog: catalog,
    });
    runtime.setModelSelection({ providerId: provider.providerId, modelId: "boundary-model" });

    const turnId = await runtime.startTurn("keep the exact selection");
    const deadline = Date.now() + 5_000;
    let turn = await persistence.getTurn(turnId);
    while (Date.now() < deadline && turn?.status !== "failed") {
      await new Promise((resolve) => setTimeout(resolve, 10));
      turn = await persistence.getTurn(turnId);
    }

    expect(turn?.status).toBe("failed");
    expect(turn?.error).toContain("temporarily ineligible");
    expect(turn?.error).toContain("health=rate_limited");
    expect(provider.requests).toHaveLength(0);
  });
});
