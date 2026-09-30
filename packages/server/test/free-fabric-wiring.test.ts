import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
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
import { createAgentRuntime } from "../src/agent-runtime.js";
import { createWorkspaceEventAdapter } from "../src/workspace-event-adapter.js";

/**
 * R24 Mission C server wiring proof: the Free Fabric is the admission authority in the real
 * serving path — not a library beside it. An interactive ForgeAuto turn and a role-routed run
 * may only execute after `decide()` admits them with a live reservation; a queued or denied
 * verdict fails the turn closed; finishing the turn releases the hold; one user's per-user
 * pool is unreachable by another's request; and concurrent sessions contend fairly through
 * the single shared ledger.
 */

type StreamScript = (call: number) => StreamEvent[];

class ScriptedRouteProvider implements ProviderAdapter {
  readonly isTestProvider = true;
  callCount = 0;
  readonly requests: ChatRequest[] = [];

  constructor(
    readonly providerId: string,
    private readonly modelId: string,
    private readonly script: StreamScript,
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
    this.requests.push(req);
    yield* this.script(this.callCount);
  }

  async healthCheck() {
    return { status: "available" as const };
  }
}

const okEvents = (text = "Task complete."): StreamEvent[] => [
  { type: "text_delta", delta: text },
  { type: "usage", usage: { inputTokens: 40, outputTokens: 12 } },
  { type: "finish", finishReason: "stop" },
];

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

