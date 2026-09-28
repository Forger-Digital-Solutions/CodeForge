import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { ForgeZero, createGenericFreeRecord, CapacityReservationLedger, type CapacityRoute, type CapacityWindow, type ProviderCapacityPool } from "@codeforge/forge-zero";
import { createEightBitRouteHealthAuthority, createFreeFabric, type FreeFabric } from "@codeforge/eight-bit";
import { EventStore, createSessionPersistence, type ISessionPersistence } from "@codeforge/sessions";
import { InMemoryProviderCatalog, type ChatRequest, type ChatResponse, type ProviderAdapter, type ProviderModel, type StreamEvent } from "@codeforge/providers";
import { createAgentRuntime, type AgentRuntime } from "../src/agent-runtime.js";
import { createAutonomousRunOrchestrator, type AutonomousRunResult } from "../src/autonomous-orchestrator.js";
import { createWorkspaceEventAdapter } from "../src/workspace-event-adapter.js";
import { createWorkspaceService } from "../src/workspace-service.js";

const execFile = promisify(execFileCallback);
const OBSERVED_AT = new Date(Date.now() - 60_000).toISOString();
const NO_RESET = "9999-12-31T23:59:59.999Z";
const cleanupPaths: string[] = [];
const evidence: DeterministicComparison[] = [];

type Role = "explorer" | "planner" | "reviewer";
type ScenarioId = "tiny" | "normal_healthy" | "normal_reviewer_repair" | "complex_healthy";

interface Scenario {
  id: ScenarioId;
  goal: string;
  expectedAdaptiveTopology: "tiny" | "normal" | "complex";
  reviewerRepair: boolean;
}

interface CallRecord {
  role: Role;
  requestBytes: number;
  scriptedInputTokens: number;
  scriptedOutputTokens: number;
}

interface ArmMeasurement {
  arm: "single_agent" | "adaptive_subagents";
  status: AutonomousRunResult["status"];
  completion: AutonomousRunResult["completion"];
  topology: string | undefined;
  childrenSpawned: number;
  reviewRounds: number;
  taskAttempts: number;
  providerCalls: number;
  actualRequestBytes: number;
  scriptedProviderTokens: number;
  toolCalls: number;
  wallTimeMs: number;
  coderAttempts: number;
}

interface DeterministicComparison {
  scenario: ScenarioId;
  expectedAdaptiveTopology: Scenario["expectedAdaptiveTopology"];
  verifier: "node semantic file-content check";
  singleAgent: ArmMeasurement;
  adaptiveSubagents: ArmMeasurement;
  outcome: "OVERHEAD_AVOIDED" | "REVIEWER_REPAIR_VALUE" | "OVERHEAD_WITH_EQUAL_CORRECTNESS";
}

function roleOf(request: ChatRequest): Role {
  const text = request.messages.map((message) => message.content ?? "").join("\n");
  if (text.includes("Review implementation for goal")) return "reviewer";
  if (text.includes("Produce the minimal task graph for goal")) return "planner";
  return "explorer";
}

function finalJson(json: string, inputTokens: number): StreamEvent[] {
  return [
    { type: "text_delta", delta: json },
    { type: "usage", usage: { inputTokens, outputTokens: 120 } },
    { type: "finish", finishReason: "stop" },
  ];
}

class DeterministicRoleProvider implements ProviderAdapter {
  readonly providerId = "r27-scripted-free";
  readonly isTestProvider = true;
  readonly calls: CallRecord[] = [];
  private reviewerCalls = 0;

  constructor(private readonly scenario: Scenario) {}

