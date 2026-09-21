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

/**
 * R23 finding: on the autonomous path a pinned (explicit) model selection had zero per-turn fault
 * tolerance — `roleRouteRotatable` was false, so every model-turn failure was rethrown before
 * 8-Bit could offer a bounded same-route retry. Live Groq runs died in whichever phase the first
 * provider-rejected tool call or short 429 landed (REVIEWER_FAILED). A pinned route must recover
 * from a retryable, model-side failure exactly as an 8-Bit-routed one does — and must never rotate.
 */
class FlakyThenFineProvider implements ProviderAdapter {
  readonly providerId = "test-provider";
  readonly isTestProvider = true;
  calls = 0;
  constructor(private readonly failures: number, private readonly failure: Extract<StreamEvent, { type: "error" }>) {}
  async listModels(): Promise<ProviderModel[]> {
    return [{ modelId: "free-model-1", displayName: "Free", isFree: true, freeStatus: "verified_free", capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true } }];
  }
  async chat(_req: ChatRequest): Promise<ChatResponse> { throw new Error("Use streamChat"); }
  async *streamChat(_req: ChatRequest): AsyncIterable<StreamEvent> {
    this.calls += 1;
    if (this.calls <= this.failures) {
      yield this.failure;
      return;
    }
    yield { type: "text_delta", delta: "Done: nothing to change." };
    yield { type: "usage", usage: { inputTokens: 40, outputTokens: 8 } };
    yield { type: "finish", finishReason: "stop" };
  }
  async healthCheck() { return { status: "available" as const }; }
}

describe("autonomous run — pinned route recovery", () => {
  let tmpDir: string;
  let persistence: ReturnType<typeof createSessionPersistence>;
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cf-pinned-recovery-"));
    persistence = createSessionPersistence();
  });
  afterEach(async () => {
    persistence.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function runPinned(provider: FlakyThenFineProvider) {
    const firewall = new ForgeZero();
    firewall.register(createGenericFreeRecord({ providerId: "test-provider", modelId: "free-model-1" }));
    const catalog = new InMemoryProviderCatalog();
    catalog.register(provider);
    const runtime = createAgentRuntime({ sessionId: "pinned-recovery", eventStore: new EventStore(), persistence, firewall, providerCatalog: catalog, workspacePath: tmpDir });
    runtime.setModelSelection({ providerId: "test-provider", modelId: "free-model-1", lock: "route" });
    return runtime.executeAgentRun({
      runId: "run-pinned-recovery",
      agentId: "coder",
      role: "coder",
      goal: "Confirm the workspace needs no change.",
      workspaceId: "ws-1",
      workspacePath: tmpDir,
      permissions: { read: true, search: true, write: false, executeCommand: false, network: false },
      modelSelection: { providerId: "test-provider", modelId: "free-model-1" },
    });
  }

  it("retries a provider-rejected tool call on the same pinned route and completes", async () => {
    const provider = new FlakyThenFineProvider(1, { type: "error", code: "INVALID_TOOL_OUTPUT", message: "groq stream error (tool_use_failed) after HTTP 200: Tool call validation failed: attempted to call tool 'json' which was not in request.tools", retryable: true, status: 400 });
    const result = await runPinned(provider);
    expect(result.status).toBe("completed");
    expect(provider.calls).toBe(2);
    expect(result.usage.provider).toBe("test-provider");
  });

  it("waits out a short per-minute 429 on the pinned route instead of failing the run", async () => {
    const provider = new FlakyThenFineProvider(1, { type: "error", code: "RATE_LIMITED", message: "groq error (429): Rate limit reached for model `openai/gpt-oss-20b` on tokens per minute (TPM): Limit 8000, Used 5229, Requested 2811. Please try again in 1.5s.", retryable: true, status: 429, retryAfter: Date.now() + 1_500 });
    const result = await runPinned(provider);
    expect(result.status).toBe("completed");
    expect(provider.calls).toBe(2);
  });

  it("still surfaces a failure that keeps recurring past the bounded retry budget", async () => {
    const provider = new FlakyThenFineProvider(10, { type: "error", code: "INVALID_TOOL_OUTPUT", message: "groq stream error (tool_use_failed) after HTTP 200: Tool call validation failed", retryable: true, status: 400 });
    const result = await runPinned(provider);
    expect(result.status).toBe("failed");
    expect(provider.calls).toBeLessThanOrEqual(5);
  });
});
