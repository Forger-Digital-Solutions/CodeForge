import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { ForgeZero, createGenericFreeRecord } from "@codeforge/forge-zero";
import { createDesktopWorkerBridge, createDurableAgentContinuationStore, EventStore, PostgresSessionPersistence, type ISessionPersistence, type WorkItem } from "@codeforge/sessions";
import { InMemoryProviderCatalog, type ChatMessage, type ChatRequest, type ChatResponse, type ProviderAdapter, type ProviderModel, type StreamEvent } from "@codeforge/providers";
import { createAgentRuntime } from "../src/agent-runtime.js";
import { WorkflowService } from "../src/workflow-service.js";

const TEST_PG = process.env.CODEFORGE_TEST_POSTGRES_URL;

class HostedFixtureProvider implements ProviderAdapter {
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
  async chat(_request: ChatRequest): Promise<ChatResponse> { throw new Error("stream only"); }
  async healthCheck() { return { status: "available" as const }; }

  async *streamChat(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.requests.push({ ...request, messages: [...request.messages] });
    const observations = request.messages.filter((message): message is ChatMessage & { role: "tool" } => message.role === "tool");
    if (observations.length === 0) {
      yield { type: "tool_call_started", toolCallId: "inspect-add", toolName: "read_file" };
      yield { type: "tool_call_completed", toolCallId: "inspect-add", toolName: "read_file", arguments: JSON.stringify({ path: "add.js" }) };
      yield { type: "finish", finishReason: "tool_calls" };
      return;
    }
    if (observations.length === 1) {
      yield { type: "tool_call_started", toolCallId: "edit-add", toolName: "edit_file" };
      yield { type: "tool_call_completed", toolCallId: "edit-add", toolName: "edit_file", arguments: JSON.stringify({ path: "add.js", oldText: "a - b", newText: "a + b" }) };
      yield { type: "finish", finishReason: "tool_calls" };
      return;
    }
    yield { type: "text_delta", delta: "Fixed add() and verified the relevant test." };
    yield { type: "finish", finishReason: "stop" };
  }
}

interface Graph {
  persistence: PostgresSessionPersistence;
  service: WorkflowService;
  provider: HostedFixtureProvider;
  workflowEvents: EventStore;
  getRuntime: () => ReturnType<typeof createAgentRuntime> | undefined;
}

async function createGraph(connectionString: string, sessionId: string, ownerUserId: string): Promise<Graph> {
  const persistence = new PostgresSessionPersistence({ connectionString });
  await persistence.init();
  const firewall = new ForgeZero();
  firewall.register(createGenericFreeRecord());
  const provider = new HostedFixtureProvider();
  const catalog = new InMemoryProviderCatalog();
  catalog.register(provider);
  const workflowEvents = new EventStore();
  let runtime: ReturnType<typeof createAgentRuntime> | undefined;
  const service = new WorkflowService({
    eventStore: workflowEvents,
    persistence,
    useRealRuntime: true,
    getOrCreateRuntime: (runtimeSessionId, runtimeUserId) => {
      runtime ??= createAgentRuntime({
        sessionId: runtimeSessionId,
        eventStore: new EventStore(),
        persistence,
        firewall,
        providerCatalog: catalog,
        userId: runtimeUserId ?? ownerUserId,
      });
      return runtime;
    },
  });
  await service.init();
  return { persistence, service, provider, workflowEvents, getRuntime: () => runtime };
}

async function persistWorkerResult(persistence: ISessionPersistence, actionId: string, output: string): Promise<void> {
  const bridge = createDesktopWorkerBridge(persistence);
  const store = createDurableAgentContinuationStore(persistence);
  await bridge.recordResult({ actionId, workerId: "worker-r4", status: "succeeded", output, changedResources: [] });
  await store.markResultAvailable(actionId);
  const action = await persistence.getWorkItem(actionId);
  if (!action || action.kind !== "desktop_worker_action") throw new Error("worker action missing");
  const workflow = await persistence.getWorkItem(action.workflowId);
  if (!workflow || workflow.kind !== "hosted_workflow") throw new Error("hosted workflow missing");
  await persistence.upsertWorkItem({ ...workflow, status: "active", updatedAt: new Date().toISOString() });
}