  async listModels(): Promise<ProviderModel[]> {
    return [{ modelId: "r27-scripted-free-model", displayName: "R27 scripted free model", isFree: true, freeStatus: "verified_free", capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true } }];
  }

  async chat(_request: ChatRequest): Promise<ChatResponse> {
    throw new Error("Use streamChat");
  }

  async *streamChat(request: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    const role = roleOf(request);
    const requestBytes = request.messages.reduce((total, message) => total + Buffer.byteLength(message.content ?? "", "utf8"), 0);
    const response = role === "planner"
      ? { text: JSON.stringify({ summary: "Minimal ordered task graph.", tasks: [{ id: "implement", title: "Implement", objective: "Make the required change", dependencies: [], assignedRole: "coder" }, { id: "verify", title: "Verify", objective: "Run semantic verifier", dependencies: ["implement"], assignedRole: "reviewer" }], planningIntent: { verification: ["Run semantic verifier"], completionEvidence: ["Verifier passes"] } }), inputTokens: 800 }
      : role === "reviewer" && this.scenario.reviewerRepair && this.reviewerCalls++ === 0
        ? { text: JSON.stringify({ summary: "Semantic requirement missing.", verdict: "revision_required", findings: [{ id: "correct-multiply", severity: "blocking", category: "missing_requirement", message: "Correct the multiply implementation before verification.", evidence: "src/math.ts" }] }), inputTokens: 950 }
        : role === "reviewer"
          ? { text: JSON.stringify({ summary: "Implementation satisfies the requirement.", verdict: "pass", findings: [] }), inputTokens: 900 }
          : { text: JSON.stringify({ summary: "Relevant implementation file identified.", findings: [], evidence: [{ kind: "file", ref: "src/math.ts", description: "Target implementation" }] }), inputTokens: 700 };
    const events = finalJson(response.text, response.inputTokens);
    let outputTokens = 0;
    for (const event of events) {
      if (signal?.aborted) return;
      if (event.type === "usage") outputTokens += event.usage.outputTokens;
      yield event;
    }
    this.calls.push({ role, requestBytes, scriptedInputTokens: response.inputTokens, scriptedOutputTokens: outputTokens });
  }

  async healthCheck() {
    return { status: "available" as const };
  }
}

function capacityWindow(overrides: Partial<CapacityWindow> = {}): CapacityWindow {
  return { unit: "requests", limit: 500, remaining: 500, resetAt: NO_RESET, scope: "ORG", observedAt: OBSERVED_AT, authoritative: true, ...overrides };
}

function route(): CapacityRoute {
  return {
    routeId: "fabric:r27-scripted-free",
    providerId: "r27-scripted-free",
    modelId: "r27-scripted-free-model",
    canonicalModelId: "r27-scripted-free-model",
    family: "r27-scripted-free",
    gateway: "r27-scripted-free",
    supplyClass: "PURE_MANAGED_FREE",
    capacityPoolId: "shared:r27-scripted-free",
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
    windows: [capacityWindow(), capacityWindow({ unit: "input_tokens", limit: 8_000_000, remaining: 8_000_000 }), capacityWindow({ unit: "concurrency", limit: 8, remaining: 8 })],
  };
}

function fabricPool(capacityRoute: CapacityRoute): ProviderCapacityPool {
  return { poolId: capacityRoute.capacityPoolId, providerId: capacityRoute.providerId, scope: "SHARED_OWNER_POOL", supplyClass: capacityRoute.supplyClass, windows: capacityRoute.windows, observedAt: OBSERVED_AT, authoritative: true };
}

async function createTargetRepo(): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), "r27-subagent-target-"));
  cleanupPaths.push(repository);
  await execFile("git", ["init"], { cwd: repository });
  for (const [key, value] of [["user.name", "R27"], ["user.email", "r27@codeforge.test"], ["commit.gpgsign", "false"], ["core.autocrlf", "false"]]) await execFile("git", ["config", key, value], { cwd: repository });
  await writeFile(join(repository, "package.json"), JSON.stringify({ name: "r27-subagent-bench", version: "1.0.0", type: "module" }, null, 2));
  await mkdir(join(repository, "src"), { recursive: true });
  await writeFile(join(repository, "src", "math.ts"), "export function multiply(a: number, b: number): number { return a + b; }\nexport const calculate = multiply;\n");
  await execFile("git", ["add", "."], { cwd: repository });
  await execFile("git", ["commit", "-m", "initial"], { cwd: repository });
  return repository;
}

