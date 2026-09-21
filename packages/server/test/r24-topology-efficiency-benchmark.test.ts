import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { ForgeZero, createGenericFreeRecord, CapacityReservationLedger, type CapacityRoute, type CapacityWindow, type ProviderCapacityPool } from "@codeforge/forge-zero";
import { InMemoryProviderCatalog, type ChatRequest, type ChatResponse, type ProviderAdapter, type ProviderModel, type StreamEvent } from "@codeforge/providers";
import { EventStore, createSessionPersistence, type ISessionPersistence } from "@codeforge/sessions";
import { createEightBitRouteHealthAuthority, createFreeFabric, type FreeFabric } from "@codeforge/eight-bit";
import { createAgentRuntime, type AgentRuntime } from "../src/agent-runtime.js";
import { createAutonomousRunOrchestrator, type AutonomousRunResult } from "../src/autonomous-orchestrator.js";
import { createWorkspaceService } from "../src/workspace-service.js";
import { createWorkspaceEventAdapter } from "../src/workspace-event-adapter.js";

const execFile = promisify(execFileCallback);

/**
 * R24 paired benchmark — verified useful work per unit of free capacity.
 *
 * ARM A: the certified fixed_r1 baseline team (2 explorers -> planner -> coder -> reviewer).
 * ARM B: the adaptive path under observed constrained capacity — ForgeGreen's provider-aware
 *        topology advice serializes parallel exploration instead of spawning it.
 *
 * Both arms run the SAME complex-classified goal against the SAME repository state through the
 * REAL production path: subagent manager -> role-routed executeAgentRun -> Free Fabric
 * admission -> scripted provider -> ForgeVerify -> completion gate. Each arm gets a fresh
 * repository fixture with identical content — a completed run integrates its change into the
 * target repo, so a shared mutable repo would contaminate the second arm's effective-change
 * check. The provider script is fixed per role, so correctness is equal by construction and
 * every difference in provider calls is attributable to the topology decision alone — a
 * mechanism benchmark, not a live-model claim.
 */

const OBSERVED_AT = new Date(Date.now() - 60_000).toISOString();
const NO_RESET = "9999-12-31T23:59:59.999Z";
const GOAL = "Migrate the database from SQLite to PostgreSQL across the api and the frontend";

type Role = "explorer" | "planner" | "reviewer";

function roleOf(req: ChatRequest): Role {
  const text = req.messages.map((m) => m.content ?? "").join("\n");
  if (text.includes("Review implementation for goal")) return "reviewer";
  if (text.includes("Produce the minimal task graph for goal")) return "planner";
  return "explorer";
}

const EXPLORER_RESULT = JSON.stringify({
  summary: "Repository mapped: math module, tests, and boundaries identified.",
  findings: [],
  evidence: [{ kind: "file", ref: "src/math.ts", description: "Implementation target" }],
});
const PLANNER_RESULT = JSON.stringify({
  summary: "Minimal task graph.",
  tasks: [
    { id: "task-impl", title: "Implement migration", objective: GOAL, dependencies: [], assignedRole: "coder" },
    { id: "task-verify", title: "Verify migration", objective: "Run the project verification command", dependencies: ["task-impl"], assignedRole: "reviewer" },
  ],
  planningIntent: {
    verification: ["run the project test command after implementation"],
    completionEvidence: ["the migration change is present and verification passes"],
  },
});
const REVIEWER_RESULT = JSON.stringify({ summary: "Changes verified against the goal.", verdict: "pass", findings: [] });

function toolCall(name: string, args: Record<string, unknown>): StreamEvent[] {
  const id = `tc-${name}-${Math.random().toString(16).slice(2)}`;
  return [
    { type: "tool_call_started", toolCallId: id, toolName: name },
    { type: "tool_call_delta", toolCallId: id, delta: JSON.stringify(args) },
    { type: "tool_call_completed", toolCallId: id, toolName: name, arguments: JSON.stringify(args) },
    { type: "usage", usage: { inputTokens: 1_000, outputTokens: 40 } },
    { type: "finish", finishReason: "tool_calls" },
  ];
}

