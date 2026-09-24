import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { ForgeZero, createGenericFreeRecord, CapacityReservationLedger, type CapacityRoute, type CapacityWindow, type ProviderCapacityPool } from "@codeforge/forge-zero";
import {
  type ProviderAdapter,
  type ProviderModel,
  type ChatRequest,
  type ChatResponse,
  type StreamEvent,
  InMemoryProviderCatalog,
} from "@codeforge/providers";
import { EventStore, createSessionPersistence, type ISessionPersistence } from "@codeforge/sessions";
import {
  createEightBitRouteHealthAuthority,
  createFreeFabric,
  type EightBitRouteHealthAuthority,
  type FreeFabric,
} from "@codeforge/eight-bit";
import { createTaskAuthority } from "@codeforge/permissions";
import { createAgentRuntime, type AgentRuntime } from "../src/agent-runtime.js";
import { WorkflowService } from "../src/workflow-service.js";

/**
 * R33 Mission 2 — workflow-owned capacity waiting. A workflow-dispatched implement turn that
 * the fabric can only QUEUE must park in waiting_for_free_capacity, never terminalize; the
 * workflow's own poll re-decides admission and resumes the turn in place; and the goal review
 * afterwards is steered onto a quota pool physically independent of the implementation route.
 */

const OBSERVED_AT = new Date(Date.now() - 60_000).toISOString();
const NO_RESET = "9999-12-31T23:59:59.999Z";
const FABRIC_ROLES = ["PRIMARY_CODING_AGENT", "PLANNER", "REVIEWER", "SUBAGENT", "FAST_REASONER"];

function quotaWindow(overrides: Partial<CapacityWindow> = {}): CapacityWindow {
  return { unit: "requests", limit: 100, remaining: 100, resetAt: NO_RESET, scope: "ORG", observedAt: OBSERVED_AT, authoritative: true, ...overrides };
}

function managedRoute(id: string, overrides: Partial<CapacityRoute> = {}): CapacityRoute {
  return {
    routeId: `fabric:${id}`,
    providerId: id,
    modelId: `${id}-model`,
    canonicalModelId: `${id}-model`,
    family: id,
    gateway: id,
    supplyClass: "PURE_MANAGED_FREE",
    capacityPoolId: `shared:${id}`,
    capacityPoolScope: "SHARED_OWNER_POOL",
    capacityScope: "ORG",
    dataPolicyProfile: "PRIVATE_CODE_ALLOWED",
    lifecycle: "APPROVED",
    explicitZeroPrice: true,
    paidFallbackDisabled: true,
    managedMultiUserAllowed: true,
    privacyClass: "standard",
    roles: FABRIC_ROLES,
    qualityScore: 70,
    healthy: true,
    enabled: true,
    windows: [quotaWindow(), quotaWindow({ unit: "input_tokens", limit: 2_000_000, remaining: 2_000_000 })],
    ...overrides,
  };
}

function poolFor(route: CapacityRoute): ProviderCapacityPool {
  return {
    poolId: route.capacityPoolId,
    providerId: route.providerId,
    scope: route.capacityPoolScope,
    supplyClass: route.supplyClass,
    windows: route.windows,
    observedAt: OBSERVED_AT,
    authoritative: true,
    ...(route.capacityIdentity !== undefined ? { capacityIdentity: route.capacityIdentity } : {}),
  };
}

const textEvents = (text: string): StreamEvent[] => [
  { type: "text_delta", delta: text },
  { type: "usage", usage: { inputTokens: 40, outputTokens: 12 } },
  { type: "finish", finishReason: "stop" },
];

const toolCallEvents = (name: string, args: Record<string, unknown>): StreamEvent[] => {
  const id = `tc-${crypto.randomUUID()}`;
  return [
    { type: "tool_call_started", toolCallId: id, toolName: name },
    { type: "tool_call_completed", toolCallId: id, toolName: name, arguments: JSON.stringify(args) },
    { type: "usage", usage: { inputTokens: 40, outputTokens: 12 } },
    { type: "finish", finishReason: "tool_calls" },
  ];
};

/** Branching test provider: answers implement turns with a read→edit→finish tool sequence and
 * the independent-review prompt with a decisive verdict JSON. */
class WorkflowScriptProvider implements ProviderAdapter {
  readonly isTestProvider = true;
  callCount = 0;
  readonly seenPromptKinds: string[] = [];

  constructor(
    readonly providerId: string,
    private readonly modelId: string,
  ) {}

