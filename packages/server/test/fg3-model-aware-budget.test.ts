import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ForgeZero, createGenericFreeRecord } from "@codeforge/forge-zero";
import { EventStore, createSessionPersistence, type ISessionPersistence } from "@codeforge/sessions";
import { InMemoryProviderCatalog, type ChatRequest, type ChatResponse, type ProviderAdapter, type ProviderModel, type StreamEvent } from "@codeforge/providers";
import { createAgentRuntime } from "../src/agent-runtime.js";

/**
 * FG-3E: 8-Bit decides which model serves a role; FG-3 decides how much context fits into it.
 * These scenarios prove `AgentRuntimeRequest.modelSelection`'s catalog-declared `contextWindow`
 * actually reaches the resolved budget — never fabricated when absent, never exceeded when an
 * exact pin is small, never gratuitously expanded just because a model could hold more.
 */
class StructuredOutputProvider implements ProviderAdapter {
  readonly isTestProvider = true;
  constructor(readonly providerId: string) {}
  async listModels(): Promise<ProviderModel[]> {
    return [{ modelId: "m", displayName: "M", isFree: true, freeStatus: "verified_free", capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true } }];
  }
  async chat(): Promise<ChatResponse> {
    throw new Error("use streamChat");
  }
  async *streamChat(): AsyncIterable<StreamEvent> {
    yield { type: "text_delta", delta: JSON.stringify({ summary: "bounded exploration", findings: [], evidence: [] }) };
    yield { type: "finish", finishReason: "stop" };
  }
  async healthCheck() {
    return { status: "available" as const };
  }
}

describe("FG-3E model-aware context budget — end to end through executeAgentRun", () => {
  let tmpDir: string;
  let persistence: ISessionPersistence;
  let eventStore: EventStore;
  let firewall: ForgeZero;
  let catalog: InMemoryProviderCatalog;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "fg3-budget-e2e-"));
    persistence = createSessionPersistence({ dbPath: ":memory:" });
    await persistence.init();
    eventStore = new EventStore();
    firewall = new ForgeZero();
    catalog = new InMemoryProviderCatalog();
  });

  afterEach(async () => {
    await persistence.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function run(providerId: string, modelId: string, contextWindow: number | undefined, executionBudget?: { maxContextTokens: number }) {
    firewall.register(createGenericFreeRecord({ providerId, modelId, displayName: modelId, contextWindow }));
    const provider = new StructuredOutputProvider(providerId);
    catalog.register(provider);
    const runtime = createAgentRuntime({ sessionId: `s-${providerId}`, eventStore, persistence, firewall, providerCatalog: catalog, workspacePath: tmpDir });
    return runtime.executeAgentRun({
      runId: `r-${providerId}`,
      agentId: "explorer",
      role: "explorer",
      goal: "Investigate",
      workspaceId: `ws-${providerId}`,
      workspacePath: tmpDir,
      permissions: { read: true, search: true, write: false, executeCommand: false, network: false },
      structuredOutput: "explorer",
      modelSelection: { providerId, modelId },
      ...(executionBudget ? { executionBudget: { maxModelTurns: 5, maxToolCalls: 5, maxContextTokens: executionBudget.maxContextTokens } } : {}),
    });
  }

  it("[small-model fit] a route with a small declared context window clamps the resolved budget down to it", async () => {
    const result = await run("provider-small", "small-model", 6_000);
    expect(result.contextMetrics?.contextMaximum).toBe(6_000);
  });

  it("[unknown capacity] a route with no declared context window keeps the safe role default, never fabricating a number", async () => {
    const result = await run("provider-unknown", "unknown-model", undefined);
    expect(result.contextMetrics?.contextMaximum).toBe(64_000); // DEFAULT_EXECUTION_BUDGETS.explorer
  });

  it("[large-model no gratuitous expansion] a route with a huge declared context window does not inflate the budget beyond what was requested", async () => {
    const result = await run("provider-large", "large-model", 2_000_000, { maxContextTokens: 20_000 });
    expect(result.contextMetrics?.contextMaximum).toBe(20_000);
  });

  it("[exact-pin insufficient capacity] a real, tiny exact-pinned context window still completes safely rather than crashing", async () => {
    // Small enough that the coder-role planner's narrow budget calc is tight, but the explorer
    // role (used here) does not route through the planner and has a genuinely small kernel, so
    // this proves graceful handling rather than a crash — not that every role fits every size.
    const result = await run("provider-tiny", "tiny-model", 2_000);
    expect(result.contextMetrics?.contextMaximum).toBe(2_000);
    expect(result.status).toBe("completed");
  });
});