async function continuation(persistence: ISessionPersistence, workflowId: string): Promise<Extract<WorkItem, { kind: "agent_continuation" }>> {
  const execution = await persistence.getWorkItem(workflowId);
  if (!execution || execution.kind !== "hosted_workflow" || !execution.execution) throw new Error("hosted execution missing");
  const item = await persistence.getWorkItem(execution.execution.continuationId);
  if (!item || item.kind !== "agent_continuation") throw new Error("continuation missing");
  return item;
}

async function waitForApproval(persistence: ISessionPersistence, tool?: string): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const approval = (await persistence.getWorkItemsByKind("approval")).find((item) => item.kind === "approval" && !item.resolvedAt && (!tool || item.tool === tool));
    if (approval?.kind === "approval") return approval.id;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("workflow approval was not persisted");
}

async function waitForApprovalEvent(events: EventStore, sessionId: string, action: string): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const event = events.getBySession(sessionId).find((candidate) => candidate.type === "approval.requested" && (candidate.payload as { action?: string }).action === action);
    const approvalId = event && (event.payload as { approvalId?: string }).approvalId;
    if (approvalId) return approvalId;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`approval event for ${action} was not emitted`);
}

async function settleWithin<T>(promise: Promise<T>, persistence: ISessionPersistence, sessionId: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => setTimeout(() => {
      void Promise.all([persistence.getTurns(sessionId), persistence.getWorkItems(sessionId)])
        .then(([turns, items]) => reject(new Error(`workflow did not settle: ${JSON.stringify({ turns, items })}`)));
    }, 5_000)),
  ]);
}

async function waitForRuntime(graph: Graph): Promise<ReturnType<typeof createAgentRuntime>> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const runtime = graph.getRuntime();
    if (runtime) return runtime;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("recovery runtime was not created");
}

