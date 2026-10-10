import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ForgeZero, createGenericFreeRecord } from "@codeforge/forge-zero";
import { InMemoryProviderCatalog, type ChatRequest, type ProviderAdapter, type StreamEvent } from "@codeforge/providers";
import { EventStore, createSessionPersistence } from "@codeforge/sessions";
import { ROLE_QUALIFICATION_SUITE_VERSION, type ModelQualificationReceipt } from "@codeforge/eight-bit";
import type { FreeCloudRoutingHooks } from "@codeforge/model-registry";
import { createAgentRuntime } from "../src/agent-runtime.js";

async function plan(toolQualified: boolean, unexpectedTool = false) {
  const workspace = await mkdtemp(join(tmpdir(), "r74-planner-"));
  const requests: ChatRequest[] = [];
  const provider: ProviderAdapter = {
    providerId: "planner-provider", isTestProvider: true,
    listModels: async () => [], chat: async () => { throw new Error("stream only"); }, healthCheck: async () => ({ status: "available" }),
    async *streamChat(request): AsyncIterable<StreamEvent> {
      requests.push(request);
      if (unexpectedTool) { yield { type: "tool_call_completed", toolCallId: "unexpected", toolName: "read_file", arguments: '{"path":"source.mjs"}' }; yield { type: "finish", finishReason: "tool_calls" }; }
      else { yield { type: "text_delta", delta: JSON.stringify({ protocol: "task_graph_v1", summary: "Repair the boundary then review", tasks: [{ id: "C", title: "Repair", objective: "Fix the supplied boundary", dependencies: [], assignedRole: "coder" }, { id: "R", title: "Review", objective: "Review and verify the fix", dependencies: ["C"], assignedRole: "reviewer" }] }) }; yield { type: "finish", finishReason: "stop" }; }
    },
  };
  const firewall = new ForgeZero();
  firewall.register(createGenericFreeRecord({ providerId: provider.providerId, modelId: "planner-model", contextWindow: 128_000 }));
  const catalog = new InMemoryProviderCatalog(); catalog.register(provider);
  const at = new Date().toISOString();
  const role = (name: "PLANNER" | "TOOL_AGENT", qualified: boolean) => ({ role: name, status: qualified ? "QUALIFIED" as const : "NOT_TESTED" as const, testCases: [], hardFailures: [], startedAt: at, completedAt: at });
  const receipt: ModelQualificationReceipt = { suiteVersion: ROLE_QUALIFICATION_SUITE_VERSION, providerId: provider.providerId, modelId: "planner-model", modelDisplayName: "Planner", accessClass: "FREE_ROUTED", freeStatus: "verified_free", roleResults: { PLANNER: role("PLANNER", true), TOOL_AGENT: role("TOOL_AGENT", toolQualified) }, startedAt: at, completedAt: at, totalLatencyMs: 1, qualificationState: "QUALIFIED", hardFailureRoles: [] };
  const freeCloud: FreeCloudRoutingHooks = { isForgeAutoEligible: () => true, canonicalIdOf: () => "planner-model", sameModelAlternates: () => [], recordRouteFailure: () => undefined, recordRouteSuccess: () => undefined, quotaRemaining: () => undefined, capacityRoutingAdvice: () => ({ scoreAdjustment: 0, reasonCodes: [] }), getQualificationReceipt: () => receipt };
  const persistence = createSessionPersistence({ dbPath: ":memory:" });
  const runtime = createAgentRuntime({ sessionId: "planner-session", workspacePath: workspace, eventStore: new EventStore(), persistence, firewall, providerCatalog: catalog, freeCloud });
  try {
    const result = await runtime.executeAgentRun({ runId: "planner-run", agentId: "planner", role: "planner", goal: "Plan the supplied boundary fix", workspaceId: "isolated", workspacePath: workspace, permissions: { read: true, search: true, write: false, executeCommand: false, network: false }, structuredOutput: "planner", roleRouting: true });
    return { result, requests };
  } finally { await runtime.shutdown(); await persistence.close(); await rm(workspace, { recursive: true, force: true }); }
}

describe("R74 measured Planner tool protocol", () => {
  it("uses the qualified no-tools planning protocol", async () => {
    const { result, requests } = await plan(false);
    expect(result.status).toBe("completed");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.tools ?? []).toEqual([]);
    expect(requests[0]?.toolChoice).toBe("none");
  });
  it("blocks unexpected tools without execution or a manufactured plan", async () => {
    const { result } = await plan(false, true);
    expect(result.status).not.toBe("completed");
    expect(result.summary).toContain("PLANNER_TOOL_PROTOCOL_UNQUALIFIED");
    expect(result.toolExecutions).toEqual([]);
    expect(result.structuredData).toBeUndefined();
  });
  it("retains tools for a separately qualified Tool Agent", async () => {
    const { result, requests } = await plan(true);
    expect(result.status).toBe("completed");
    expect(requests[0]?.tools?.length).toBeGreaterThan(0);
  });
});
