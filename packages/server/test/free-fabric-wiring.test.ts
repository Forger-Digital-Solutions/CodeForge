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

  async *streamChat(_req: ChatRequest, _signal?: AbortSignal): AsyncIterable<StreamEvent> {
    this.callCount++;
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

  const makeRuntime = (sessionId: string, fabric: FreeFabric, userId?: string) =>
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

  it("a queued verdict fails the interactive turn closed — the provider is never called", async () => {
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
    const final = await waitForTerminal(runtime, persistence, "sess-fabric-queued", turnId);

    expect(final?.status).toBe("failed");
    expect(provider.callCount).toBe(0);
    // The denied turn left no stray hold behind; the earlier user's reservation is untouched.
    expect(fabric.reservationSnapshot()?.activeReservations).toBe(1);
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

  it("two sessions contend for one shared slot through the shared ledger — the loser fails closed, then succeeds after release", async () => {
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

    // Session B asks the same fabric for the same single slot: QUEUED → fail closed.
    const turnB = await runtimeB.startTurn("Other work");
    const finalB = await waitForTerminal(runtimeB, persistence, "sess-fabric-b", turnB);
    expect(finalB?.status).toBe("failed");
    expect(gatedProvider.callCount).toBe(1); // B never reached the provider
    expect(fabric.reservationSnapshot()?.activeReservations).toBe(1);

    // Release A: the turn completes and settles its reservation; B's retry is then admitted.
    releaseA();
    const finalA = await waitForTerminal(runtimeA, persistence, "sess-fabric-a", turnA);
    expect(finalA?.status).toBe("completed");
    expect(fabric.reservationSnapshot()?.activeReservations).toBe(0);

    const turnB2 = await runtimeB.startTurn("Other work, retried");
    const finalB2 = await waitForTerminal(runtimeB, persistence, "sess-fabric-b", turnB2);
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
});