describe.skipIf(!TEST_PG?.startsWith("postgres"))("R4 hosted authority through real PostgreSQL", () => {
  let workspace: string | undefined;
  let cleanupSessionId: string | undefined;

  afterEach(async () => {
    if (cleanupSessionId && TEST_PG) {
      const client = new pg.Client({ connectionString: TEST_PG });
      await client.connect();
      await client.query(`DELETE FROM events WHERE "sessionId" = $1`, [cleanupSessionId]);
      await client.query(`DELETE FROM sessions WHERE id = $1`, [cleanupSessionId]);
      await client.end();
    }
    if (workspace) await rm(workspace, { recursive: true, force: true });
    workspace = undefined;
    cleanupSessionId = undefined;
  });

  it("recreates three service graphs, then lets ForgeVerify and the completion gate persist the only hosted completion", async () => {
    workspace = await mkdtemp(join(tmpdir(), "codeforge-r4-hosted-"));
    await writeFile(join(workspace, "add.js"), "export const add = (a, b) => a - b;\n", "utf8");
    await writeFile(join(workspace, "verify.cjs"), "const fs = require('node:fs'); if (!fs.readFileSync('add.js', 'utf8').includes('a + b')) process.exit(1);\n", "utf8");
    const sessionId = `r4-hosted-${crypto.randomUUID()}`;
    const workflowId = `r4-workflow-${crypto.randomUUID()}`;
    cleanupSessionId = sessionId;
    const now = new Date().toISOString();

    const graphA = await createGraph(TEST_PG!, sessionId, "user-r4");
    await graphA.persistence.upsertSession({ id: sessionId, title: "Fix add", taskTitle: "Fix add", createdAt: now, updatedAt: now, status: "running" });
    await graphA.persistence.upsertWorkItem({ kind: "hosted_workflow", id: workflowId, sessionId, ownerUserId: "user-r4", workerId: "worker-r4", workspaceId: "workspace-r4", revision: 0, status: "active", createdAt: now, updatedAt: now });
    const started = await graphA.service.startWorkflow({ sessionId, message: "Inspect the add() implementation and verify it.", workspacePath: workspace, verificationCommands: ["node verify.cjs"], userId: "user-r4", hostedWorkflowId: workflowId });
    graphA.service.getApprovalService().resolve(await waitForApprovalEvent(graphA.workflowEvents, sessionId, "execute_plan"), "allow_once");
    const suspendedA = await settleWithin(graphA.service.getWorkflow(started.taskId)!.promise, graphA.persistence, sessionId);
    expect(suspendedA.status, suspendedA.summary).toBe("suspended");
    const first = await continuation(graphA.persistence, workflowId);
    expect(first.pendingTool.toolName).toBe("read_file");
    expect(await graphA.persistence.getSession(sessionId)).toBeDefined();
    await graphA.persistence.close();

    const resultGraphA = new PostgresSessionPersistence({ connectionString: TEST_PG! });
    await resultGraphA.init();
    expect(await resultGraphA.getSession(sessionId)).toBeDefined();
    await persistWorkerResult(resultGraphA, first.pendingTool.actionId, "export const add = (a, b) => a - b;");
    expect(await resultGraphA.getSession(sessionId)).toBeDefined();
    await resultGraphA.close();

    const graphB = await createGraph(TEST_PG!, sessionId, "user-r4");
    const competingGraphB = await createGraph(TEST_PG!, sessionId, "user-r4");
    expect(graphB.service).not.toBe(graphA.service);
    const resumedB = graphB.service.resumeHostedWorkflow(workflowId, "user-r4");
    const competingResume = competingGraphB.service.resumeHostedWorkflow(workflowId, "user-r4");
    const [runtimeB, competingRuntimeB] = await Promise.all([waitForRuntime(graphB), waitForRuntime(competingGraphB)]);
    const editApprovalId = await waitForApproval(graphB.persistence, "edit_file");
    const approvalOwner = [runtimeB, competingRuntimeB].find((runtime) => runtime.getApprovalService().getRecord(editApprovalId));
    if (!approvalOwner) throw new Error("hosted edit approval owner was not found");
    approvalOwner.getApprovalService().resolve(editApprovalId, "allow_once");
    const recoveryStatuses = (await Promise.all([resumedB, competingResume])).map((result) => result.status).sort();
    expect(recoveryStatuses).toEqual(["not_ready", "suspended"]);
    const second = await continuation(graphB.persistence, workflowId);
    expect(second.pendingTool.toolName).toBe("edit_file");
    await graphB.persistence.close();
    await competingGraphB.persistence.close();

    await writeFile(join(workspace, "add.js"), "export const add = (a, b) => a + b;\n", "utf8");
    const resultGraphB = new PostgresSessionPersistence({ connectionString: TEST_PG! });
    await resultGraphB.init();
    await persistWorkerResult(resultGraphB, second.pendingTool.actionId, "patch applied");
    await resultGraphB.close();

    const graphC = await createGraph(TEST_PG!, sessionId, "user-r4");
    expect(graphC.service).not.toBe(graphB.service);
    expect((await graphC.service.resumeHostedWorkflow(workflowId, "user-r4")).status).toBe("resumed");
    const final = await graphC.service.getWorkflow(started.taskId)!.promise;
    expect(final.status).toBe("completed");
    expect(final.completion?.outcome).toBe("completed");
    expect((await graphC.persistence.getWorkItemsByKind("verification")).filter((item) => item.kind === "verification" && item.recordType === "evidence").length).toBeGreaterThan(0);
    const completed = await graphC.persistence.getWorkItem(workflowId);
    expect(completed).toMatchObject({ kind: "hosted_workflow", status: "completed", execution: { finalStatus: "completed" } });
    await graphC.persistence.close();
  }, 60_000);
});