async function runArm(scenario: Scenario, arm: ArmMeasurement["arm"]): Promise<ArmMeasurement> {
  const repository = await createTargetRepo();
  const worktreeParentDir = await mkdtemp(join(tmpdir(), "r27-subagent-worktrees-"));
  const databaseDir = await mkdtemp(join(tmpdir(), "r27-subagent-db-"));
  cleanupPaths.push(worktreeParentDir, databaseDir);
  const provider = new DeterministicRoleProvider(scenario);
  const catalog = new InMemoryProviderCatalog();
  catalog.register(provider);
  const firewall = new ForgeZero();
  firewall.register(createGenericFreeRecord({ providerId: provider.providerId, modelId: "r27-scripted-free-model", displayName: "R27 scripted free model" }));
  const persistence: ISessionPersistence = createSessionPersistence({ dbPath: join(databaseDir, "sessions.db") });
  const capacityRoute = route();
  const fabric: FreeFabric = createFreeFabric({
    managedRoutes: () => [capacityRoute],
    managedPools: () => [fabricPool(capacityRoute)],
    health: createEightBitRouteHealthAuthority(),
    reservations: new CapacityReservationLedger({ routes: [], pools: [], maxActiveReservationsPerUser: 8 }),
  });
  const runtime: AgentRuntime = createAgentRuntime({
    sessionId: `r27-${scenario.id}-${arm}`,
    eventStore: new EventStore(),
    persistence,
    firewall,
    providerCatalog: catalog,
    workspacePath: repository,
    userId: "r27-benchmark-user",
    freeFabric: fabric,
    fabricContext: ({ userId }) => ({ userId: userId ?? "r27-benchmark-user", userIdentities: [] }),
  });
  const orchestrator = createAutonomousRunOrchestrator({
    workspaceService: createWorkspaceService({ persistence, worktreeParentDir }),
    persistence,
    subagentsR1Enabled: true,
    getAgentRuntime: () => runtime,
  });
  let coderAttempts = 0;
  const startedAt = performance.now();
  const result = await orchestrator.startRun({
    sessionId: `r27-${scenario.id}-${arm}`,
    workspacePath: repository,
    goal: scenario.goal,
    verificationCommands: ["node -e \"const fs=require('node:fs');process.exit(fs.readFileSync('src/math.ts','utf8').includes('return a * b;') ? 0 : 1)\""],
    adapter: createWorkspaceEventAdapter({ sessionId: `r27-${scenario.id}-${arm}`, eventStore: new EventStore(), persistence }),
    ...(arm === "single_agent" ? { topology: "tiny" as const } : {}),
    coderExecutor: async (worktreePath, _goal, reviewFeedback) => {
      coderAttempts++;
      const shouldRepair = !scenario.reviewerRepair || reviewFeedback !== undefined;
      const content = shouldRepair
        ? "export function multiply(a: number, b: number): number { return a * b; }\nexport const calculate = multiply;\n"
        : "export function multiply(a: number, b: number): number { return a + b; }\nexport const calculate = multiply;\n";
      await writeFile(join(worktreePath, "src", "math.ts"), content);
      return { success: true, filesChanged: ["src/math.ts"] };
    },
  });
  const wallTimeMs = Math.round(performance.now() - startedAt);
  persistence.close();
  return {
    arm,
    status: result.status,
    completion: result.completion,
    topology: result.topology?.plan.topology,
    childrenSpawned: result.counters.childrenSpawned,
    reviewRounds: result.counters.reviewRounds,
    taskAttempts: result.counters.taskAttempts,
    providerCalls: provider.calls.length,
    actualRequestBytes: provider.calls.reduce((total, call) => total + call.requestBytes, 0),
    scriptedProviderTokens: provider.calls.reduce((total, call) => total + call.scriptedInputTokens + call.scriptedOutputTokens, 0),
    toolCalls: 0,
    wallTimeMs,
    coderAttempts,
  };
}

const scenarios: Scenario[] = [
  { id: "tiny", goal: "Fix the incorrect multiplication return in src/math.ts", expectedAdaptiveTopology: "tiny", reviewerRepair: false },
  { id: "normal_healthy", goal: "Investigate and fix the checkout calculation in src/math.ts", expectedAdaptiveTopology: "normal", reviewerRepair: false },
  { id: "normal_reviewer_repair", goal: "Investigate and fix the checkout calculation in src/math.ts", expectedAdaptiveTopology: "normal", reviewerRepair: true },
  { id: "complex_healthy", goal: "Migrate the database schema and API across multiple packages", expectedAdaptiveTopology: "normal", reviewerRepair: false },
];