function userPoolRoute(identity: string, overrides: Partial<CapacityRoute> = {}): CapacityRoute {
  return {
    routeId: `fabric:user-${identity}`,
    providerId: "user-cloud",
    modelId: "user-model",
    canonicalModelId: "user-model",
    family: "user",
    gateway: "user-cloud",
    supplyClass: "USER_CONNECTED_FREE",
    capacityPoolId: `user-cloud:user:${identity}`,
    capacityPoolScope: "PER_USER_POOL",
    capacityScope: "USER_ACCOUNT",
    dataPolicyProfile: "PRIVATE_CODE_ALLOWED",
    lifecycle: "APPROVED",
    explicitZeroPrice: false,
    freeOnlyAdmissionProven: true,
    paidFallbackDisabled: true,
    // A user-connected provider whose terms ARE cleared for managed routing (the real
    // ollama-cloud def is LEGAL_REVIEW_REQUIRED — its routes stay fabric-visible but
    // POLICY_EXCLUDED until terms clear; this fixture models the cleared case).
    managedMultiUserAllowed: true,
    privacyClass: "standard",
    roles: FABRIC_ROLES,
    qualityScore: 80,
    healthy: true,
    enabled: true,
    windows: [quotaWindow({ unit: "credits", scope: "USER_ACCOUNT", limit: 5, remaining: 5, resetAt: NO_RESET })],
    capacityIdentity: identity,
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

async function waitForTerminal(
  runtime: ReturnType<typeof createAgentRuntime>,
  persistence: ISessionPersistence,
  sessionId: string,
  turnId: string,
) {
  const approved = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const state = runtime.getTurn(turnId);
    if (state?.status === "completed" || state?.status === "failed") return state;
    if (state?.status === "waiting_for_approval") {
      const items = await persistence.getWorkItems(sessionId);
      const pending = items.find((it) => it.kind === "approval" && it.turnId === turnId && !it.decision && !approved.has(it.id));
      if (pending) {
        approved.add(pending.id);
        await runtime.resolveApproval(pending.id, "allow_once");
      }
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  return runtime.getTurn(turnId);
}

describe("R24 Mission C — Free Fabric is authoritative in the serving path", () => {
  let tmpDir: string;
  let persistence: ISessionPersistence;
  let eventStore: EventStore;
  let firewall: ForgeZero;
  let catalog: InMemoryProviderCatalog;
  let authority: EightBitRouteHealthAuthority;

  const registerFleet = (providerId: string, modelId: string) =>
    firewall.register(createGenericFreeRecord({ providerId, modelId, displayName: `${providerId} ${modelId}` }));

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cf-free-fabric-wiring-"));
    persistence = createSessionPersistence({ dbPath: ":memory:" });
    await persistence.init();
    eventStore = new EventStore();
    firewall = new ForgeZero();
    catalog = new InMemoryProviderCatalog();
    authority = createEightBitRouteHealthAuthority();
  });

  afterEach(async () => {
    await persistence.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const makeFabric = (routes: CapacityRoute[], pools: ProviderCapacityPool[]): FreeFabric =>
    createFreeFabric({
      managedRoutes: () => routes.filter((r) => r.capacityPoolScope !== "PER_USER_POOL"),
      managedPools: () => pools.filter((p) => p.scope !== "PER_USER_POOL"),
      userSources: [{
        routesForUser: (userId: string) => routes.filter((r) => r.capacityPoolScope === "PER_USER_POOL" && r.capacityIdentity === `hash-${userId}`),
        poolsForUser: (userId: string) => pools.filter((p) => p.scope === "PER_USER_POOL" && p.capacityIdentity === `hash-${userId}`),
      }],
      health: authority,
      reservations: new CapacityReservationLedger({ routes: [], pools: [] }),
    });

  const makeRuntime = (sessionId: string, fabric: FreeFabric, userId?: string, freeCloud?: import("@codeforge/model-registry").FreeCloudRoutingHooks, extra?: { qualificationWaitHorizonMs?: number; qualificationRecoveryBudgetMs?: number }) =>
    createAgentRuntime({
      sessionId,
      eventStore,
      persistence,
      firewall,
      providerCatalog: catalog,
      workspacePath: tmpDir,
      userId,
      routeHealth: authority,
      freeFabric: fabric,
      freeCloud,
      ...(extra ?? {}),
      fabricContext: ({ userId: uid }) => {
        const resolved = uid ?? "anonymous";
        return { userId: resolved, userIdentities: uid ? [`hash-${resolved}`] : [] };
      },
    });

  it("an interactive ForgeAuto turn executes only inside a live fabric reservation and releases it at turn end", async () => {
    const route = managedRoute("provider-a");
    registerFleet("provider-a", "provider-a-model");
    const fabric = makeFabric([route], [poolFor(route)]);

    // The provider observes the shared ledger mid-stream: the turn's hold must already exist
    // when the first request is sent — proof the reservation precedes provider execution.
    let holdDuringCall: number | undefined;
    const provider = new ScriptedRouteProvider("provider-a", "provider-a-model", () => {
      holdDuringCall = fabric.reservationSnapshot()?.activeReservations;
      return okEvents();
    });
    catalog.register(provider);

    const runtime = makeRuntime("sess-fabric-turn", fabric);
    await runtime.init();
    const turnId = await runtime.startTurn("Say hello");
    const final = await waitForTerminal(runtime, persistence, "sess-fabric-turn", turnId);

    expect(final?.status).toBe("completed");
    expect(provider.callCount).toBe(1);
    expect(holdDuringCall).toBe(1);
    // Turn end settled the admission — the shared ledger is free for the next decide().
    expect(fabric.reservationSnapshot()?.activeReservations).toBe(0);
  });

  it("a queued ForgeAuto turn remains durable and resumes only after free capacity returns", async () => {
    // One request slot in the shared pool; an earlier user already holds it.
    const route = managedRoute("provider-a", { windows: [quotaWindow({ limit: 1, remaining: 1 }), quotaWindow({ unit: "input_tokens", limit: 2_000_000, remaining: 2_000_000 })] });
    registerFleet("provider-a", "provider-a-model");
    const fabric = makeFabric([route], [poolFor(route)]);
    const holdout = fabric.decide({ requestId: "other-user-hold", userId: "user-other", role: "PRIMARY_CODING_AGENT" });
    expect(holdout.outcome).toBe("ADMITTED");
    expect(fabric.reservationSnapshot()?.activeReservations).toBe(1);

    const provider = new ScriptedRouteProvider("provider-a", "provider-a-model", () => okEvents());
    catalog.register(provider);
    const runtime = makeRuntime("sess-fabric-queued", fabric);
    await runtime.init();
    const turnId = await runtime.startTurn("Say hello");
    for (let i = 0; i < 100 && runtime.getTurn(turnId)?.status !== "waiting_for_free_capacity"; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(runtime.getTurn(turnId)?.status).toBe("waiting_for_free_capacity");
    expect((await persistence.getTurns("sess-fabric-queued")).find((turn) => turn.id === turnId)?.status).toBe("waiting_for_free_capacity");
    expect((await persistence.getSession("sess-fabric-queued"))?.status).toBe("waiting_for_free_capacity");
    expect(await persistence.getWorkItem(`free-capacity-wait-${turnId}`)).toMatchObject({ kind: "free_capacity_wait", state: "waiting", turnId });
    expect(provider.callCount).toBe(0);
    expect(fabric.reservationSnapshot()?.activeReservations).toBe(1);

    const recovered = makeRuntime("sess-fabric-queued", fabric);
    await recovered.init();
    expect(recovered.getTurn(turnId)?.status).toBe("waiting_for_free_capacity");
    await recovered.resumeTurn(turnId);
    for (let i = 0; i < 100 && recovered.getTurn(turnId)?.status !== "waiting_for_free_capacity"; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(recovered.getTurn(turnId)?.status).toBe("waiting_for_free_capacity");
    expect(provider.callCount).toBe(0);

    expect(fabric.release(holdout.selected!.reservationId!)).toBe(true);
    await recovered.resumeTurn(turnId);
    const final = await waitForTerminal(recovered, persistence, "sess-fabric-queued", turnId);
    expect(final?.status).toBe("completed");
    expect(provider.callCount).toBe(1);
    expect(await persistence.getWorkItem(`free-capacity-wait-${turnId}`)).toMatchObject({ state: "resumed" });
    expect(fabric.reservationSnapshot()?.activeReservations).toBe(0);
  });

  it("a role-routed run decides through the fabric and releases its reservation when the run ends", async () => {
    const route = managedRoute("provider-a");
    registerFleet("provider-a", "provider-a-model");
    const fabric = makeFabric([route], [poolFor(route)]);

    let holdDuringCall: number | undefined;
    const provider = new ScriptedRouteProvider("provider-a", "provider-a-model", () => {
      holdDuringCall = fabric.reservationSnapshot()?.activeReservations;
      return okEvents(JSON.stringify({ summary: "Mapped.", findings: [], evidence: [] }));
    });
    catalog.register(provider);

    const runtime = makeRuntime("sess-fabric-role", fabric);
    const adapter = createWorkspaceEventAdapter({ sessionId: "sess-fabric-role", eventStore, persistence });
    const result = await runtime.executeAgentRun({
      runId: "run-fabric-1",
      agentId: "explorer-1",
      role: "explorer",
      goal: "Map the workspace",
      workspaceId: "ws-fabric",
      workspacePath: tmpDir,
      permissions: { read: true, search: true, write: false, executeCommand: false, network: false },
      roleRouting: true,
      adapter,
    });

    expect(result.status).toBe("completed");
    expect(provider.callCount).toBe(1);
    expect(holdDuringCall).toBe(1);
    expect(fabric.reservationSnapshot()?.activeReservations).toBe(0);
    const selection = eventStore.getAll().find((event) => event.type === "router.selection");
    expect(selection?.payload).toMatchObject({ providerId: "provider-a", modelId: "provider-a-model" });
  });

  it("excludes a stalled free role owner and admits an alternate without marking the provider unhealthy", async () => {
    const first = managedRoute("provider-a", { qualityScore: 95 });
    const second = managedRoute("provider-b", { qualityScore: 90 });
    registerFleet("provider-a", "provider-a-model");
    registerFleet("provider-b", "provider-b-model");
    const fabric = makeFabric([first, second], [poolFor(first), poolFor(second)]);
    const a = new ScriptedRouteProvider("provider-a", "provider-a-model", () => okEvents());
    const b = new ScriptedRouteProvider("provider-b", "provider-b-model", () => okEvents());
    catalog.register(a);
    catalog.register(b);
    const runtime = makeRuntime("sess-quality-handoff", fabric);
    const adapter = createWorkspaceEventAdapter({ sessionId: "sess-quality-handoff", eventStore, persistence });
    const result = await runtime.executeAgentRun({
      runId: "run-quality-handoff",
      agentId: "coder",
      role: "coder",
      goal: "Continue the existing work",
      workspaceId: "ws-quality-handoff",
      workspacePath: tmpDir,
      permissions: { read: true, search: true, write: true, executeCommand: true, network: false },
      roleRouting: true,
      excludeRoleRoute: { providerId: "provider-a", modelId: "provider-a-model" },
      adapter,
    });
    expect(result.route).toMatchObject({ providerId: "provider-b", modelId: "provider-b-model" });
    expect(a.callCount).toBe(0);
    expect(b.callCount).toBe(1);
    expect(fabric.reservationSnapshot()?.activeReservations).toBe(0);
    expect(eventStore.getAll().find((event) => event.type === "router.failover")?.payload).toMatchObject({ reason: "QUALITY_DRIVEN_ROLE_SWITCH" });
    expect(authority.assess("provider-a", "provider-a-model", { role: "CODER" }).hardExclude).toBe(false);
  });

  it("keeps an excluded quality owner excluded when the replacement route fails over mid-run", async () => {
    const excluded = managedRoute("provider-a", { qualityScore: 95 });
    const replacement = managedRoute("provider-b", { qualityScore: 90 });
    const failover = managedRoute("provider-c", { qualityScore: 80 });
    registerFleet("provider-a", "provider-a-model");
    registerFleet("provider-b", "provider-b-model");
    registerFleet("provider-c", "provider-c-model");
    const fabric = makeFabric([excluded, replacement, failover], [poolFor(excluded), poolFor(replacement), poolFor(failover)]);
    const a = new ScriptedRouteProvider("provider-a", "provider-a-model", () => okEvents());
    const b = new ScriptedRouteProvider("provider-b", "provider-b-model", () => [
      { type: "error", code: "PROVIDER_UNAVAILABLE", status: 503, message: "provider outage", retryable: false },
    ]);
    const c = new ScriptedRouteProvider("provider-c", "provider-c-model", () => okEvents());
    catalog.register(a);
    catalog.register(b);
    catalog.register(c);
    const runtime = makeRuntime("sess-excluded-failover", fabric);
    const adapter = createWorkspaceEventAdapter({ sessionId: "sess-excluded-failover", eventStore, persistence });
    const result = await runtime.executeAgentRun({
      runId: "run-excluded-failover",
      agentId: "coder",
      role: "coder",
      goal: "Continue the existing work",
      workspaceId: "ws-excluded-failover",
      workspacePath: tmpDir,
      permissions: { read: true, search: true, write: true, executeCommand: true, network: false },
      roleRouting: true,
      excludeRoleRoute: { providerId: "provider-a", modelId: "provider-a-model" },
      adapter,
    });
    expect(result.status).toBe("completed");
    expect(result.route).toMatchObject({ providerId: "provider-c", modelId: "provider-c-model" });
    expect(a.callCount).toBe(0);
    expect(b.callCount).toBe(1);
    expect(c.callCount).toBe(1);
    expect(fabric.reservationSnapshot()?.activeReservations).toBe(0);
    const failoverTargets = eventStore.getAll()
      .filter((event) => event.type === "router.failover")
      .map((event) => (event.payload as { toModelId?: string }).toModelId);
    expect(failoverTargets).not.toContain("provider-a/provider-a-model");
  });

  it("keeps initial and failover Free routing within the selected roster", async () => {
    const unselected = managedRoute("provider-a", { qualityScore: 99 });
    const selected = managedRoute("provider-b", { qualityScore: 70 });
    registerFleet("provider-a", "provider-a-model");
    registerFleet("provider-b", "provider-b-model");
    const fabric = makeFabric([unselected, selected], [poolFor(unselected), poolFor(selected)]);
    const a = new ScriptedRouteProvider("provider-a", "provider-a-model", () => okEvents());
    const b = new ScriptedRouteProvider("provider-b", "provider-b-model", () => [
      { type: "error", code: "PROVIDER_UNAVAILABLE", status: 503, message: "provider outage", retryable: false },
    ]);
    catalog.register(a);
    catalog.register(b);
    const runtime = makeRuntime("sess-roster-free", fabric);
    const result = await runtime.executeAgentRun({
      runId: "run-roster-free", agentId: "coder", role: "coder", goal: "Do the task",
      workspaceId: "ws-roster-free", workspacePath: tmpDir,
      permissions: { read: true, search: true, write: true, executeCommand: true, network: false },
      roleRouting: true,
      rosterAllowance: { freeRoutes: [{ providerId: "provider-b", modelId: "provider-b-model" }], paidModelIds: [], userRoutes: [] },
    });
    expect(result.status).not.toBe("completed");
    expect(b.callCount).toBeGreaterThan(0);
    expect(a.callCount).toBe(0);
  });

  it("a queued role-routed run fails closed with no provider call and no reservation", async () => {
    const route = managedRoute("provider-a", { windows: [quotaWindow({ limit: 1, remaining: 1 }), quotaWindow({ unit: "input_tokens", limit: 2_000_000, remaining: 2_000_000 })] });
    registerFleet("provider-a", "provider-a-model");
    const fabric = makeFabric([route], [poolFor(route)]);
    fabric.decide({ requestId: "other-user-hold", userId: "user-other", role: "PRIMARY_CODING_AGENT" });

    const provider = new ScriptedRouteProvider("provider-a", "provider-a-model", () => okEvents());
    catalog.register(provider);
    const runtime = makeRuntime("sess-fabric-roleq", fabric);
    const adapter = createWorkspaceEventAdapter({ sessionId: "sess-fabric-roleq", eventStore, persistence });
    const result = await runtime.executeAgentRun({
      runId: "run-fabric-queued",
      agentId: "explorer-q",
      role: "explorer",
      goal: "Map the workspace",
      workspaceId: "ws-fabric",
      workspacePath: tmpDir,
      permissions: { read: true, search: true, write: false, executeCommand: false, network: false },
      roleRouting: true,
      adapter,
    });

    expect(result.status).toBe("failed");
    expect(provider.callCount).toBe(0);
    expect(fabric.reservationSnapshot()?.activeReservations).toBe(1);
  });

  it("a failover re-decide replaces the hold in place — the replacement route executes under exactly one reservation", async () => {
    const routeA = managedRoute("provider-a");
    const routeB = managedRoute("provider-b");
    registerFleet("provider-a", "provider-a-model");
    registerFleet("provider-b", "provider-b-model");
    const fabric = makeFabric([routeA, routeB], [poolFor(routeA), poolFor(routeB)]);

    const providerA = new ScriptedRouteProvider("provider-a", "provider-a-model", () => [
      { type: "error", code: "PROVIDER_RATE_LIMITED", status: 429, message: "429 rate limited", retryable: true },
    ]);
    const heldRoutesDuringB: Record<string, number> = {};
    const providerB = new ScriptedRouteProvider("provider-b", "provider-b-model", () => {
      const snap = fabric.reservationSnapshot();
      if (snap) Object.assign(heldRoutesDuringB, snap.byRoute);
      return okEvents();
    });
    catalog.register(providerA);
    catalog.register(providerB);

    const runtime = makeRuntime("sess-fabric-failover", fabric);
    await runtime.init();
    const turnId = await runtime.startTurn("Do work");
    const final = await waitForTerminal(runtime, persistence, "sess-fabric-failover", turnId);

    expect(final?.status).toBe("completed");
    expect(final?.providerId).toBe("provider-b");
    expect(providerA.callCount).toBeGreaterThanOrEqual(1);
    expect(providerB.callCount).toBe(1);
    // Exactly one hold during B's call, and it is on B's route — never a double-spend of A's.
    expect(heldRoutesDuringB).toEqual({ [`fabric:provider-b`]: 1 });
    expect(fabric.reservationSnapshot()?.activeReservations).toBe(0);
  });

  it("one user's per-user pool is unreachable by another user's turn, and reachable by its owner's", async () => {
    const bobRoute = userPoolRoute("hash-user-b");
    registerFleet("user-cloud", "user-model");
    const fabric = makeFabric([bobRoute], [poolFor(bobRoute)]);

    const provider = new ScriptedRouteProvider("user-cloud", "user-model", () => okEvents());
    catalog.register(provider);

    // User A's runtime: the only supply in the fabric is Bob's — nothing managed, nothing
    // owned by A. Admission must deny, the turn must fail, and Bob's quota is untouched.
    const runtimeA = makeRuntime("sess-fabric-isa", fabric, "user-a");
    await runtimeA.init();
    const turnA = await runtimeA.startTurn("Say hello");
    const finalA = await waitForTerminal(runtimeA, persistence, "sess-fabric-isa", turnA);
    expect(finalA?.status).toBe("failed");
    expect(provider.callCount).toBe(0);

    // User B's runtime: the same route is admitted under B's own identity.
    const runtimeB = makeRuntime("sess-fabric-isb", fabric, "user-b");
    await runtimeB.init();
    const turnB = await runtimeB.startTurn("Say hello");
    const finalB = await waitForTerminal(runtimeB, persistence, "sess-fabric-isb", turnB);
    expect(finalB?.status).toBe("completed");
    expect(provider.callCount).toBe(1);
    expect(fabric.reservationSnapshot()?.activeReservations).toBe(0);
  });

  it("a workflow-owned turn parks durably on capacity wait and resumes on a fresh admission", async () => {
    const route = managedRoute("provider-a", { windows: [quotaWindow({ limit: 1, remaining: 1 }), quotaWindow({ unit: "input_tokens", limit: 2_000_000, remaining: 2_000_000 })] });
    registerFleet("provider-a", "provider-a-model");
    const fabric = makeFabric([route], [poolFor(route)]);
    const holdout = fabric.decide({ requestId: "other-user-hold", userId: "user-other", role: "PRIMARY_CODING_AGENT" });
    expect(holdout.outcome).toBe("ADMITTED");

    const provider = new ScriptedRouteProvider("provider-a", "provider-a-model", () => okEvents());
    catalog.register(provider);
    const runtime = makeRuntime("sess-fabric-wf", fabric);
    await runtime.init();
    const workflowAdapter = createWorkspaceEventAdapter({ sessionId: "sess-fabric-wf", eventStore, persistence, runId: "wf-task-1" });
    const turnId = await runtime.startTurn("Implement step", workflowAdapter, { origin: "workflow", label: "Implementing" });
    for (let i = 0; i < 100 && runtime.getTurn(turnId)?.status !== "waiting_for_free_capacity"; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(runtime.getTurn(turnId)?.status).toBe("waiting_for_free_capacity");
    expect(provider.callCount).toBe(0);
    const waitItem = await persistence.getWorkItem(`free-capacity-wait-${turnId}`);
    expect(waitItem).toMatchObject({ kind: "free_capacity_wait", state: "waiting", turnId });

    // Capacity returns — the workflow's probe-driven resume lands the turn on the freed slot.
    expect(fabric.release(holdout.selected!.reservationId!)).toBe(true);
    await runtime.resumeTurn(turnId);
    const final = await waitForTerminal(runtime, persistence, "sess-fabric-wf", turnId);
    expect(final?.status).toBe("completed");
    expect(provider.callCount).toBe(1);
    expect(await persistence.getWorkItem(`free-capacity-wait-${turnId}`)).toMatchObject({ state: "resumed" });
    expect(fabric.reservationSnapshot()?.activeReservations).toBe(0);
  });

  it("mid-turn provider exhaustion parks the turn and resumes on an independent pool", async () => {
    const routeA = managedRoute("provider-a", { qualityScore: 60 });
    // B outranks A, so the external hold takes B's only slot deterministically and the turn's
    // own admission falls to A — whose mid-stream 429 then has nowhere admissible to rotate to.
    const routeB = managedRoute("provider-b", { qualityScore: 95, windows: [quotaWindow({ limit: 1, remaining: 1 }), quotaWindow({ unit: "input_tokens", limit: 2_000_000, remaining: 2_000_000 })] });
    registerFleet("provider-a", "provider-a-model");
    registerFleet("provider-b", "provider-b-model");
    const fabric = makeFabric([routeA, routeB], [poolFor(routeA), poolFor(routeB)]);
    const holdout = fabric.decide({ requestId: "other-user-hold", userId: "user-other", role: "PRIMARY_CODING_AGENT" });
    expect(holdout.selected?.capacityPoolId).toBe("shared:provider-b");

    const providerA = new ScriptedRouteProvider("provider-a", "provider-a-model", () => [
      { type: "error", code: "PROVIDER_RATE_LIMITED", status: 429, message: "429 rate limited", retryable: true },
    ]);
    const providerB = new ScriptedRouteProvider("provider-b", "provider-b-model", () => okEvents());
    catalog.register(providerA);
    catalog.register(providerB);

    const runtime = makeRuntime("sess-fabric-midturn", fabric);
    await runtime.init();
    const turnId = await runtime.startTurn("Do work");
    for (let i = 0; i < 200 && runtime.getTurn(turnId)?.status !== "waiting_for_free_capacity"; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const parked = runtime.getTurn(turnId);
    expect(parked?.status).toBe("waiting_for_free_capacity");
    expect(providerA.callCount).toBeGreaterThanOrEqual(1);
    expect(providerB.callCount).toBe(0);
    // Parked turns hold no reservation — the failed route's hold was settled at park time.
    expect(fabric.reservationSnapshot()?.activeReservations).toBe(1);

    fabric.release(holdout.selected!.reservationId!);
    await runtime.resumeTurn(turnId);
    const final = await waitForTerminal(runtime, persistence, "sess-fabric-midturn", turnId);
    expect(final?.status).toBe("completed");
    // Cross-pool migration: the resume admitted the other physical pool, not just another model.
    expect(final?.providerId).toBe("provider-b");
    expect(final?.capacityPoolId).toBe("shared:provider-b");
    expect(providerB.callCount).toBe(1);
    expect(fabric.reservationSnapshot()?.activeReservations).toBe(0);
  });

  it("a mid-turn park survives a runtime restart and resumes on independent supply without replaying tools", async () => {
    await fs.writeFile(path.join(tmpDir, "target.ts"), "export const value = 1;\n");
    const routeA = managedRoute("provider-a", { qualityScore: 95 });
    // B exists but its request window is exhausted — the failover re-decide has supply to
    // point at yet nothing admissible, which is exactly QUEUED_FOR_CAPACITY. The pool and the
    // route share one windows array, so raising `remaining` models the provider's quota reset.
    const routeB = managedRoute("provider-b", { qualityScore: 60, windows: [quotaWindow({ limit: 1, remaining: 0 }), quotaWindow({ unit: "input_tokens", limit: 2_000_000, remaining: 2_000_000 })] });
    registerFleet("provider-a", "provider-a-model");
    registerFleet("provider-b", "provider-b-model");
    const poolB = poolFor(routeB);
    const fabric = makeFabric([routeA, routeB], [poolFor(routeA), poolB]);

    const providerA = new ScriptedRouteProvider("provider-a", "provider-a-model", (call) => {
      if (call === 1) {
        const id = "tc-read-1";
        return [
          { type: "tool_call_started", toolCallId: id, toolName: "read_file" },
          { type: "tool_call_completed", toolCallId: id, toolName: "read_file", arguments: JSON.stringify({ path: "target.ts" }) },
          { type: "finish", finishReason: "tool_calls" },
        ];
      }
      return [{ type: "error", code: "PROVIDER_RATE_LIMITED", status: 429, message: "429 rate limited", retryable: true }];
    });
    const providerB = new ScriptedRouteProvider("provider-b", "provider-b-model", () => okEvents());
    catalog.register(providerA);
    catalog.register(providerB);

    const runtime = makeRuntime("sess-fabric-restart", fabric);
    await runtime.init();
    const turnId = await runtime.startTurn("Inspect target.ts and report");
    for (let i = 0; i < 200 && runtime.getTurn(turnId)?.status !== "waiting_for_free_capacity"; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(runtime.getTurn(turnId)?.status).toBe("waiting_for_free_capacity");
    // The park happened after the turn had a live route — durable evidence a restart must
    // restore as a mid-turn wait (the no-replay directive), not a clean admission wait.
    expect(providerA.callCount).toBe(2);
    expect(await persistence.getWorkItem(`free-capacity-wait-${turnId}`)).toMatchObject({ kind: "free_capacity_wait", state: "waiting", midTurn: true });

    // Process restart: a fresh runtime hydrates the parked turn from durable state alone.
    const restored = makeRuntime("sess-fabric-restart", fabric);
    await restored.init();
    const restoredTurn = restored.getTurn(turnId);
    expect(restoredTurn?.status).toBe("waiting_for_free_capacity");

    // Supply returns on the OTHER pool (quota window reset); the resumed turn must carry the
    // no-replay directive onto the replacement route.
    poolB.windows[0] = { ...poolB.windows[0], remaining: 1 };
    await restored.resumeTurn(turnId);
    const final = await waitForTerminal(restored, persistence, "sess-fabric-restart", turnId);
    expect(final?.status).toBe("completed");
    expect(final?.capacityPoolId).toBe("shared:provider-b");
    expect(providerB.callCount).toBe(1);
    const resumedMessages = providerB.requests[0]?.messages ?? [];
    expect(resumedMessages.some((m) => typeof m.content === "string" && m.content.includes("[Capacity directive]"))).toBe(true);
    expect(fabric.reservationSnapshot()?.activeReservations).toBe(0);
  });

  it("a review turn prefers a quota pool independent of the implementation route", async () => {
    // Comparable scores let the bounded independence preference overcome A's recent
    // successful implementation health adjustment without hiding a large quality gap.
    const routeA = managedRoute("provider-a", { qualityScore: 95 });
    const routeB = managedRoute("provider-b", { qualityScore: 94 });
    registerFleet("provider-a", "provider-a-model");
    registerFleet("provider-b", "provider-b-model");
    const fabric = makeFabric([routeA, routeB], [poolFor(routeA), poolFor(routeB)]);
    catalog.register(new ScriptedRouteProvider("provider-a", "provider-a-model", () => okEvents()));
    catalog.register(new ScriptedRouteProvider("provider-b", "provider-b-model", () => okEvents()));

    const runtime = makeRuntime("sess-review-independence", fabric);
    await runtime.init();
    const implTurn = await runtime.startTurn("Implement the change");
    const implFinal = await waitForTerminal(runtime, persistence, "sess-review-independence", implTurn);
    expect(implFinal?.status).toBe("completed");
    expect(implFinal?.capacityPoolId).toBe("shared:provider-a");

    const reviewTurn = await runtime.startTurn("Review the change", undefined, {
      origin: "workflow",
      label: "Reviewing goal conformance",
      capacityHint: { role: "REVIEWER", healthRole: "REVIEWER", fallbackRole: "CODER", preferIndependentFromPoolId: "shared:provider-a" },
    });
    const reviewFinal = await waitForTerminal(runtime, persistence, "sess-review-independence", reviewTurn);
    expect(reviewFinal?.status).toBe("completed");
    expect(reviewFinal?.capacityPoolId).toBe("shared:provider-b");
  });

  it("a review turn on a single-pool fleet falls back honestly instead of denying review", async () => {
    const routeA = managedRoute("provider-a");
    registerFleet("provider-a", "provider-a-model");
    const fabric = makeFabric([routeA], [poolFor(routeA)]);
    catalog.register(new ScriptedRouteProvider("provider-a", "provider-a-model", () => okEvents()));

    const runtime = makeRuntime("sess-review-samepool", fabric);
    await runtime.init();
    const reviewTurn = await runtime.startTurn("Review the change", undefined, {
      origin: "workflow",
      capacityHint: { role: "REVIEWER", healthRole: "REVIEWER", fallbackRole: "CODER", preferIndependentFromPoolId: "shared:provider-a" },
    });
    const final = await waitForTerminal(runtime, persistence, "sess-review-samepool", reviewTurn);
    // Same-pool fallback is the honest outcome — recorded, not hidden; review still ran.
    expect(final?.status).toBe("completed");
    expect(final?.capacityPoolId).toBe("shared:provider-a");
  });

  it("a review turn widens to coding-capable supply when no reviewer-qualified route exists", async () => {
    const routeA = managedRoute("provider-a", { roles: ["PRIMARY_CODING_AGENT"] });
    registerFleet("provider-a", "provider-a-model");
    const fabric = makeFabric([routeA], [poolFor(routeA)]);
    catalog.register(new ScriptedRouteProvider("provider-a", "provider-a-model", () => okEvents()));

    const runtime = makeRuntime("sess-review-fallback", fabric);
    await runtime.init();
    const reviewTurn = await runtime.startTurn("Review the change", undefined, {
      origin: "workflow",
      capacityHint: { role: "REVIEWER", healthRole: "REVIEWER", fallbackRole: "CODER" },
    });
    const final = await waitForTerminal(runtime, persistence, "sess-review-fallback", reviewTurn);
    expect(final?.status).toBe("completed");
    expect(final?.capacityPoolId).toBe("shared:provider-a");
  });

  it("a parked user turn can be cancelled while waiting and never resumes or executes", async () => {
    const route = managedRoute("provider-a", { windows: [quotaWindow({ limit: 1, remaining: 1 }), quotaWindow({ unit: "input_tokens", limit: 2_000_000, remaining: 2_000_000 })] });
    registerFleet("provider-a", "provider-a-model");
    const fabric = makeFabric([route], [poolFor(route)]);
    const holdout = fabric.decide({ requestId: "other-user-hold", userId: "user-other", role: "PRIMARY_CODING_AGENT" });
    expect(holdout.outcome).toBe("ADMITTED");

    const provider = new ScriptedRouteProvider("provider-a", "provider-a-model", () => okEvents());
    catalog.register(provider);
    const runtime = makeRuntime("sess-fabric-cancel", fabric);
    await runtime.init();
    const turnId = await runtime.startTurn("Say hello");
    for (let i = 0; i < 100 && runtime.getTurn(turnId)?.status !== "waiting_for_free_capacity"; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(runtime.getTurn(turnId)?.status).toBe("waiting_for_free_capacity");

    await runtime.cancelTurn(turnId, "user stopped waiting");
    expect(runtime.getTurn(turnId)?.status).toBe("cancelled");
    expect(await persistence.getWorkItem(`free-capacity-wait-${turnId}`)).toMatchObject({ state: "cancelled" });

    // Capacity returning afterwards must not resurrect a cancelled turn.
    fabric.release(holdout.selected!.reservationId!);
    await expect(runtime.resumeTurn(turnId)).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 50));
    expect(provider.callCount).toBe(0);
    expect(runtime.getTurn(turnId)?.status).toBe("cancelled");
  });

  it("the capacity sweeper resumes a parked turn on its own once supply returns", async () => {
    const route = managedRoute("provider-a", { windows: [quotaWindow({ limit: 1, remaining: 1 }), quotaWindow({ unit: "input_tokens", limit: 2_000_000, remaining: 2_000_000 })] });
    registerFleet("provider-a", "provider-a-model");
    const fabric = makeFabric([route], [poolFor(route)]);
    const holdout = fabric.decide({ requestId: "other-user-hold", userId: "user-other", role: "PRIMARY_CODING_AGENT" });
    expect(holdout.outcome).toBe("ADMITTED");

    const provider = new ScriptedRouteProvider("provider-a", "provider-a-model", () => okEvents());
    catalog.register(provider);
    const runtime = createAgentRuntime({
      sessionId: "sess-fabric-sweep",
      eventStore,
      persistence,
      firewall,
      providerCatalog: catalog,
      workspacePath: tmpDir,
      routeHealth: authority,
      freeFabric: fabric,
      capacityWaitRetryMs: 20,
      fabricContext: () => ({ userId: "user-sweep", userIdentities: [] }),
    });
    await runtime.init();
    const turnId = await runtime.startTurn("Say hello");
    for (let i = 0; i < 100 && runtime.getTurn(turnId)?.status !== "waiting_for_free_capacity"; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(runtime.getTurn(turnId)?.status).toBe("waiting_for_free_capacity");

    // No explicit resume — the sweeper's own probe must drive it.
    fabric.release(holdout.selected!.reservationId!);
    const final = await waitForTerminal(runtime, persistence, "sess-fabric-sweep", turnId);
    expect(final?.status).toBe("completed");
    expect(provider.callCount).toBe(1);
    expect(await persistence.getWorkItem(`free-capacity-wait-${turnId}`)).toMatchObject({ state: "resumed" });
    await runtime.shutdown();
  });

  it("two sessions contend for one shared slot through the shared ledger — the waiting turn resumes after release", async () => {
    const route = managedRoute("provider-a", { windows: [quotaWindow({ limit: 1, remaining: 1 }), quotaWindow({ unit: "input_tokens", limit: 2_000_000, remaining: 2_000_000 })] });
    registerFleet("provider-a", "provider-a-model");
    const fabric = makeFabric([route], [poolFor(route)]);

    // Session A's provider call blocks on a test gate: while it is in flight the turn holds
    // the pool's only slot, which is exactly when session B's admission attempt must queue.
    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
    class GatedProvider extends ScriptedRouteProvider {
      override async *streamChat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
        this.callCount++;
        await gateA;
        yield* okEvents();
      }
    }
    const gatedProvider = new GatedProvider("provider-a", "provider-a-model", () => okEvents());
    catalog.register(gatedProvider);

    const runtimeA = makeRuntime("sess-fabric-a", fabric, "user-a");
    const runtimeB = makeRuntime("sess-fabric-b", fabric, "user-b");
    await runtimeA.init();
    await runtimeB.init();

    const turnA = await runtimeA.startTurn("Long work");
    // Give A's turn a beat to admit and enter the blocked provider call.
    for (let i = 0; i < 100 && gatedProvider.callCount === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(gatedProvider.callCount).toBe(1);
    expect(fabric.reservationSnapshot()?.activeReservations).toBe(1);

    // Session B asks the same fabric for the same single slot: QUEUED → durable wait.
    const turnB = await runtimeB.startTurn("Other work");
    for (let i = 0; i < 100 && runtimeB.getTurn(turnB)?.status !== "waiting_for_free_capacity"; i++) await new Promise((r) => setTimeout(r, 10));
    expect(runtimeB.getTurn(turnB)?.status).toBe("waiting_for_free_capacity");
    expect(gatedProvider.callCount).toBe(1); // B never reached the provider
    expect(fabric.reservationSnapshot()?.activeReservations).toBe(1);

    // Release A: the turn completes and settles its reservation; B's retry is then admitted.
    releaseA();
    const finalA = await waitForTerminal(runtimeA, persistence, "sess-fabric-a", turnA);
    expect(finalA?.status).toBe("completed");
    expect(fabric.reservationSnapshot()?.activeReservations).toBe(0);

    await runtimeB.resumeTurn(turnB);
    const finalB2 = await waitForTerminal(runtimeB, persistence, "sess-fabric-b", turnB);
    expect(finalB2?.status).toBe("completed");
    expect(gatedProvider.callCount).toBe(2);
    expect(fabric.reservationSnapshot()?.activeReservations).toBe(0);
  });

  it("a route with no Free Fabric presence cannot be reached by ForgeAuto even when it is firewall-eligible", async () => {
    // The fleet has a firewall-eligible model + adapter, but the fabric's route table is
    // empty (e.g. registry projection dropped it). Pre-Mission-C ranking would have served it;
    // authoritative admission must not.
    registerFleet("provider-x", "provider-x-model");
    const fabric = makeFabric([], []);
    const provider = new ScriptedRouteProvider("provider-x", "provider-x-model", () => okEvents());
    catalog.register(provider);

    const runtime = makeRuntime("sess-fabric-empty", fabric);
    await runtime.init();
    const turnId = await runtime.startTurn("Say hello");
    const final = await waitForTerminal(runtime, persistence, "sess-fabric-empty", turnId);

    expect(final?.status).toBe("failed");
    expect(provider.callCount).toBe(0);
  });

  it("R51: unmeasured supply without a measure hook fails closed — never parked on a window that cannot return", async () => {
    // GitHub Models shape (R33 audit): the route is eligible but emits zero quota windows.
    // The old semantics queued it — a durable park with no reset and no possible recovery,
    // since admission is what produces the headers. Now the verdict is DENIED/UNMEASURED:
    // honest failure for callers that cannot measure, never a fabricated wait.
    const unmeasured = managedRoute("provider-a", { windows: [] });
    registerFleet("provider-a", "provider-a-model");
    const fabric = makeFabric([unmeasured], [poolFor(unmeasured, { windows: [] })]);
    const provider = new ScriptedRouteProvider("provider-a", "provider-a-model", () => okEvents());
    catalog.register(provider);

    const runtime = makeRuntime("sess-fabric-unmeasured", fabric);
    await runtime.init();
    const turnId = await runtime.startTurn("Say hello");
    const final = await waitForTerminal(runtime, persistence, "sess-fabric-unmeasured", turnId);

    expect(final?.status).toBe("failed");
    expect(provider.callCount).toBe(0);
    // The smoking gun for the old bug: a durable free-capacity-wait work item would have
    // parked this turn forever. None may exist.
    expect(await persistence.getWorkItem(`free-capacity-wait-${turnId}`)).toBeUndefined();
  });

  it("R51: unmeasured supply with a measure hook probes on demand and then executes", async () => {
    // The quota domain starts unmeasured (windows:[] → CAPACITY_UNMEASURED). The runtime's
    // admission pre-step calls freeCloud.probeRouteCapacity — a bounded measurement that
    // lands real windows — and the same turn's re-decide then admits. No park, no paid path.
    let measured = false;
    const unmeasured = managedRoute("provider-a", { windows: [] });
    const measuredRoute = managedRoute("provider-a");
    registerFleet("provider-a", "provider-a-model");
    const fabric = createFreeFabric({
      managedRoutes: () => [measured ? measuredRoute : unmeasured],
      managedPools: () => [measured ? poolFor(measuredRoute) : poolFor(unmeasured, { windows: [] })],
      userSources: [],
      health: authority,
      reservations: new CapacityReservationLedger({ routes: [], pools: [] }),
    });
    const provider = new ScriptedRouteProvider("provider-a", "provider-a-model", () => okEvents());
    catalog.register(provider);
    let probeCalls = 0;
    const freeCloud: import("@codeforge/model-registry").FreeCloudRoutingHooks = {
      isForgeAutoEligible: () => true,
      canonicalIdOf: (p: string, m: string) => `${p}/${m}`,
      sameModelAlternates: () => [],
      recordRouteFailure: () => undefined,
      recordRouteSuccess: () => undefined,
      quotaRemaining: () => undefined,
      capacityRoutingAdvice: () => ({ scoreAdjustment: 0, reasonCodes: [] }),
      probeRouteCapacity: async () => { probeCalls++; measured = true; return true; },
    };

    const runtime = makeRuntime("sess-fabric-probe", fabric, undefined, freeCloud);
    await runtime.init();
    const turnId = await runtime.startTurn("Say hello");
    const final = await waitForTerminal(runtime, persistence, "sess-fabric-probe", turnId);

    expect(final?.status).toBe("completed");
    expect(probeCalls).toBe(1);
    expect(provider.callCount).toBe(1);
    expect(await persistence.getWorkItem(`free-capacity-wait-${turnId}`)).toBeUndefined();
  });

  it("R59: a denial resting on pending qualification kicks one recovery cycle and the same turn admits the measured route", async () => {
    // The R58 false-zero shape: verified-free routes exist but have no qualification receipt
    // yet, so the fabric's plan is empty and admission denies. The runtime must close that
    // measurement gap before reporting "no eligible route" — one bounded recovery cycle, not
    // a terminal denial.
    let recovered = false;
    const route = managedRoute("provider-a");
    registerFleet("provider-a", "provider-a-model");
    const fabric = createFreeFabric({
      managedRoutes: () => (recovered ? [route] : []),
      managedPools: () => (recovered ? [poolFor(route)] : []),
      userSources: [],
      health: authority,
      reservations: new CapacityReservationLedger({ routes: [], pools: [] }),
    });
    const provider = new ScriptedRouteProvider("provider-a", "provider-a-model", () => okEvents());
    catalog.register(provider);
    const kicks: Array<{ providerId?: string; recovery?: boolean } | undefined> = [];
    const freeCloud: import("@codeforge/model-registry").FreeCloudRoutingHooks = {
      isForgeAutoEligible: () => true,
      canonicalIdOf: (p: string, m: string) => `${p}/${m}`,
      sameModelAlternates: () => [],
      recordRouteFailure: () => undefined,
      recordRouteSuccess: () => undefined,
      quotaRemaining: () => undefined,
      capacityRoutingAdvice: () => ({ scoreAdjustment: 0, reasonCodes: [] }),
      pendingQualification: () => (recovered ? [] : [{} as import("@codeforge/model-registry").ProviderRouteView]),
      isQualifying: () => false,
      qualifyPending: async (opts) => {
        kicks.push(opts);
        recovered = true; // the cycle produced the receipt — the route is now admissible
        return [];
      },
    };

    const runtime = makeRuntime("sess-fabric-r59-recover", fabric, undefined, freeCloud);
    await runtime.init();
    const turnId = await runtime.startTurn("Say hello");
    const final = await waitForTerminal(runtime, persistence, "sess-fabric-r59-recover", turnId);

    expect(final?.status).toBe("completed");
    expect(provider.callCount).toBe(1);
    expect(kicks.length).toBeGreaterThan(0);
    expect(kicks[0]?.recovery).toBe(true);
  });

  it("R59: a receipt landing between recovery rounds still admits — the loop re-decides on live qualification evidence", async () => {
    // The packaged dogfood signature: the lane's suite was in flight when the admission's
    // single recovery wait expired, and the verdict persisted seconds later — too late. The
    // bounded loop must keep re-deciding while a lane is live so landed evidence admits.
    let recovered = false;
    let qualifying = true;
    let sawPreFlightMark = false;
    const route = managedRoute("provider-a");
    registerFleet("provider-a", "provider-a-model");
    const fabric = createFreeFabric({
      managedRoutes: () => (recovered ? [route] : []),
      managedPools: () => (recovered ? [poolFor(route)] : []),
      userSources: [],
      health: authority,
      reservations: new CapacityReservationLedger({ routes: [], pools: [] }),
    });
    const provider = new ScriptedRouteProvider("provider-a", "provider-a-model", () =>
      okEvents(JSON.stringify({ summary: "Done.", findings: [], evidence: [] })));
    catalog.register(provider);
    const freeCloud: import("@codeforge/model-registry").FreeCloudRoutingHooks = {
      isForgeAutoEligible: () => true,
      canonicalIdOf: (p: string, m: string) => `${p}/${m}`,
      sameModelAlternates: () => [],
      recordRouteFailure: () => undefined,
      recordRouteSuccess: () => undefined,
      quotaRemaining: () => undefined,
      capacityRoutingAdvice: () => ({ scoreAdjustment: 0, reasonCodes: [] }),
      pendingQualification: () => (recovered ? [] : [{} as import("@codeforge/model-registry").ProviderRouteView]),
      isQualifying: () => qualifying,
      qualificationSummary: () => [{ providerId: "provider-a", pending: recovered ? 0 : 1, qualifying, requestsSpentToday: 1, dailyBudget: 24 }],
      qualifyPending: async () => {
        // The in-flight suite persists its receipt mid-recovery, after the first wait round.
        sawPreFlightMark = runtime.isInPreFlightWait("run-fabric-r59-loop");
        setTimeout(() => { recovered = true; qualifying = false; }, 400);
        return [];
      },
    };

    const runtime = makeRuntime("sess-fabric-r59-loop", fabric, undefined, freeCloud, {
      qualificationWaitHorizonMs: 120,
      qualificationRecoveryBudgetMs: 15_000,
    });
    await runtime.init();
    const adapter = createWorkspaceEventAdapter({ sessionId: "sess-fabric-r59-loop", eventStore, persistence });
    const result = await runtime.executeAgentRun({
      runId: "run-fabric-r59-loop",
      agentId: "coder-loop",
      role: "coder",
      goal: "Do the task",
      workspaceId: "ws-fabric",
      workspacePath: tmpDir,
      permissions: { read: true, search: true, write: true, executeCommand: true, network: false },
      roleRouting: true,
      adapter,
    });

    expect(result.status).toBe("completed");
    expect(provider.callCount).toBe(1);
    // The subagent watchdog reads this mark as liveness through admission/recovery; it must
    // be set during the wait and cleared once the run leaves pre-flight.
    expect(sawPreFlightMark).toBe(true);
    expect(runtime.isInPreFlightWait("run-fabric-r59-loop")).toBe(false);
  });

  it("R59: cooled routes hide from pending but an armed recovery retry is live evidence", async () => {
    // Packaged-dogfood signature: every unqualified route on the provider sat in transient
    // cooldown, so pendingQualification() reported 0 while a recovery timer was armed for the
    // earliest cooldown expiry. Reading that lane as dead denied admission minutes before the
    // scheduled retry could land a verdict.
    let recovered = false;
    const route = managedRoute("provider-a");
    registerFleet("provider-a", "provider-a-model");
    const fabric = createFreeFabric({
      managedRoutes: () => (recovered ? [route] : []),
      managedPools: () => (recovered ? [poolFor(route)] : []),
      userSources: [],
      health: authority,
      reservations: new CapacityReservationLedger({ routes: [], pools: [] }),
    });
    const provider = new ScriptedRouteProvider("provider-a", "provider-a-model", () =>
      okEvents(JSON.stringify({ summary: "Done.", findings: [], evidence: [] })));
    catalog.register(provider);
    const freeCloud: import("@codeforge/model-registry").FreeCloudRoutingHooks = {
      isForgeAutoEligible: () => true,
      canonicalIdOf: (p: string, m: string) => `${p}/${m}`,
      sameModelAlternates: () => [],
      recordRouteFailure: () => undefined,
      recordRouteSuccess: () => undefined,
      quotaRemaining: () => undefined,
      capacityRoutingAdvice: () => ({ scoreAdjustment: 0, reasonCodes: [] }),
      // Nothing pending — every candidate is cooled. The armed retry is what makes the lane live.
      pendingQualification: () => [],
      isQualifying: () => false,
      qualificationSummary: () => [{
        providerId: "provider-a",
        pending: 0,
        qualifying: false,
        requestsSpentToday: 4,
        dailyBudget: 24,
        liveEvidence: !recovered,
        recoveryScheduledAt: new Date(Date.now() + 500).toISOString(),
      }],
      qualifyPending: async () => [],
    };
    // The armed recovery timer fires: cooled routes re-enter pending, the retry runs, and the
    // verdict lands — the lane stops being live once its evidence has arrived.
    setTimeout(() => { recovered = true; }, 600);

    const runtime = makeRuntime("sess-fabric-r59-cooled", fabric, undefined, freeCloud, {
      qualificationWaitHorizonMs: 120,
      qualificationRecoveryBudgetMs: 15_000,
    });
    await runtime.init();
    const adapter = createWorkspaceEventAdapter({ sessionId: "sess-fabric-r59-cooled", eventStore, persistence });
    const result = await runtime.executeAgentRun({
      runId: "run-fabric-r59-cooled",
      agentId: "coder-cooled",
      role: "coder",
      goal: "Do the task",
      workspaceId: "ws-fabric",
      workspacePath: tmpDir,
      permissions: { read: true, search: true, write: true, executeCommand: true, network: false },
      roleRouting: true,
      adapter,
    });

    expect(result.status).toBe("completed");
    expect(provider.callCount).toBe(1);
  });

  it("R59: the recovery loop stays bounded — a lane with no live evidence denies on schedule", async () => {
    let kicks = 0;
    registerFleet("provider-x", "provider-x-model");
    const fabric = makeFabric([], []);
    const provider = new ScriptedRouteProvider("provider-x", "provider-x-model", () => okEvents());
    catalog.register(provider);
    const freeCloud: import("@codeforge/model-registry").FreeCloudRoutingHooks = {
      isForgeAutoEligible: () => true,
      canonicalIdOf: (p: string, m: string) => `${p}/${m}`,
      sameModelAlternates: () => [],
      recordRouteFailure: () => undefined,
      recordRouteSuccess: () => undefined,
      quotaRemaining: () => undefined,
      capacityRoutingAdvice: () => ({ scoreAdjustment: 0, reasonCodes: [] }),
      // Pending forever, never in flight, budget spent — nothing can land a verdict.
      pendingQualification: () => [{} as import("@codeforge/model-registry").ProviderRouteView],
      isQualifying: () => false,
      qualificationSummary: () => [{ providerId: "provider-x", pending: 1, qualifying: false, requestsSpentToday: 24, dailyBudget: 24 }],
      qualifyPending: async () => { kicks++; return []; },
    };

    const runtime = makeRuntime("sess-fabric-r59-bounded", fabric, undefined, freeCloud, {
      qualificationWaitHorizonMs: 120,
      qualificationRecoveryBudgetMs: 15_000,
    });
    await runtime.init();
    const adapter = createWorkspaceEventAdapter({ sessionId: "sess-fabric-r59-bounded", eventStore, persistence });
    const result = await runtime.executeAgentRun({
      runId: "run-fabric-r59-bounded",
      agentId: "coder-bounded",
      role: "coder",
      goal: "Do the task",
      workspaceId: "ws-fabric",
      workspacePath: tmpDir,
      permissions: { read: true, search: true, write: true, executeCommand: true, network: false },
      roleRouting: true,
      adapter,
    });

    expect(result.status).toBe("failed");
    expect(provider.callCount).toBe(0);
    expect(kicks).toBeLessThanOrEqual(1);
  });

  it("R59: a denial with nothing pending stays denied — recovery never fabricates supply", async () => {
    registerFleet("provider-x", "provider-x-model");
    const fabric = makeFabric([], []);
    const provider = new ScriptedRouteProvider("provider-x", "provider-x-model", () => okEvents());
    catalog.register(provider);
    let kicks = 0;
    const freeCloud: import("@codeforge/model-registry").FreeCloudRoutingHooks = {
      isForgeAutoEligible: () => true,
      canonicalIdOf: (p: string, m: string) => `${p}/${m}`,
      sameModelAlternates: () => [],
      recordRouteFailure: () => undefined,
      recordRouteSuccess: () => undefined,
      quotaRemaining: () => undefined,
      capacityRoutingAdvice: () => ({ scoreAdjustment: 0, reasonCodes: [] }),
      pendingQualification: () => [],
      isQualifying: () => false,
      qualifyPending: async () => { kicks++; return []; },
    };

    const runtime = makeRuntime("sess-fabric-r59-empty", fabric, undefined, freeCloud);
    await runtime.init();
    const turnId = await runtime.startTurn("Say hello");
    const final = await waitForTerminal(runtime, persistence, "sess-fabric-r59-empty", turnId);

    expect(final?.status).toBe("failed");
    expect(provider.callCount).toBe(0);
    expect(kicks).toBe(0); // nothing pending → no wasted probe spend
    expect(fabric.reservationSnapshot()?.activeReservations).toBe(0);
  });
});