function finalJson(json: string, inputTokens: number): StreamEvent[] {
  return [
    { type: "text_delta", delta: json },
    { type: "usage", usage: { inputTokens, outputTokens: 180 } },
    { type: "finish", finishReason: "stop" },
  ];
}

interface CallRecord { role: Role; inputTokens: number; outputTokens: number }

class RoleScriptedProvider implements ProviderAdapter {
  readonly providerId = "fabric-a";
  readonly isTestProvider = true;
  readonly calls: CallRecord[] = [];

  async listModels(): Promise<ProviderModel[]> {
    return [{ modelId: "fabric-a-model", displayName: "Fabric A", isFree: true, freeStatus: "verified_free", capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true } }];
  }
  async chat(_req: ChatRequest): Promise<ChatResponse> { throw new Error("Use streamChat"); }
  async *streamChat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    const role = roleOf(req);
    const toolResults = req.messages.filter((m) => m.role === "tool").length;
    const events: StreamEvent[] =
      role === "planner" ? finalJson(PLANNER_RESULT, 900)
      : role === "reviewer" ? finalJson(REVIEWER_RESULT, 1_100)
      : toolResults === 0 ? toolCall("list_files", { path: ".", recursive: false })
      : toolResults === 1 ? toolCall("read_file", { path: "src/math.ts" })
      : finalJson(EXPLORER_RESULT, 1_400);
    let inputTokens = 0;
    let outputTokens = 0;
    for (const event of events) {
      if (signal?.aborted) return;
      if (event.type === "usage") { inputTokens += event.usage.inputTokens; outputTokens += event.usage.outputTokens; }
      yield event;
    }
    this.calls.push({ role, inputTokens, outputTokens });
  }
  async healthCheck() { return { status: "available" as const }; }
}

function window(overrides: Partial<CapacityWindow> = {}): CapacityWindow {
  return { unit: "requests", limit: 500, remaining: 500, resetAt: NO_RESET, scope: "ORG", observedAt: OBSERVED_AT, authoritative: true, ...overrides };
}

function fabricRoute(): CapacityRoute {
  return {
    routeId: "fabric:provider-fabric-a",
    providerId: "fabric-a",
    modelId: "fabric-a-model",
    canonicalModelId: "fabric-a-model",
    family: "fabric-a",
    gateway: "fabric-a",
    supplyClass: "PURE_MANAGED_FREE",
    capacityPoolId: "shared:fabric-a",
    capacityPoolScope: "SHARED_OWNER_POOL",
    capacityScope: "ORG",
    dataPolicyProfile: "PRIVATE_CODE_ALLOWED",
    lifecycle: "APPROVED",
    explicitZeroPrice: true,
    paidFallbackDisabled: true,
    managedMultiUserAllowed: true,
    privacyClass: "standard",
    roles: ["PRIMARY_CODING_AGENT", "PLANNER", "REVIEWER", "SUBAGENT", "FAST_REASONER"],
    qualityScore: 70,
    healthy: true,
    enabled: true,
    windows: [window(), window({ unit: "input_tokens", limit: 8_000_000, remaining: 8_000_000 }), window({ unit: "concurrency", limit: 8, remaining: 8 })],
  };
}

function fabricPool(route: CapacityRoute): ProviderCapacityPool {
  return { poolId: route.capacityPoolId, providerId: route.providerId, scope: "SHARED_OWNER_POOL", supplyClass: route.supplyClass, windows: route.windows, observedAt: OBSERVED_AT, authoritative: true };
}

