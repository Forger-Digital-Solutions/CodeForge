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
import { createAutonomousRunOrchestrator } from "../src/autonomous-orchestrator.js";
import { createWorkspaceService } from "../src/workspace-service.js";
import { createWorkspaceEventAdapter } from "../src/workspace-event-adapter.js";

const execFile = promisify(execFileCallback);

/**
 * R24 Phase 13 — the campaign's central adversarial boundary.
 *
 * "Verified useful work per unit of free capacity" collapses if fabric admission could ever
 * substitute for verified work. This test drives a full fabric-admitted autonomous run in
 * which the coder *claims* an edit but writes nothing: every spawned agent was legitimately
 * admitted, the provider calls all happened under real reservations — and the completion
 * gate must still block the run. Admission is permission to spend; it is not evidence of
 * work. The failure path must also settle cleanly: a blocked run releases its holds the
 * same way a completed one does.
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

/** A provider whose reviewer lies: it returns verdict "pass" for work that never happened. */
class ClaimHappyProvider implements ProviderAdapter {
  readonly providerId = "fabric-a";
  readonly isTestProvider = true;
  reviewerCalls = 0;

  async listModels(): Promise<ProviderModel[]> {
    return [{ modelId: "fabric-a-model", displayName: "Fabric A", isFree: true, freeStatus: "verified_free", capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true } }];
  }
  async chat(_req: ChatRequest): Promise<ChatResponse> { throw new Error("Use streamChat"); }
  async *streamChat(req: ChatRequest): AsyncIterable<StreamEvent> {
    const role = roleOf(req);
    if (role === "reviewer") this.reviewerCalls++;
    const toolResults = req.messages.filter((m) => m.role === "tool").length;
    yield* (
      role === "planner" ? finalJson(PLANNER_RESULT, 900)
      : role === "reviewer" ? finalJson(REVIEWER_RESULT, 1_100)
      : toolResults === 0 ? toolCall("list_files", { path: ".", recursive: false })
      : toolResults === 1 ? toolCall("read_file", { path: "src/math.ts" })
      : finalJson(EXPLORER_RESULT, 1_400)
    );
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

describe("R24 admission is not verification — the gate owns completion", () => {
  let targetRepo: string;
  let worktreeBaseDir: string;
  let dbDir: string;
  let eventStore: EventStore;
  let persistence: ISessionPersistence;

  beforeEach(async () => {
    targetRepo = await mkdtemp(join(tmpdir(), "r24-admvscomp-target-"));
    worktreeBaseDir = await mkdtemp(join(tmpdir(), "r24-admvscomp-worktrees-"));
    dbDir = await mkdtemp(join(tmpdir(), "r24-admvscomp-db-"));
    eventStore = new EventStore();
    persistence = createSessionPersistence({ dbPath: join(dbDir, "sessions.db") });
    await execFile("git", ["init"], { cwd: targetRepo });
    for (const [key, value] of [["user.name", "R24"], ["user.email", "r24@codeforge.test"], ["commit.gpgsign", "false"], ["core.autocrlf", "false"]]) await execFile("git", ["config", key!, value!], { cwd: targetRepo });
    await writeFile(join(targetRepo, "package.json"), JSON.stringify({ name: "bench", version: "1.0.0", type: "module", scripts: { test: "node -e \"process.exit(0)\"" } }, null, 2));
    await mkdir(join(targetRepo, "src"), { recursive: true });
    await writeFile(join(targetRepo, "src", "math.ts"), "export function add(a: number, b: number): number { return a + b; }\n");
    await execFile("git", ["add", "."], { cwd: targetRepo });
    await execFile("git", ["commit", "-m", "initial"], { cwd: targetRepo });
    delete process.env.CODEFORGE_TOPOLOGY_POLICY;
  });

  afterEach(async () => {
    persistence.close();
    delete process.env.CODEFORGE_TOPOLOGY_POLICY;
    for (const dir of [targetRepo, worktreeBaseDir, dbDir]) await rm(dir, { recursive: true, force: true });
  });

  it("a fully admitted run whose coder claims an edit but writes nothing is blocked — and still releases its reservations", async () => {
    const provider = new ClaimHappyProvider();
    const catalog = new InMemoryProviderCatalog();
    catalog.register(provider);
    const firewall = new ForgeZero();
    firewall.register(createGenericFreeRecord({ providerId: "fabric-a", modelId: "fabric-a-model", displayName: "Fabric A" }));
    const route = fabricRoute();
    const reservations = new CapacityReservationLedger({ routes: [], pools: [], maxActiveReservationsPerUser: 8 });
    const heldIds = new Set<string>();
    const innerReserve = reservations.reserve.bind(reservations);
    const innerRelease = reservations.release.bind(reservations);
    reservations.reserve = (request) => {
      const decision = innerReserve(request);
      if (decision.admitted) heldIds.add(request.reservationId);
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
    const sessionId = "sess-admission-vs-completion";
    const runtime: AgentRuntime = createAgentRuntime({
      sessionId,
      eventStore,
      persistence,
      firewall,
      providerCatalog: catalog,
      workspacePath: targetRepo,
      userId: "pilot-user",
      freeFabric: fabric,
      fabricContext: ({ userId }) => ({ userId: userId ?? "pilot-user", userIdentities: [] }),
    });
    const orchestrator = createAutonomousRunOrchestrator({
      workspaceService: createWorkspaceService({ persistence, worktreeParentDir: worktreeBaseDir }),
      persistence,
      subagentsR1Enabled: true,
      getAgentRuntime: () => runtime,
    });

    const result = await orchestrator.startRun({
      sessionId,
      workspacePath: targetRepo,
      goal: GOAL,
      verificationCommands: ["node -e \"process.exit(0)\""],
      adapter: createWorkspaceEventAdapter({ sessionId, eventStore, persistence }),
      // The adversarial core: the coder reports a completed edit and the reviewer returns
      // verdict "pass" — but no byte ever changed in the worktree.
      coderExecutor: async () => ({ success: true, filesChanged: ["src/math.ts"] }),
    });

    // Admission spent real reservations on every spawned agent; the gate still owns the verdict.
    expect(heldIds.size).toBe(0);
    expect(reservations.snapshot().activeReservations).toBe(0);
    expect(result.status).toBe("blocked");
    expect(result.completion?.outcome).not.toBe("completed");
    // The model's own "pass" verdict is not evidence — the review found no diff.
    const blockers = result.completion?.blockers ?? [];
    expect(blockers.map((b) => b.code)).toContain("no_effective_change");
  });
});