afterEach(async () => {
  for (const target of cleanupPaths.splice(0)) await rm(target, { recursive: true, force: true });
});

describe("R27 deterministic subagent real-value crossover", () => {
  for (const scenario of scenarios) {
    it(`${scenario.id}: compares one coder with adaptive subagents through the production orchestrator`, async () => {
      const singleAgent = await runArm(scenario, "single_agent");
      const adaptiveSubagents = await runArm(scenario, "adaptive_subagents");
      const outcome: DeterministicComparison["outcome"] = scenario.id === "tiny"
        ? "OVERHEAD_AVOIDED"
        : scenario.reviewerRepair
          ? "REVIEWER_REPAIR_VALUE"
          : "OVERHEAD_WITH_EQUAL_CORRECTNESS";
      evidence.push({ scenario: scenario.id, expectedAdaptiveTopology: scenario.expectedAdaptiveTopology, verifier: "node semantic file-content check", singleAgent, adaptiveSubagents, outcome });

      expect(adaptiveSubagents.toolCalls).toBe(0);
      if (scenario.id === "tiny") {
        expect(singleAgent.status).toBe("completed");
        expect(adaptiveSubagents.status).toBe("completed");
        expect(singleAgent.topology).toBe("tiny");
        expect(adaptiveSubagents.topology).toBe("tiny");
        expect(adaptiveSubagents.childrenSpawned).toBe(0);
        expect(adaptiveSubagents.providerCalls).toBe(0);
      } else if (scenario.reviewerRepair) {
        expect(singleAgent.status).toBe("blocked");
        expect(adaptiveSubagents.status).toBe("completed");
        expect(adaptiveSubagents.topology).toBe("normal");
        expect(adaptiveSubagents.reviewRounds).toBe(1);
        expect(adaptiveSubagents.coderAttempts).toBe(2);
      } else {
        expect(singleAgent.status).toBe("completed");
        expect(adaptiveSubagents.status).toBe("completed");
        expect(singleAgent.topology).toBe("tiny");
        expect(adaptiveSubagents.topology).toBe(scenario.expectedAdaptiveTopology);
        expect(adaptiveSubagents.providerCalls).toBeGreaterThan(singleAgent.providerCalls);
        expect(adaptiveSubagents.childrenSpawned).toBeGreaterThan(singleAgent.childrenSpawned);
      }
    }, 120_000);
  }

  it("writes deterministic receipts only when an evidence directory is explicitly configured", async () => {
    const outputDirectory = process.env.R27_SUBAGENT_EVIDENCE_DIR;
    if (!outputDirectory) return;
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(join(outputDirectory, "R27-SUBAGENT-RUNTIME-DETERMINISTIC.json"), `${JSON.stringify({
      schema: "r27-subagent-runtime-deterministic-1",
      recordedAt: new Date().toISOString(),
      status: "R27_SUBAGENT_DETERMINISTIC_VALUE_PARTIALLY_PROVEN_LIVE_VALUE_NOT_PROVEN",
      method: "Equivalent temporary repositories, coder executor, semantic verifier, and completion gate; the adaptive arm alone invokes the production Explorer/Reviewer path through a deterministic scripted free provider. Automatic Planner use remains gated by R54 evidence.",
      measurements: "Provider-call counts and request bytes are observed from AgentRuntime. Token counts are scripted provider usage values. Wall time is measured but not used for assertions. No tool calls are emitted by this focused role-protocol fixture.",
      limitations: ["Scripted responses cannot establish live-model relevance, planning quality, reviewer precision/recall, or crossover economics.", "The single-agent arm uses the production tiny topology with the same deterministic coder executor; it does not call a model for coding.", "The reviewer-repair scenario proves a controlled correction path, not general reviewer effectiveness."],
      comparisons: evidence,
    }, null, 2)}\n`, "utf8");
  });
});