  async listModels(): Promise<ProviderModel[]> {
    return [{
      modelId: this.modelId,
      displayName: `${this.providerId} ${this.modelId}`,
      isFree: true,
      freeStatus: "verified_free",
      capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true },
    }];
  }

  async chat(_req: ChatRequest): Promise<ChatResponse> {
    throw new Error("Use streamChat");
  }

  async *streamChat(req: ChatRequest, _signal?: AbortSignal): AsyncIterable<StreamEvent> {
    this.callCount++;
    const isReview = req.messages.some((m) => typeof m.content === "string" && m.content.includes("independent completion reviewer"));
    if (isReview) {
      this.seenPromptKinds.push("review");
      yield* textEvents(JSON.stringify({ verdicts: [{ goal: "add returns a + b", status: "met", evidence: "read src/calc.ts after edit: returns a + b; verification exited 0", path: "src/calc.ts" }] }));
      return;
    }
    this.seenPromptKinds.push("implement");
    const toolResults = req.messages.filter((m) => m.role === "tool");
    if (toolResults.length === 0) {
      yield* toolCallEvents("read_file", { path: "src/calc.ts" });
      return;
    }
    const lastTool = String(toolResults.at(-1)?.content ?? "");
    // A read_file result carries the file body plus its integrity hash; the edit result echoes
    // the same lines inside a diff, so only the hash marker proves this is a fresh read.
    if (lastTool.includes("a-b") && lastTool.includes("[hash:")) {
      yield* toolCallEvents("edit_file", { path: "src/calc.ts", oldText: "a-b", newText: "a+b" });
      return;
    }
    yield* textEvents("Done — src/calc.ts now returns a + b.");
  }

  async healthCheck() {
    return { status: "available" as const };
  }
}

