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
import { EventStore, createSessionPersistence, ForgeGreenCacheStore } from "@codeforge/sessions";
import { createAgentRuntime } from "../src/agent-runtime.js";
import { ERROR_CODES } from "@codeforge/agent";

type Responder = (req: ChatRequest) => AsyncIterable<StreamEvent>;

class RecordingScriptedProvider implements ProviderAdapter {
  readonly providerId: string;
  readonly isTestProvider = true;
  private readonly responders: Responder[];
  public requests: ChatRequest[] = [];

  constructor(providerId: string, responders: Responder[]) {
    this.providerId = providerId;
    this.responders = responders;
  }

  get calls(): number {
    return this.requests.length;
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

  async chat(_req: ChatRequest): Promise<ChatResponse> {
    throw new Error("Use streamChat");
  }

  async *streamChat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    this.requests.push(req);
    const responder = this.responders[Math.min(this.requests.length - 1, this.responders.length - 1)];
    if (!responder) {
      yield { type: "text_delta", delta: "No scripted response" };
      yield { type: "finish", finishReason: "stop" };
      return;
    }
    for await (const event of responder(req)) {
      if (signal?.aborted) return;
      yield event;
    }
  }

  async healthCheck() {
    return { status: "available" as const };
  }
}

function toolCallTurn(toolCallId: string, name: string, args: Record<string, unknown>, usage?: { cachedInputTokens?: number }): Responder {
  return async function* () {
    yield { type: "tool_call_started", toolCallId, toolName: name };
    yield { type: "tool_call_delta", toolCallId, delta: JSON.stringify(args) };
    yield { type: "tool_call_completed", toolCallId, toolName: name, arguments: JSON.stringify(args) };
    yield { type: "usage", usage: { inputTokens: 100, outputTokens: 20, ...(usage?.cachedInputTokens !== undefined ? { cachedInputTokens: usage.cachedInputTokens } : {}) } };
    yield { type: "finish", finishReason: "tool_calls" };
  };
}

function finalTurn(text: string, usage?: { cachedInputTokens?: number }): Responder {
  return async function* () {
    yield { type: "text_delta", delta: text };
    yield { type: "usage", usage: { inputTokens: 100, outputTokens: 20, ...(usage?.cachedInputTokens !== undefined ? { cachedInputTokens: usage.cachedInputTokens } : {}) } };
    yield { type: "finish", finishReason: "stop" };
  };
}

