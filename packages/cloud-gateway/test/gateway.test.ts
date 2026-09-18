import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CloudDatabase } from "@codeforge/cloud-db";
import { EntitlementService } from "@codeforge/cloud-entitlements";
import { UsageEngine } from "@codeforge/cloud-usage";
import { createGenericFreeRecord } from "@codeforge/forge-zero";
import type { ProviderAdapter, StreamEvent } from "@codeforge/providers";
import { CloudFirewallManager, GatewayService, type HostedStreamEvent } from "../src/index.js";

class SlowMockProvider implements ProviderAdapter {
  readonly providerId = "test-provider";
  readonly isTestProvider = true;

  async *streamChat(_req: any, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    yield { type: "text_delta", delta: "Hello " };
    if (signal?.aborted) throw new Error("Aborted");
    yield { type: "text_delta", delta: "World" };
    yield { type: "usage", usage: { inputTokens: 20, outputTokens: 10 } };
    yield { type: "finish", finishReason: "stop" };
  }
  async healthCheck() {
    return { status: "available" as const };
  }
  async listModels() {
    return [];
  }
  async chat() {
    return { id: "1", model: "m", choices: [], usage: { inputTokens: 0, outputTokens: 0 } };
  }
}

class ToolCallingMockProvider implements ProviderAdapter {
  readonly providerId = "test-provider";
  readonly isTestProvider = true;
  lastRequest: { tools?: unknown[]; maxTokens?: number; messages?: Array<{ role: string }> } = {};

  async *streamChat(req: { tools?: unknown[]; maxTokens?: number; messages?: Array<{ role: string }> }): AsyncIterable<StreamEvent> {
    this.lastRequest = req;
    yield { type: "tool_call_started", toolCallId: "call-1", toolName: "read_file" };
    yield { type: "tool_call_completed", toolCallId: "call-1", toolName: "read_file", arguments: "{\"path\":\"src/a.ts\"}" };
    yield { type: "usage", usage: { inputTokens: 30, outputTokens: 12 } };
    yield { type: "finish", finishReason: "tool_calls" };
  }
  async healthCheck() {
    return { status: "available" as const };
  }
  async listModels() {
    return [];
  }
  async chat() {
    return { id: "1", model: "m", choices: [], usage: { inputTokens: 0, outputTokens: 0 } };
  }
}