describe("R33 — workflow-owned turns wait for free capacity and review stays pool-independent", () => {
  let tmpDir: string;
  let persistence: ISessionPersistence;
  let eventStore: EventStore;
  let firewall: ForgeZero;
  let catalog: InMemoryProviderCatalog;
  let authority: EightBitRouteHealthAuthority;
  let runtime: AgentRuntime;
  let service: WorkflowService;

  const registerFleet = (providerId: string, modelId: string) =>
    firewall.register(createGenericFreeRecord({ providerId, modelId, displayName: `${providerId} ${modelId}` }));

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cf-wf-capacity-"));
    await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "src", "calc.ts"), "export function add(a:number,b:number){return a-b}\n");
    await fs.writeFile(path.join(tmpDir, "package.json"), JSON.stringify({ type: "module" }));
    persistence = createSessionPersistence({ dbPath: ":memory:" });
    await persistence.init();
    eventStore = new EventStore();
    firewall = new ForgeZero();
    catalog = new InMemoryProviderCatalog();
    authority = createEightBitRouteHealthAuthority();
  });

  afterEach(async () => {
    await runtime.shutdown().catch(() => {});
    await persistence.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const makeFabric = (routes: CapacityRoute[], pools: ProviderCapacityPool[]): FreeFabric =>
    createFreeFabric({
      managedRoutes: () => routes,
      managedPools: () => pools,
      userSources: [],
      health: authority,
      reservations: new CapacityReservationLedger({ routes: [], pools: [] }),
    });

  const wireService = (fabric: FreeFabric) => {
    runtime = createAgentRuntime({
      sessionId: "sess-wf-wait",
      eventStore,
      persistence,
      firewall,
      providerCatalog: catalog,
      workspacePath: tmpDir,
      routeHealth: authority,
      freeFabric: fabric,
      fabricContext: () => ({ userId: "user-wf", userIdentities: [] }),
      authorityFor: () => createTaskAuthority({
        sessionId: "sess-wf-wait",
        workspaceRoot: tmpDir,
        permissionMode: "full_autonomy",
        planMode: "auto",
        grants: [],
        createdAt: new Date().toISOString(),
      }),
    });
    service = new WorkflowService({
      eventStore,
      persistence,
      workspacePath: tmpDir,
      getOrCreateRuntime: () => runtime,
      useRealRuntime: () => true,
      capacityWaitPollMs: 25,
      agentWorkingBudgetMs: 60_000,
      authorityFor: () => createTaskAuthority({
        sessionId: "sess-wf-wait",
        workspaceRoot: tmpDir,
        permissionMode: "full_autonomy",
        planMode: "auto",
        grants: [],
        createdAt: new Date().toISOString(),
      }),
    });
    return service.init();
  };

  it("implement parks on QUEUED, the workflow poll resumes it, and review runs on an independent pool", async () => {
    // Implementation pool: one slot, already held by another user's reservation. Review pool:
    // REVIEWER-only so the implement turn can never steal it, and lower-scored than A so that
    // without the independence hint the review would land back on A's pool.
    const routeA = managedRoute("provider-a", { qualityScore: 95, windows: [quotaWindow({ limit: 1, remaining: 1 }), quotaWindow({ unit: "input_tokens", limit: 2_000_000, remaining: 2_000_000 })] });
    const routeB = managedRoute("provider-b", { qualityScore: 60, roles: ["REVIEWER"] });
    registerFleet("provider-a", "provider-a-model");
    registerFleet("provider-b", "provider-b-model");
    const fabric = makeFabric([routeA, routeB], [poolFor(routeA), poolFor(routeB)]);
    const providerA = new WorkflowScriptProvider("provider-a", "provider-a-model");
    const providerB = new WorkflowScriptProvider("provider-b", "provider-b-model");
    catalog.register(providerA);
    catalog.register(providerB);
    const holdout = fabric.decide({ requestId: "other-user-hold", userId: "user-other", role: "PRIMARY_CODING_AGENT" });
    expect(holdout.selected?.capacityPoolId).toBe("shared:provider-a");

    await wireService(fabric);
    const { taskId } = await service.startWorkflow({
      sessionId: "sess-wf-wait",
      message: "Fix add() in src/calc.ts to return a + b",
      workspacePath: tmpDir,
      verificationCommands: ['node -e "process.exit(0)"'],
    });

    // Wait until the implement turn is durably parked — the workflow must NOT terminalize it.
    let implementTurnId: string | undefined;
    for (let i = 0; i < 400; i++) {
      const parked = runtime.getActiveTurns().find((t) => t.status === "waiting_for_free_capacity");
      if (parked) { implementTurnId = parked.turnId; break; }
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(implementTurnId).toBeDefined();
    expect(await persistence.getWorkItem(`free-capacity-wait-${implementTurnId}`)).toMatchObject({ kind: "free_capacity_wait", state: "waiting" });
    expect(providerA.callCount).toBe(0);
    const taskWhileParked = service.getWorkflow(taskId)?.task;
    expect(taskWhileParked?.phase).not.toBe("failed");
    expect(taskWhileParked?.phase).not.toBe("completed");

    // Supply returns — the workflow's capacity poll performs the fresh admission and resumes.
    expect(fabric.release(holdout.selected!.reservationId!)).toBe(true);
    const entry = service.getWorkflow(taskId)!;
    const result = await Promise.race([
      entry.promise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("workflow did not finish after capacity returned")), 60_000)),
    ]);

    expect(result.phase).toBe("completed");
    expect(result.status).toBe("completed");
    // Implementation consumed pool A after the wait; review ran on pool B — physically
    // independent capacity, not merely a different model name behind the same quota domain.
    const implementTurn = runtime.getTurn(implementTurnId!);
    expect(implementTurn?.capacityPoolId).toBe("shared:provider-a");
    const allTurnIds = (await persistence.getTurns("sess-wf-wait")).map((t) => t.id);
    const reviewTurn = allTurnIds.map((id) => runtime.getTurn(id)).find((t) => t && t.turnId !== implementTurnId && t.capacityPoolId === "shared:provider-b");
    expect(reviewTurn).toBeDefined();
    expect(providerB.callCount).toBe(1);
    expect(await persistence.getWorkItem(`free-capacity-wait-${implementTurnId}`)).toMatchObject({ state: "resumed" });
    // The edit actually landed — the completion gate judged a real diff, not a claimed one.
    const calc = await fs.readFile(path.join(tmpDir, "src", "calc.ts"), "utf-8");
    expect(calc).toContain("a+b");
    expect(fabric.reservationSnapshot()?.activeReservations).toBe(0);
  }, 90_000);

  it("a workflow whose capacity never returns stays parked and cancellable — never falsely failed or completed", async () => {
    const routeA = managedRoute("provider-a", { windows: [quotaWindow({ limit: 1, remaining: 1 }), quotaWindow({ unit: "input_tokens", limit: 2_000_000, remaining: 2_000_000 })] });
    registerFleet("provider-a", "provider-a-model");
    const fabric = makeFabric([routeA], [poolFor(routeA)]);
    catalog.register(new WorkflowScriptProvider("provider-a", "provider-a-model"));
    fabric.decide({ requestId: "other-user-hold", userId: "user-other", role: "PRIMARY_CODING_AGENT" });

    await wireService(fabric);
    const { taskId } = await service.startWorkflow({
      sessionId: "sess-wf-wait",
      message: "Fix add() in src/calc.ts to return a + b",
      workspacePath: tmpDir,
      verificationCommands: ['node -e "process.exit(0)"'],
    });

    let implementTurnId: string | undefined;
    for (let i = 0; i < 400; i++) {
      const parked = runtime.getActiveTurns().find((t) => t.status === "waiting_for_free_capacity");
      if (parked) { implementTurnId = parked.turnId; break; }
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(implementTurnId).toBeDefined();
    // A few poll cycles pass with supply still held: the task must not have terminalized.
    await new Promise((r) => setTimeout(r, 150));
    const task = service.getWorkflow(taskId)?.task;
    expect(["implementing", "reconnaissance", "planning", "awaiting_approval"]).toContain(task?.phase);

    await service.cancelWorkflow(taskId, "test cleanup");
    await new Promise((r) => setTimeout(r, 100));
    expect(runtime.getTurn(implementTurnId!)?.status).toBe("cancelled");
    expect(await persistence.getWorkItem(`free-capacity-wait-${implementTurnId}`)).toMatchObject({ state: "cancelled" });
  }, 60_000);
});
