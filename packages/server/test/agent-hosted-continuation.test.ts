import { describe, expect, it } from "vitest";
import { ForgeZero, createGenericFreeRecord } from "@codeforge/forge-zero";
import { createDesktopWorkerBridge, createDurableAgentContinuationStore, createSessionPersistence, EventStore, type ISessionPersistence, type WorkItem } from "@codeforge/sessions";
import { InMemoryProviderCatalog, type ChatMessage, type ChatRequest, type ChatResponse, type ProviderAdapter, type ProviderModel, type StreamEvent } from "@codeforge/providers";
import { createAgentRuntime } from "../src/agent-runtime.js";

class RestartScriptedProvider implements ProviderAdapter {
  readonly providerId = "codeforge";
  readonly isTestProvider = true;
  readonly requests: ChatRequest[] = [];
  private readonly model: ProviderModel = {
    modelId: "free-model-1",
    displayName: "Deterministic free model",
    isFree: true,
    freeStatus: "verified_free",
    capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: false, longContext: true },
  };

  async listModels(): Promise<ProviderModel[]> { return [this.model]; }
  async chat(_req: ChatRequest): Promise<ChatResponse> { throw new Error("stream only"); }
  async healthCheck() { return { status: "available" as const }; }

  async *streamChat(request: ChatRequest, _signal?: AbortSignal): AsyncIterable<StreamEvent> {
    this.requests.push({ ...request, messages: [...request.messages] });
    const observations = request.messages.filter((message): message is ChatMessage & { role: "tool" } => message.role === "tool");
    if (observations.length === 0) {
      yield { type: "tool_call_started", toolCallId: "tool-a", toolName: "read_file" };
      yield { type: "tool_call_completed", toolCallId: "tool-a", toolName: "read_file", arguments: JSON.stringify({ path: "src/a.ts" }) };
      yield { type: "finish", finishReason: "tool_calls" };
      return;
    }
    if (observations.length === 1) {
      yield { type: "tool_call_started", toolCallId: "tool-b", toolName: "read_file" };
      yield { type: "tool_call_completed", toolCallId: "tool-b", toolName: "read_file", arguments: JSON.stringify({ path: "src/a.ts" }) };
      yield { type: "finish", finishReason: "tool_calls" };
      return;
    }
    yield { type: "text_delta", delta: "verified final response" };
    yield { type: "finish", finishReason: "stop" };
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for hosted runtime state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function makeWorkflow(persistence: ISessionPersistence, workflowId: string, sessionId: string): Promise<void> {
  const now = new Date().toISOString();
  await persistence.upsertSession({ id: sessionId, title: "restart", createdAt: now, updatedAt: now, status: "running" });
  await persistence.upsertWorkItem({
    kind: "hosted_workflow",
    id: workflowId,
    sessionId,
    ownerUserId: "user-a",
    workerId: "worker-a",
    workspaceId: "workspace-a",
    revision: 0,
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
}

async function completeWorkerResult(persistence: ISessionPersistence, actionId: string, output: string): Promise<void> {
  const bridge = createDesktopWorkerBridge(persistence);
  const store = createDurableAgentContinuationStore(persistence);
  await bridge.recordResult({ actionId, workerId: "worker-a", status: "succeeded", output, changedResources: [] });
  await store.markResultAvailable(actionId);
  const action = await persistence.getWorkItem(actionId);
  if (!action || action.kind !== "desktop_worker_action") throw new Error("worker action disappeared");
  const workflow = await persistence.getWorkItem(action.workflowId);
  if (!workflow || workflow.kind !== "hosted_workflow") throw new Error("workflow disappeared");
  await persistence.upsertWorkItem({ ...workflow, status: "active", updatedAt: new Date().toISOString() });
}

async function makeSuspendedFixture(): Promise<{
  persistence: ISessionPersistence;
  provider: RestartScriptedProvider;
  runtime: ReturnType<typeof createAgentRuntime>;
  workflowId: string;
  turnId: string;
  continuation: Extract<WorkItem, { kind: "agent_continuation" }>;
}> {
  const persistence = createSessionPersistence({ dbPath: ":memory:" });
  await persistence.init();
  const eventStore = new EventStore();
  const firewall = new ForgeZero();
  firewall.register(createGenericFreeRecord());
  const provider = new RestartScriptedProvider();
  const catalog = new InMemoryProviderCatalog();
  catalog.register(provider);
  const sessionId = `hosted-boundary-${crypto.randomUUID()}`;
  const workflowId = `hosted-boundary-workflow-${crypto.randomUUID()}`;
  await makeWorkflow(persistence, workflowId, sessionId);
  const runtime = createAgentRuntime({ sessionId, eventStore, persistence, firewall, providerCatalog: catalog, userId: "user-a", hostedWorker: { workflowId, workerId: "worker-a", autoResume: false } });
  const turnId = await runtime.startTurn("inspect and fix");
  await waitFor(() => runtime.getTurn(turnId)?.status === "waiting_for_worker");
  const item = (await persistence.getWorkItemsByKind("agent_continuation")).find((candidate) => candidate.kind === "agent_continuation");
  if (!item || item.kind !== "agent_continuation") throw new Error("suspended continuation missing");
  return { persistence, provider, runtime, workflowId, turnId, continuation: item };
}

describe("AgentRuntime durable hosted continuation", () => {
  it("suspends, survives runtime destruction, resumes the canonical observation path, and suspends again", async () => {
    const persistence = createSessionPersistence({ dbPath: ":memory:" });
    await persistence.init();
    const eventStore = new EventStore();
    const firewall = new ForgeZero();
    firewall.register(createGenericFreeRecord());
    const provider = new RestartScriptedProvider();
    const catalog = new InMemoryProviderCatalog();
    catalog.register(provider);
    const sessionId = "hosted-restart-session";
    const workflowId = "hosted-restart-workflow";
    await makeWorkflow(persistence, workflowId, sessionId);

    const runtimeA = createAgentRuntime({ sessionId, eventStore, persistence, firewall, providerCatalog: catalog, userId: "user-a", hostedWorker: { workflowId, workerId: "worker-a", autoResume: false, resumeLeaseMs: 50 } });
    const turnId = await runtimeA.startTurn("inspect and fix");
    await waitFor(() => runtimeA.getTurn(turnId)?.status === "waiting_for_worker");
    const first = (await persistence.getWorkItemsByKind("agent_continuation")).find((item) => item.kind === "agent_continuation");
    expect(first?.kind).toBe("agent_continuation");
    if (!first || first.kind !== "agent_continuation") throw new Error("first continuation missing");
    expect(first.state).toBe("awaiting_worker");
    expect(provider.requests).toHaveLength(1);

    await completeWorkerResult(persistence, first.pendingTool.actionId, "contents A");
    await createDesktopWorkerBridge(persistence).recordResult({ actionId: first.pendingTool.actionId, workerId: "worker-a", status: "succeeded", output: "replayed result must be ignored", changedResources: [] });
    const runtimeCrash = createAgentRuntime({ sessionId, eventStore: new EventStore(), persistence, firewall, providerCatalog: catalog, userId: "user-a", hostedWorker: { workflowId, workerId: "worker-a", autoResume: false, resumeLeaseMs: 20, afterResultClaim: async () => { throw new Error("injected claim crash"); } } });
    await expect(runtimeCrash.resumeAgentContinuation(first.id)).rejects.toThrow("injected claim crash");
    await new Promise((resolve) => setTimeout(resolve, 30));
    const runtimeB = createAgentRuntime({ sessionId, eventStore: new EventStore(), persistence, firewall, providerCatalog: catalog, userId: "user-a", hostedWorker: { workflowId, workerId: "worker-a", resumeLeaseMs: 50 } });
    await runtimeB.init();
    await waitFor(() => provider.requests.length === 2);
    expect(runtimeA === runtimeB).toBe(false);
    expect(provider.requests[1]?.messages.filter((message) => message.role === "tool")).toHaveLength(1);
    const second = (await persistence.getWorkItemsByKind("agent_continuation"))
      .find((item) => item.kind === "agent_continuation" && item.id !== first.id);
    expect(second?.kind).toBe("agent_continuation");
    if (!second || second.kind !== "agent_continuation") throw new Error("second continuation missing");
    expect(second.pendingTool.toolCallId).toBe("tool-b");

    await completeWorkerResult(persistence, second.pendingTool.actionId, "write complete");
    const runtimeCrashAfterObservation = createAgentRuntime({ sessionId, eventStore: new EventStore(), persistence, firewall, providerCatalog: catalog, userId: "user-a", hostedWorker: { workflowId, workerId: "worker-a", autoResume: false, resumeLeaseMs: 20, afterObservationPersisted: async () => { throw new Error("injected observation crash"); } } });
    await expect(runtimeCrashAfterObservation.resumeAgentContinuation(second.id)).rejects.toThrow("injected observation crash");
    await new Promise((resolve) => setTimeout(resolve, 30));
    const runtimeC = createAgentRuntime({ sessionId, eventStore: new EventStore(), persistence, firewall, providerCatalog: catalog, userId: "user-a", hostedWorker: { workflowId, workerId: "worker-a", autoResume: false, resumeLeaseMs: 50 } });
    const completed = await runtimeC.resumeAgentContinuation(second.id);
    expect(completed).toEqual({ kind: "completed" });
    expect(provider.requests[2]?.messages.filter((message) => message.role === "tool")).toHaveLength(2);
    const allContinuations = (await persistence.getWorkItemsByKind("agent_continuation")) as Array<Extract<WorkItem, { kind: "agent_continuation" }>>;
    expect(allContinuations.find((item) => item.id === first.id)?.messages.filter((message) => message.role === "tool")).toHaveLength(1);
    expect(allContinuations.find((item) => item.id === second.id)?.messages.filter((message) => message.role === "tool")).toHaveLength(2);
    expect((await persistence.getWorkItemsByKind("desktop_worker_action"))).toHaveLength(2);
    expect((await persistence.getTurn(turnId))?.status).toBe("completed");
    await persistence.close();
  });

  it("blocks stale revisions and does not resurrect a cancelled suspension", async () => {
    const stale = await makeSuspendedFixture();
    const workflow = await stale.persistence.getWorkItem(stale.workflowId);
    if (!workflow || workflow.kind !== "hosted_workflow") throw new Error("workflow missing");
    await stale.persistence.upsertWorkItem({ ...workflow, revision: workflow.revision + 1, updatedAt: new Date().toISOString() });
    await completeWorkerResult(stale.persistence, stale.continuation.pendingTool.actionId, "stale result");
    const staleRuntime = createAgentRuntime({ sessionId: stale.continuation.sessionId, eventStore: new EventStore(), persistence: stale.persistence, firewall: (() => { const value = new ForgeZero(); value.register(createGenericFreeRecord()); return value; })(), providerCatalog: (() => { const value = new InMemoryProviderCatalog(); value.register(stale.provider); return value; })(), userId: "user-a", hostedWorker: { workflowId: stale.workflowId, workerId: "worker-a", autoResume: false } });
    await expect(staleRuntime.resumeAgentContinuation(stale.continuation.id)).resolves.toMatchObject({ kind: "failed", reason: "stale_workflow_revision" });
    expect((await stale.persistence.getTurn(stale.turnId))?.status).toBe("blocked");
    expect(stale.provider.requests).toHaveLength(1);
    await stale.persistence.close();

    const cancelled = await makeSuspendedFixture();
    await cancelled.runtime.cancelTurn(cancelled.turnId, "cancelled in test");
    await completeWorkerResult(cancelled.persistence, cancelled.continuation.pendingTool.actionId, "late result");
    const lateRuntime = createAgentRuntime({ sessionId: cancelled.continuation.sessionId, eventStore: new EventStore(), persistence: cancelled.persistence, firewall: (() => { const value = new ForgeZero(); value.register(createGenericFreeRecord()); return value; })(), providerCatalog: (() => { const value = new InMemoryProviderCatalog(); value.register(cancelled.provider); return value; })(), userId: "user-a", hostedWorker: { workflowId: cancelled.workflowId, workerId: "worker-a", autoResume: false } });
    await expect(lateRuntime.resumeAgentContinuation(cancelled.continuation.id)).resolves.toMatchObject({ kind: "cancelled", reason: "cancelled" });
    expect((await cancelled.persistence.getTurn(cancelled.turnId))?.status).toBe("cancelled");
    expect(cancelled.provider.requests).toHaveLength(1);
    await cancelled.persistence.close();
  });
});
