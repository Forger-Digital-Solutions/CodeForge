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
  ProviderCapacityGovernor,
} from "@codeforge/providers";
import { EventStore, createSessionPersistence } from "@codeforge/sessions";
import { createAgentRuntime } from "../src/agent-runtime.js";

/**
 * R23 finding: `executeAgentRun` built its model-execution adapter without the runtime's injected
 * capacity governor, so an explicitly supplied governor (the R23 harness's instrumented proxy, or
 * any per-runtime configuration) was bypassed on the autonomous path and pacing silently ran on
 * the module singleton — every Groq run record read `pacingWaitMs: 0` with 60 s gaps between
 * calls. The injected governor must be the one that admits autonomous model calls.
 */
class OneTurnProvider implements ProviderAdapter {
  readonly providerId = "test-provider";
  readonly isTestProvider = true;
  async listModels(): Promise<ProviderModel[]> {
    return [{ modelId: "free-model-1", displayName: "Free", isFree: true, freeStatus: "verified_free", capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true } }];
  }
  async chat(_req: ChatRequest): Promise<ChatResponse> { throw new Error("Use streamChat"); }
  async *streamChat(_req: ChatRequest): AsyncIterable<StreamEvent> {
    yield { type: "text_delta", delta: "Nothing to do; the task is already complete." };
    yield { type: "usage", usage: { inputTokens: 40, outputTokens: 12 } };
    yield { type: "finish", finishReason: "stop" };
  }
  async healthCheck() { return { status: "available" as const }; }
}

describe("autonomous run — capacity governor injection", () => {
  let tmpDir: string;
  let persistence: ReturnType<typeof createSessionPersistence>;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cf-governor-injection-"));
    persistence = createSessionPersistence();
  });
  afterEach(async () => {
    persistence.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("admits autonomous model calls through the injected governor, not the module singleton", async () => {
    const acquired: string[] = [];
    const governor = new ProviderCapacityGovernor();
    const instrumented: ProviderCapacityGovernor = new Proxy(governor, {
      get(target, property, receiver) {
        if (property === "acquire") {
          return async (...args: Parameters<ProviderCapacityGovernor["acquire"]>) => {
            acquired.push(String(args[0]));
            return target.acquire(...args);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(receiver) : value;
      },
    });
    const firewall = new ForgeZero();
    firewall.register(createGenericFreeRecord({ providerId: "test-provider", modelId: "free-model-1" }));
    const catalog = new InMemoryProviderCatalog();
    catalog.register(new OneTurnProvider());
    const runtime = createAgentRuntime({
      sessionId: "governor-injection",
      eventStore: new EventStore(),
      persistence,
      firewall,
      providerCatalog: catalog,
      workspacePath: tmpDir,
      capacityGovernor: instrumented,
    });
    runtime.setModelSelection({ providerId: "test-provider", modelId: "free-model-1", lock: "route" });
    const result = await runtime.executeAgentRun({
      runId: "run-governor-injection",
      agentId: "coder",
      role: "coder",
      goal: "Confirm the workspace needs no change.",
      workspaceId: "ws-1",
      workspacePath: tmpDir,
      permissions: { read: true, search: true, write: false, executeCommand: false, network: false },
      modelSelection: { providerId: "test-provider", modelId: "free-model-1" },
    });
    expect(result.usage.requestCount).toBeGreaterThan(0);
    expect(acquired.length).toBeGreaterThan(0);
    expect(acquired.every((providerId) => providerId === "test-provider")).toBe(true);
  });
});