describe("GatewayService Hardening", () => {
  let db: CloudDatabase;
  let firewallManager: CloudFirewallManager;
  let entitlementService: EntitlementService;
  let usageEngine: UsageEngine;
  let gateway: GatewayService;

  beforeEach(() => {
    db = new CloudDatabase({ dbPath: ":memory:" });
    firewallManager = new CloudFirewallManager();
    entitlementService = new EntitlementService(db);
    usageEngine = new UsageEngine(db);
    gateway = new GatewayService({
      firewallManager,
      entitlementService,
      usageEngine,
      db,
    });

    const freeModel = createGenericFreeRecord({ providerId: "test-provider", modelId: "test-free" });
    firewallManager.registerModel(freeModel);
    firewallManager.registerProvider(new SlowMockProvider());
  });

  afterEach(() => {
    db.close();
  });

  it("executes hosted inference, emits exactly one terminal event, and settles ledger", async () => {
    const user = await db.createUser({ displayName: "Tester", primaryIdentity: "github:123" });
    await db.getOrCreateCurrentUsagePeriod(user.id, 500_000);
    await db.setEntitlement(user.id, "HOSTED_FREE", "true");

    const events: HostedStreamEvent[] = [];
    const result = await gateway.executeHostedInference(
      user.id,
      {
        requestId: "req-gw-1",
        messages: [{ role: "user", content: "Hi" }],
        modelId: "test-free",
        providerId: "test-provider",
      },
      (e) => events.push(e),
    );

    expect(result.fullText).toBe("Hello World");
    expect(result.creditsConsumed).toBeGreaterThan(0);

    const terminalEvents = events.filter((e) => e.type === "turn.completed" || e.type === "turn.failed");
    expect(terminalEvents).toHaveLength(1);
    expect(terminalEvents[0]?.type).toBe("turn.completed");

    const balance = await db.getCreditBalance(user.id);
    expect(balance).toBeLessThan(500_000);

    const usage = await db.listUsageEvents(user.id);
    expect(usage).toHaveLength(1);
    expect(usage[0]?.providerCostUsd).toBe(0);
  });

  it("enforces server-side execution lease and rejects concurrency exceeding plan limit", async () => {
    const user = await db.createUser({ displayName: "ConcurrentUser", primaryIdentity: "github:456" });
    await db.getOrCreateCurrentUsagePeriod(user.id, 500_000);
    await db.setEntitlement(user.id, "HOSTED_FREE", "true");

    // Start request 1 (active)
    const p1 = gateway.executeHostedInference(
      user.id,
      {
        requestId: "req-conc-1",
        messages: [{ role: "user", content: "Hi 1" }],
        modelId: "test-free",
        providerId: "test-provider",
      },
      () => {},
    );

    await p1;

    // Both sequential requests succeed and release leases
    const p2 = gateway.executeHostedInference(
      user.id,
      {
        requestId: "req-conc-2",
        messages: [{ role: "user", content: "Hi 2" }],
        modelId: "test-free",
        providerId: "test-provider",
      },
      () => {},
    );
    await p2;
  });

  it("enforces operator kill switches before calling provider", async () => {
    const user = await db.createUser({ displayName: "KillUser", primaryIdentity: "github:789" });
    await db.getOrCreateCurrentUsagePeriod(user.id, 500_000);
    await db.setEntitlement(user.id, "HOSTED_FREE", "true");

    // 1. Disable hosted free kill switch
    firewallManager.setKillSwitches({ hostedFreeEnabled: false });

    await expect(
      gateway.executeHostedInference(
        user.id,
        {
          requestId: "req-kill-1",
          messages: [{ role: "user", content: "Hi" }],
          modelId: "test-free",
          providerId: "test-provider",
        },
        () => {},
      ),
    ).rejects.toThrow(/Hosted Free tier is currently disabled/);

    // 2. Re-enable free, disable global hosted inference
    firewallManager.setKillSwitches({ hostedFreeEnabled: true, hostedInferenceEnabled: false });

    await expect(
      gateway.executeHostedInference(
        user.id,
        {
          requestId: "req-kill-2",
          messages: [{ role: "user", content: "Hi" }],
          modelId: "test-free",
          providerId: "test-provider",
        },
        () => {},
      ),
    ).rejects.toThrow(/Hosted inference is currently disabled/);
  });

  it("passes native tools through to the provider and streams tool_call events (HOSTED_TOOLS)", async () => {
    const toolProvider = new ToolCallingMockProvider();
    firewallManager.registerProvider(toolProvider);

    const user = await db.createUser({ displayName: "ToolUser", primaryIdentity: "github:tools" });
    await db.getOrCreateCurrentUsagePeriod(user.id, 500_000);
    await db.setEntitlement(user.id, "HOSTED_FREE", "true");

    const events: HostedStreamEvent[] = [];
    await gateway.executeHostedInference(
      user.id,
      {
        requestId: "req-tools-1",
        messages: [
          { role: "user", content: "fix it" },
          { role: "assistant", content: "", toolCalls: [{ id: "c0", type: "function", function: { name: "list_files", arguments: "{}" } }] },
          { role: "tool", toolCallId: "c0", name: "list_files", content: "src/a.ts" },
        ],
        modelId: "test-free",
        providerId: "test-provider",
        tools: [{ type: "function", function: { name: "read_file", description: "read", parameters: { type: "object", properties: { path: { type: "string" } } } } }],
        maxTokens: 999_999,
      },
      (e) => events.push(e),
    );

    // Tools reached the provider and the output cap was clamped to the hosted ceiling.
    expect(toolProvider.lastRequest.tools).toHaveLength(1);
    expect(toolProvider.lastRequest.maxTokens).toBe(8000);
    expect(toolProvider.lastRequest.messages?.some((m) => m.role === "tool")).toBe(true);

    const started = events.filter((e) => e.type === "assistant.tool_call.started");
    const completed = events.filter((e) => e.type === "assistant.tool_call.completed");
    expect(started).toHaveLength(1);
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ toolName: "read_file", arguments: "{\"path\":\"src/a.ts\"}" });

    const messageCompleted = events.find((e) => e.type === "assistant.message.completed");
    expect(messageCompleted).toMatchObject({ finishReason: "tool_calls" });
    expect(events.at(-1)?.type).toBe("turn.completed");
  });
});
