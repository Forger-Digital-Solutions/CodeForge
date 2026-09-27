import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { EightBitRouteHealthAuthority, DEFAULT_ROUTE_HEALTH_POLICY } from "@codeforge/eight-bit";
import { createAgentRuntime } from "../src/agent-runtime.js";
import { createSubagentManager } from "../src/subagent-manager.js";
import { createWorkspaceEventAdapter } from "../src/workspace-event-adapter.js";

class EscapeProvider implements ProviderAdapter {
  readonly providerId: string;
  readonly isTestProvider = true;
  requests = 0;
  constructor(providerId: string, private readonly escapeArgs: string) {
    this.providerId = providerId;
  }
  async listModels(): Promise<ProviderModel[]> {
    return [{
      modelId: "default",
      displayName: "Scripted Fleet Model",
      isFree: true,
      freeStatus: "verified_free",
      capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true },
    }];
  }
  async chat(_req: ChatRequest): Promise<ChatResponse> {
    throw new Error("Use streamChat");
  }
  async *streamChat(): AsyncIterable<StreamEvent> {
    this.requests++;
    const id = `esc-${this.requests}`;
    yield { type: "tool_call_started", toolCallId: id, toolName: "read_file" };
    yield { type: "tool_call_delta", toolCallId: id, delta: this.escapeArgs };
    yield { type: "tool_call_completed", toolCallId: id, toolName: "read_file", arguments: this.escapeArgs };
    yield { type: "finish", finishReason: "tool_calls" };
  }
  async healthCheck() {
    return { status: "available" as const };
  }
}

describe("R50 tool-safety feedback (§9, §26)", () => {
  let ws: string;
  let eventStore: EventStore;
  let persistence: ReturnType<typeof createSessionPersistence>;
  let firewall: ForgeZero;
  let authority: EightBitRouteHealthAuthority;

  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), "cf-r50-safety-"));
    await writeFile(join(ws, "note.txt"), "fixture");
    eventStore = new EventStore();
    persistence = createSessionPersistence({ dbPath: ":memory:" });
    firewall = new ForgeZero();
    authority = new EightBitRouteHealthAuthority(DEFAULT_ROUTE_HEALTH_POLICY);
    persistence.upsertSession({
      id: "sess-r50-safe", title: "R50 Safety", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: "idle",
    });
  });

  afterEach(async () => {
    persistence.close();
    await rm(ws, { recursive: true, force: true });
  });

  async function runExplorer(provider: EscapeProvider, parentRunId: string) {
    const catalog = new InMemoryProviderCatalog();
    catalog.register(provider);
    const runtime = createAgentRuntime({
      sessionId: "sess-r50-safe", eventStore, persistence, firewall, providerCatalog: catalog,
      workspacePath: ws, routeHealth: authority,
    });
    const adapter = createWorkspaceEventAdapter({ sessionId: "sess-r50-safe", eventStore, persistence });
    const manager = createSubagentManager({ persistence, agentRuntime: runtime, r1Enabled: true });
    return manager.spawnChildAgent({
      parentRunId, sessionId: "sess-r50-safe", agentId: "explorer",
      task: "Map the fixture workspace", workspacePath: ws, structuredOutput: "explorer",
    });
  }

  it("a workspace-escape tool call is rejected, produces boundary+security evidence, and blocks the run", async () => {
    firewall.register(createGenericFreeRecord({ providerId: "fleet-esc", modelId: "model-esc", displayName: "escape model" }));
    const provider = new EscapeProvider("fleet-esc", JSON.stringify({ path: "/" }));

    const result = await runExplorer(provider, "run-r50-esc");

    // Fail-closed: the escape proposal never executes and the run cannot complete.
    expect(result.status).toBe("blocked");
    expect(result.summary + (result as { error?: string }).error ?? "").toContain("WORKSPACE_ESCAPE");

    // Tool lane: a boundary_violation landed on the served route.
    const assessment = authority.assess("fleet-esc", "model-esc", { role: "EXPLORER" });
    expect(assessment.reasonCodes.concat(assessment.activeConditions.map((c) => c.reasonCode)).join("|")).toMatch(/TOOL|MALFORMED|QUARANTIN|BOUNDARY|CAPABILITY/i);

    // Role lane: security_blocked evidence with the escape class — the heaviest single sample.
    const evidence = authority.roleEvidenceFor("fleet-esc", "model-esc", "EXPLORER");
    expect(evidence.length).toBe(1);
    expect(evidence[0]!.outcome).toBe("security_blocked");
    expect(evidence[0]!.failureClass).toBe("WORKSPACE_ESCAPE_ATTEMPT");
    const delta = authority.roleQualityDelta("fleet-esc", "model-esc", "EXPLORER");
    expect(delta.scoreAdjustment).toBeLessThan(0);

    // Cross-role isolation: CODER evidence is unaffected by an EXPLORER escape.
    expect(authority.roleEvidenceFor("fleet-esc", "model-esc", "CODER")).toEqual([]);
  });

  it("two consecutive escape proposals quarantine the route (double-weight streak)", async () => {
    firewall.register(createGenericFreeRecord({ providerId: "fleet-esc2", modelId: "model-esc2", displayName: "escape model 2" }));
    const provider = new EscapeProvider("fleet-esc2", JSON.stringify({ path: "/" }));

    await runExplorer(provider, "run-r50-esc2a");
    await runExplorer(provider, "run-r50-esc2b");

    const assessment = authority.assess("fleet-esc2", "model-esc2", { role: "EXPLORER" });
    expect(assessment.state).toBe("QUARANTINED");
  });

  it("a parent-directory escape proposal is refused the same way", async () => {
    firewall.register(createGenericFreeRecord({ providerId: "fleet-esc3", modelId: "model-esc3", displayName: "escape model 3" }));
    const provider = new EscapeProvider("fleet-esc3", JSON.stringify({ path: "../../outside.txt" }));

    const result = await runExplorer(provider, "run-r50-esc3");

    expect(result.status).toBe("blocked");
    const evidence = authority.roleEvidenceFor("fleet-esc3", "model-esc3", "EXPLORER");
    expect(evidence[0]?.outcome).toBe("security_blocked");
  });
});