describe("R24 paired benchmark — fixed_r1 baseline vs adaptive topology under constrained capacity", () => {
  let targetRepos: string[];
  let worktreeBaseDir: string;
  let dbDir: string;
  let eventStore: EventStore;
  let persistence: ISessionPersistence;

  async function createTargetRepo(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "r24-bench-target-"));
    await execFile("git", ["init"], { cwd: dir });
    for (const [key, value] of [["user.name", "R24"], ["user.email", "r24@codeforge.test"], ["commit.gpgsign", "false"], ["core.autocrlf", "false"]]) await execFile("git", ["config", key!, value!], { cwd: dir });
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "bench", version: "1.0.0", type: "module", scripts: { test: "node -e \"process.exit(0)\"" } }, null, 2));
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "math.ts"), "export function add(a: number, b: number): number { return a + b; }\n");
    await execFile("git", ["add", "."], { cwd: dir });
    await execFile("git", ["commit", "-m", "initial"], { cwd: dir });
    targetRepos.push(dir);
    return dir;
  }

  beforeEach(async () => {
    targetRepos = [];
    worktreeBaseDir = await mkdtemp(join(tmpdir(), "r24-bench-worktrees-"));
    dbDir = await mkdtemp(join(tmpdir(), "r24-bench-db-"));
    eventStore = new EventStore();
    persistence = createSessionPersistence({ dbPath: join(dbDir, "sessions.db") });
    delete process.env.CODEFORGE_TOPOLOGY_POLICY;
  });

  afterEach(async () => {
    persistence.close();
    delete process.env.CODEFORGE_TOPOLOGY_POLICY;
    for (const dir of [...targetRepos, worktreeBaseDir, dbDir]) await rm(dir, { recursive: true, force: true });
  });

  async function runArm(arm: "fixed_r1" | "adaptive_constrained"): Promise<{ result: AutonomousRunResult; calls: CallRecord[]; maxHolds: number; totalAdmissions: number; leakedHolds: number }> {
    const targetRepo = await createTargetRepo();
    const provider = new RoleScriptedProvider();
    const catalog = new InMemoryProviderCatalog();
    catalog.register(provider);
    const firewall = new ForgeZero();
    firewall.register(createGenericFreeRecord({ providerId: "fabric-a", modelId: "fabric-a-model", displayName: "Fabric A" }));
    const route = fabricRoute();
    const reservations = new CapacityReservationLedger({ routes: [], pools: [], maxActiveReservationsPerUser: 8 });
    // Synchronous hold accounting — a polling probe cannot see reservations that live for a
    // single microtask hop. reserve() with a repeated id replaces in place, so track ids.
    const heldIds = new Set<string>();
    let maxHolds = 0;
    let totalAdmissions = 0;
    const innerReserve = reservations.reserve.bind(reservations);
    const innerRelease = reservations.release.bind(reservations);
    reservations.reserve = (request) => {
      const decision = innerReserve(request);
      if (decision.admitted) {
        totalAdmissions++;
        heldIds.add(request.reservationId);
        maxHolds = Math.max(maxHolds, heldIds.size);
      }
      return decision;
    };
    reservations.release = (reservationId) => {
      heldIds.delete(reservationId);
      return innerRelease(reservationId);
    };
    const fabric: FreeFabric = createFreeFabric({
      managedRoutes: () => [route],
      managedPools: () => [fabricPool(route)],
      health: createEightBitRouteHealthAuthority(),
      reservations,
    });
    const sessionId = `sess-${arm}`;
    const runtime: AgentRuntime = createAgentRuntime({
      sessionId,
      eventStore,
      persistence,
      firewall,
      providerCatalog: catalog,
      workspacePath: targetRepo,
      userId: "bench-user",
      freeFabric: fabric,
      fabricContext: ({ userId }) => ({ userId: userId ?? "bench-user", userIdentities: [] }),
    });
    const orchestrator = createAutonomousRunOrchestrator({
      workspaceService: createWorkspaceService({ persistence, worktreeParentDir: worktreeBaseDir }),
      persistence,
      subagentsR1Enabled: true,
      getAgentRuntime: () => runtime,
      ...(arm === "adaptive_constrained"
        ? { providerTopologyCapacity: () => ({ distinctHealthyProviders: 1, minimumRouteConcurrency: 1, saturatedRoutes: 0 }) }
        : {}),
    });
    const result = await orchestrator.startRun({
      sessionId,
      workspacePath: targetRepo,
      goal: GOAL,
      verificationCommands: ["node -e \"process.exit(0)\""],
      adapter: createWorkspaceEventAdapter({ sessionId, eventStore, persistence }),
      ...(arm === "fixed_r1" ? { topology: "fixed_r1" as const } : {}),
      coderExecutor: async (worktreePath) => {
        await writeFile(join(worktreePath, "src", "math.ts"), "export function add(a: number, b: number): number { return a + b; }\nexport function multiply(a: number, b: number): number { return a * b; }\n");
        return { success: true, filesChanged: ["src/math.ts"] };
      },
    });
    return { result, calls: provider.calls, maxHolds, totalAdmissions, leakedHolds: heldIds.size };
  }

  it("the adaptive arm reaches the same verified completion spending fewer provider calls — every spawned agent held a real fabric reservation", async () => {
    const a = await runArm("fixed_r1");
    const b = await runArm("adaptive_constrained");

    // Same verified outcome through the gate — the comparison is honest.
    expect(a.result.status).toBe("completed");
    expect(b.result.status).toBe("completed");
    expect(a.result.completion?.outcome).toBe("completed");
    expect(b.result.completion?.outcome).toBe("completed");

    // Topology receipts: the certified baseline vs the capacity-advised reduction.
    expect(a.result.topology?.plan.topology).toBe("fixed_r1");
    expect(b.result.topology?.plan.topology).toBe("normal");
    expect(b.result.topology?.providerCapacity).toEqual({ distinctHealthyProviders: 1, minimumRouteConcurrency: 1, saturatedRoutes: 0 });

    const count = (calls: CallRecord[], role: Role) => calls.filter((c) => c.role === role).length;
    const tokens = (calls: CallRecord[]) => calls.reduce((sum, c) => sum + c.inputTokens + c.outputTokens, 0);
    const callsA = a.calls.length;
    const callsB = b.calls.length;
    const tokensA = tokens(a.calls);
    const tokensB = tokens(b.calls);

    // Arm A: 2 explorers x 3 calls + planner + reviewer = 8. Arm B: explorer x 3 + reviewer = 4.
    expect(count(a.calls, "explorer")).toBe(6);
    expect(count(a.calls, "planner")).toBe(1);
    expect(count(a.calls, "reviewer")).toBe(1);
    expect(callsA).toBe(8);
    expect(count(b.calls, "explorer")).toBe(3);
    expect(count(b.calls, "planner")).toBe(0);
    expect(count(b.calls, "reviewer")).toBe(1);
    expect(callsB).toBe(4);

    // Every agent call ran inside a fabric reservation — the benchmark exercised real admission.
    // Each spawned agent admits exactly once (4 agents in arm A, 2 in arm B), and both fixed_r1
    // explorers' holds genuinely overlap while the serialized arm never exceeds one.
    expect(a.totalAdmissions).toBe(4);
    expect(b.totalAdmissions).toBe(2);
    expect(a.maxHolds).toBe(2);
    expect(b.maxHolds).toBe(1);
    expect(a.leakedHolds).toBe(0);
    expect(b.leakedHolds).toBe(0);

    const evidence = {
      armA: { topology: a.result.topology?.plan.topology, providerCalls: callsA, tokens: tokensA, childrenSpawned: a.result.counters.childrenSpawned, outcome: a.result.completion?.outcome },
      armB: { topology: b.result.topology?.plan.topology, providerCalls: callsB, tokens: tokensB, childrenSpawned: b.result.counters.childrenSpawned, outcome: b.result.completion?.outcome },
      providerCallRatio: callsA / callsB,
      tokenRatio: tokensA / tokensB,
    };
    console.log("R24_PAIRED_BENCHMARK", JSON.stringify(evidence));
    // The headline claim: half the provider calls, same verified outcome.
    expect(callsA).toBeGreaterThan(callsB);
    expect(tokensA).toBeGreaterThan(tokensB);
    expect(callsA / callsB).toBe(2);
  }, 120_000);
});