describe("FG-1 runtime efficiency integration", () => {
  let tmpDir: string;
  let persistence: ReturnType<typeof createSessionPersistence>;
  let eventStore: EventStore;
  let firewall: ForgeZero;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "fg1-runtime-"));
    persistence = createSessionPersistence();
    eventStore = new EventStore();
    firewall = new ForgeZero();
    firewall.register(createGenericFreeRecord());
    await fs.writeFile(path.join(tmpDir, "index.ts"), "export const codeforge = 'autonomous';\n", "utf-8");
  });

  afterEach(async () => {
    persistence.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("suppresses identical read-only actions against unchanged state (three-identity rotation) and escalates the no-progress loop", async () => {
    // The CF-07 text-fingerprint detector cannot catch this pattern: three distinct read-only
    // identities rotate (rA, lB, sC, rA, lB, sC, ...), so no two consecutive fingerprints are
    // identical and the history never forms the certified X-Y oscillation shape. FG-1C's
    // canonical-identity detection is what bounds it.
    const provider = new RecordingScriptedProvider("test-provider", [
      toolCallTurn("tc-1", "read_file", { path: "index.ts" }),
      toolCallTurn("tc-2", "list_files", { path: "." }),
      toolCallTurn("tc-3", "repo_search", { query: "codeforge", limit: 5 }),
      toolCallTurn("tc-4", "read_file", { path: "index.ts" }),
      toolCallTurn("tc-5", "list_files", { path: "." }),
      toolCallTurn("tc-6", "read_file", { path: "index.ts" }),
      finalTurn("unreachable"),
    ]);
    const catalog = new InMemoryProviderCatalog();
    catalog.register(provider);
    const runtime = createAgentRuntime({ sessionId: "fg1-suppress", eventStore, persistence, firewall, providerCatalog: catalog, workspacePath: tmpDir });

    const result = await runtime.executeAgentRun({
      runId: "fg1-run-suppress",
      agentId: "explorer",
      role: "explorer",
      goal: "Read the same things repeatedly",
      workspaceId: "ws-fg1",
      workspacePath: tmpDir,
      permissions: { read: true, search: true, write: false, executeCommand: false, network: false },
    });

    expect(result.status).toBe("blocked");
    expect(result.stopReason).toBe("no_progress_detected");
    expect(result.error).toBe(ERROR_CODES.AGENT_NO_PROGRESS_DETECTED);
    // Three physical executions (first read, first listing, first search); the repeats
    // against unchanged state were suppressed and the third read request escalated.
    expect(result.toolExecutions).toHaveLength(3);
    expect(provider.calls).toBe(6);
    expect(result.contextMetrics?.efficiencyReceipt?.duplicateActionsSuppressed).toBe(2);
    expect(result.contextMetrics?.efficiencyReceipt?.noProgressInterruptions).toBe(1);
    // The suppressed replay carried the prior authoritative result to the model.
    const turn6ToolMessages = provider.requests[5]!.messages.filter((message) => message.role === "tool");
    expect(turn6ToolMessages.some((message) => message.content.includes("duplicate read-only action suppressed"))).toBe(true);
    // The ledger records the suppressed dispatches and the interruption, observationally.
    const ledgers = await persistence.getWorkItemsByKind("forgegreen_ledger");
    expect(ledgers).toHaveLength(1);
    const record = (ledgers[0] as unknown as { record: { totals: { duplicateActionsSuppressed: number; noProgressInterruptions: number; avoidedToolDispatches: number } } }).record;
    expect(record.totals.duplicateActionsSuppressed).toBe(2);
    expect(record.totals.avoidedToolDispatches).toBe(2);
    expect(record.totals.noProgressInterruptions).toBe(1);
  });

  it("executes a legitimate rerun after a real state change, and starts every run with a fresh supervisor", async () => {
    const read = () => toolCallTurn(`tc-read-${Math.random()}`, "read_file", { path: "index.ts" });
    const provider = new RecordingScriptedProvider("test-provider", [
      read(),
      toolCallTurn("tc-write", "write_file", { path: "index.ts", content: "export const codeforge = 'mutated';\n" }),
      read(),
      finalTurn("done"),
    ]);
    const catalog = new InMemoryProviderCatalog();
    catalog.register(provider);
    const runtime = createAgentRuntime({ sessionId: "fg1-rerun", eventStore, persistence, firewall, providerCatalog: catalog, workspacePath: tmpDir });

    const first = await runtime.executeAgentRun({
      runId: "fg1-run-rerun",
      agentId: "coder",
      role: "coder",
      goal: "Read, mutate, reread",
      workspaceId: "ws-fg1",
      workspacePath: tmpDir,
      permissions: { read: true, search: true, write: true, executeCommand: false, network: false },
    });
    expect(first.status).toBe("completed");
    expect(first.toolExecutions.filter((execution) => execution.toolName === "read_file")).toHaveLength(2);
    expect(first.contextMetrics?.efficiencyReceipt?.duplicateActionsSuppressed).toBeUndefined();

    // A new run never inherits suppression state: identical reads execute again.
    const provider2 = new RecordingScriptedProvider("test-provider", [read(), finalTurn("done")]);
    const catalog2 = new InMemoryProviderCatalog();
    catalog2.register(provider2);
    const runtime2 = createAgentRuntime({ sessionId: "fg1-rerun-2", eventStore, persistence, firewall, providerCatalog: catalog2, workspacePath: tmpDir });
    const second = await runtime2.executeAgentRun({
      runId: "fg1-run-rerun-2",
      agentId: "explorer",
      role: "explorer",
      goal: "Fresh run",
      workspaceId: "ws-fg1",
      workspacePath: tmpDir,
      permissions: { read: true, search: true, write: false, executeCommand: false, network: false },
    });
    expect(second.status).toBe("completed");
    expect(second.toolExecutions).toHaveLength(1);
  });

  it("compresses large repetitive tool output for model context while preserving the authoritative raw result", async () => {
    const repetitive = Array.from({ length: 400 }, (_, i) => `PASS suite ${i % 3} case executed successfully without anomalies`).join("\n");
    await fs.writeFile(path.join(tmpDir, "big.log.ts"), `${repetitive}\n`, "utf-8");
    const provider = new RecordingScriptedProvider("test-provider", [
      toolCallTurn("tc-1", "read_file", { path: "big.log.ts" }),
      finalTurn("read complete"),
    ]);
    const catalog = new InMemoryProviderCatalog();
    catalog.register(provider);
    const runtime = createAgentRuntime({ sessionId: "fg1-compress", eventStore, persistence, firewall, providerCatalog: catalog, workspacePath: tmpDir });

    const result = await runtime.executeAgentRun({
      runId: "fg1-run-compress",
      agentId: "explorer",
      role: "explorer",
      goal: "Read the big log",
      workspaceId: "ws-fg1",
      workspacePath: tmpDir,
      permissions: { read: true, search: true, write: false, executeCommand: false, network: false },
    });

    expect(result.status).toBe("completed");
    const execution = result.toolExecutions[0]!;
    expect(execution.success).toBe(true);
    expect(execution.compression).toBeDefined();
    expect(execution.compression!.compressedBytes).toBeLessThan(execution.compression!.originalBytes);
    // Authoritative raw artifact keeps every line.
    expect(execution.output).toContain("PASS suite 2 case executed successfully without anomalies");
    expect(execution.output.split("\n").length).toBeGreaterThanOrEqual(400);
    // The model-context representation is materially smaller and provenance-marked.
    const toolMessage = provider.requests[1]!.messages.find((message) => message.role === "tool");
    expect(toolMessage?.content).toContain("[forgegreen tool-output compression:");
    expect(Buffer.byteLength(toolMessage?.content ?? "", "utf8")).toBeLessThan(Buffer.byteLength(execution.output, "utf8"));
    expect(result.contextMetrics?.efficiencyReceipt?.toolOutputBytesAvoided).toBeGreaterThan(0);
    const ledgers = await persistence.getWorkItemsByKind("forgegreen_ledger");
    expect(ledgers).toHaveLength(1);
  });

  it("reports provider prompt-cache telemetry when measured and nothing when absent", async () => {
    const provider = new RecordingScriptedProvider("test-provider", [
      toolCallTurn("tc-1", "list_files", { path: "." }, { cachedInputTokens: 512 }),
      finalTurn("done", { cachedInputTokens: 128 }),
    ]);
    const catalog = new InMemoryProviderCatalog();
    catalog.register(provider);
    const runtime = createAgentRuntime({ sessionId: "fg1-cache-tel", eventStore, persistence, firewall, providerCatalog: catalog, workspacePath: tmpDir });
    const measured = await runtime.executeAgentRun({
      runId: "fg1-run-tel-1",
      agentId: "explorer",
      role: "explorer",
      goal: "List",
      workspaceId: "ws-fg1",
      workspacePath: tmpDir,
      permissions: { read: true, search: true, write: false, executeCommand: false, network: false },
    });
    expect(measured.usage.cachedTokens).toBe(640);
    expect(measured.contextMetrics?.efficiencyReceipt?.promptCacheAccounting).toBe("provider_reported");
    expect(measured.contextMetrics?.efficiencyReceipt?.providerCachedInputTokens).toBe(640);

    const providerNoTelemetry = new RecordingScriptedProvider("test-provider", [toolCallTurn("tc-1", "list_files", { path: "." }), finalTurn("done")]);
    const catalogNoTelemetry = new InMemoryProviderCatalog();
    catalogNoTelemetry.register(providerNoTelemetry);
    const runtimeNoTelemetry = createAgentRuntime({ sessionId: "fg1-cache-tel-2", eventStore, persistence, firewall, providerCatalog: catalogNoTelemetry, workspacePath: tmpDir });
    const unmeasured = await runtimeNoTelemetry.executeAgentRun({
      runId: "fg1-run-tel-2",
      agentId: "explorer",
      role: "explorer",
      goal: "List",
      workspaceId: "ws-fg1",
      workspacePath: tmpDir,
      permissions: { read: true, search: true, write: false, executeCommand: false, network: false },
    });
    expect(unmeasured.usage.cachedTokens).toBeUndefined();
    expect(unmeasured.contextMetrics?.efficiencyReceipt?.promptCacheAccounting).toBe("unavailable");
  });

  it("reuses canonical repository analysis across runs with identical content and recomputes when content changes", async () => {
    // The cache store lives outside the workspace, exactly like the production placement
    // beside the session database — an in-workspace store would pollute repository indexing.
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "fg1-cache-dir-"));
    const cacheStore = await ForgeGreenCacheStore.open(path.join(cacheDir, "fg-cache.db"));
    try {
      const makeProvider = (tag: string) =>
        new RecordingScriptedProvider("test-provider", [
          toolCallTurn("tc-1", "repo_search", { query: "codeforge", limit: 5 }),
          finalTurn(`searched ${tag}`),
        ]);
      const catalog1 = new InMemoryProviderCatalog();
      catalog1.register(makeProvider("one"));
      const runtime1 = createAgentRuntime({ sessionId: "fg1-cache-run1", eventStore, persistence, firewall, providerCatalog: catalog1, workspacePath: tmpDir, forgeGreenCacheStore: cacheStore });
      const run1 = await runtime1.executeAgentRun({
        runId: "fg1-cache-1",
        agentId: "explorer",
        role: "explorer",
        goal: "Find codeforge references",
        workspaceId: "ws-fg1",
        workspacePath: tmpDir,
        permissions: { read: true, search: true, write: false, executeCommand: false, network: false },
      });
      expect(run1.status).toBe("completed");
      expect(run1.contextMetrics?.efficiencyReceipt?.canonicalCacheMisses).toBeGreaterThanOrEqual(1);

      const catalog2 = new InMemoryProviderCatalog();
      catalog2.register(makeProvider("two"));
      const runtime2 = createAgentRuntime({ sessionId: "fg1-cache-run2", eventStore, persistence, firewall, providerCatalog: catalog2, workspacePath: tmpDir, forgeGreenCacheStore: cacheStore });
      const run2 = await runtime2.executeAgentRun({
        runId: "fg1-cache-2",
        agentId: "explorer",
        role: "explorer",
        goal: "Find codeforge references again",
        workspaceId: "ws-fg1",
        workspacePath: tmpDir,
        permissions: { read: true, search: true, write: false, executeCommand: false, network: false },
      });
      expect(run2.status).toBe("completed");
      expect(run2.contextMetrics?.efficiencyReceipt?.canonicalCacheHits).toBeGreaterThanOrEqual(1);
      // Cached result equals the fresh result (deterministic analysis).
      const cachedExecution = run2.toolExecutions[0]!;
      const freshExecution = run1.toolExecutions[0]!;
      expect(cachedExecution.output).toBe(freshExecution.output);

      // Change the content → the stale analysis must not be reused.
      await fs.writeFile(path.join(tmpDir, "index.ts"), "export const codeforge = 'changed-content';\nexport const extra = 1;\n", "utf-8");
      const catalog3 = new InMemoryProviderCatalog();
      catalog3.register(makeProvider("three"));
      const runtime3 = createAgentRuntime({ sessionId: "fg1-cache-run3", eventStore, persistence, firewall, providerCatalog: catalog3, workspacePath: tmpDir, forgeGreenCacheStore: cacheStore });
      const run3 = await runtime3.executeAgentRun({
        runId: "fg1-cache-3",
        agentId: "explorer",
        role: "explorer",
        goal: "Find codeforge references after change",
        workspaceId: "ws-fg1",
        workspacePath: tmpDir,
        permissions: { read: true, search: true, write: false, executeCommand: false, network: false },
      });
      expect(run3.status).toBe("completed");
      expect(run3.contextMetrics?.efficiencyReceipt?.canonicalCacheMisses).toBeGreaterThanOrEqual(1);
    } finally {
      await cacheStore.close();
      await fs.rm(cacheDir, { recursive: true, force: true });
    }
  });
});
