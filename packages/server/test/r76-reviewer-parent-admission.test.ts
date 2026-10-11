import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { execFile as callback } from "node:child_process";
import { promisify } from "node:util";
import { ForgeZero, createGenericFreeRecord } from "@codeforge/forge-zero";
import { InMemoryProviderCatalog, type ChatRequest, type ProviderAdapter, type StreamEvent } from "@codeforge/providers";
import { FreeCloudService, NormalizedModelRegistry } from "@codeforge/model-registry";
import { InMemoryQualificationPersistence, ROLE_QUALIFICATION_SUITE_VERSION, REVIEWER_PROTOCOL, type ModelQualificationReceipt } from "@codeforge/eight-bit";
import { EventStore, createSessionPersistence } from "@codeforge/sessions";
import { createAgentRuntime, type AgentRuntime, type AgentRuntimeRequest, type AgentRuntimeResult } from "../src/agent-runtime.js";
import { createAutonomousRunOrchestrator } from "../src/autonomous-orchestrator.js";
import { createWorkspaceService } from "../src/workspace-service.js";

const exec = promisify(callback);
const providerId = "blockrun-free-direct";
const modelId = "nvidia/llama-3.2-11b-vision";

describe("R76 real parent and text Reviewer admission", () => {
  let directory: string;
  let repo: string;
  let persistence: ReturnType<typeof createSessionPersistence>;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "r76-review-parent-"));
    repo = path.join(directory, "parent");
    await mkdir(repo);
    await writeFile(path.join(repo, "math.mjs"), "export const limit = 4;\n");
    await writeFile(path.join(repo, "math.test.mjs"), "import assert from 'node:assert/strict'; import { limit } from './math.mjs'; assert.equal(limit, 3);\n");
    for (const args of [["init"], ["config", "user.name", "CodeForge fixture"], ["config", "user.email", "fixture@codeforge.invalid"], ["config", "commit.gpgsign", "false"], ["add", "."], ["commit", "-m", "Fixture baseline"]]) await exec("git", args, { cwd: repo, windowsHide: true });
    persistence = createSessionPersistence({ dbPath: path.join(directory, "sessions.db") });
    await persistence.init();
  });
  afterEach(async () => { await persistence.close(); await rm(directory, { recursive: true, force: true }); });

  async function run(options: { alias?: boolean; status?: "QUALIFIED" | "NOT_QUALIFIED"; expired?: boolean; stale?: boolean } = {}) {
    const at = new Date(Date.now() - (options.expired ? 31 * 86_400_000 : 0)).toISOString();
    const receipt: ModelQualificationReceipt = {
      suiteVersion: ROLE_QUALIFICATION_SUITE_VERSION, providerId, modelId, modelDisplayName: modelId,
      accessClass: "FREE_ROUTED", freeStatus: "verified_free", qualificationState: options.status ?? "QUALIFIED", hardFailureRoles: [],
      startedAt: at, completedAt: at, totalLatencyMs: 1,
      metadata: { roleProtocolVersions: { REVIEWER: REVIEWER_PROTOCOL.version } },
      roleResults: { REVIEWER: { role: "REVIEWER", status: options.status ?? "QUALIFIED", testCases: [], hardFailures: [], startedAt: at, completedAt: at } },
    };
    const requests: ChatRequest[] = [];
    const provider: ProviderAdapter = {
      providerId, isTestProvider: true, listModels: async () => [], chat: async () => { throw new Error("stream only"); }, healthCheck: async () => ({ status: "available" }),
      streamChat: async function* (request): AsyncIterable<StreamEvent> {
        requests.push(request);
        yield { type: "text_delta", delta: '{"verdict":"pass","findings":[],"summary":"The isolated source and existing assertions require limit three."}' };
        yield { type: "finish", finishReason: "stop" };
      },
    };
    const firewall = new ForgeZero();
    firewall.setPrivacyMode("MAXIMUM_FREE");
    firewall.register({ ...createGenericFreeRecord({ providerId, modelId, contextWindow: 128_000 }), accessClass: "FREE_ROUTED", privacyClass: "permissive" });
    const catalog = new InMemoryProviderCatalog(); catalog.register(provider);
    const freeCloud = new FreeCloudService({ firewall, providerCatalog: catalog, registry: new NormalizedModelRegistry(), qualificationStore: new InMemoryQualificationPersistence() });
    freeCloud.setConnection({ providerId, connected: true, credentialSource: "ANONYMOUS_DIRECT", authState: "ok", ownerUserId: "fixture-owner" });
    const current = new Date().toISOString();
    freeCloud.setDirectPolicyReceipt(providerId, { sourceDocumentation: "https://blockrun.ai/docs", termsEvidence: "https://blockrun.ai/terms", privacyEvidence: "https://blockrun.ai/privacy", priceEvidence: "https://blockrun.ai/docs/rate-limits", verifiedAt: current, recheckAt: new Date(Date.now() + 86_400_000).toISOString(), qualificationAt: at });
    await freeCloud.recordReceipt(receipt);
    freeCloud.applyReceiptToFirewall(receipt);
    const runtime = createAgentRuntime({ sessionId: "parent-session", workspacePath: repo, eventStore: new EventStore(), persistence, firewall, providerCatalog: catalog, freeCloud, userId: "fixture-owner", qualificationWaitHorizonMs: 50, qualificationRecoveryBudgetMs: 100 });
    const children: AgentRuntimeRequest[] = [];
    const parentRuntime = {
      recordRoleOutcome: runtime.recordRoleOutcome.bind(runtime),
      executeAgentRun: async (request: AgentRuntimeRequest): Promise<AgentRuntimeResult> => {
        children.push(request);
        if (request.role === "reviewer") {
          if (options.stale) await writeFile(path.join(request.workspacePath, "math.mjs"), "export const limit = 5;\n");
          return runtime.executeAgentRun({ ...request, signal: AbortSignal.timeout(5_000), executionBudget: { ...request.executionBudget, wallTimeMs: 5_000 } });
        }
        if (request.role === "coder") await writeFile(path.join(request.workspacePath, "math.mjs"), "export const limit = 3;\n");
        return { status: "completed", summary: "Synthetic offline worker", findings: [], evidence: [], filesChanged: request.role === "coder" ? ["math.mjs"] : [], toolExecutions: [], stopReason: "completed", usage: { inputTokens: 0, outputTokens: 0, requestCount: 0, toolCount: 0 } };
      },
    } as unknown as AgentRuntime;
    let workspacePath = repo;
    if (options.alias) {
      workspacePath = path.join(directory, "parent-alias");
      await symlink(repo, workspacePath, process.platform === "win32" ? "junction" : "dir");
    }
    const orchestrator = createAutonomousRunOrchestrator({ workspaceService: createWorkspaceService({ persistence, worktreeParentDir: path.join(directory, "isolated-children") }), persistence, agentRuntime: parentRuntime, subagentsR1Enabled: true });
    try {
      const result = await orchestrator.startRun({ sessionId: "parent-session", workspacePath, goal: "Fix limit to three. Preserve the existing tests.", topology: "normal", verificationCommands: ["node --test"] });
      return { result, children, requests };
    } finally { await runtime.shutdown(); }
  }

  it.each([false, true])("admits qualified independent review in the child workspace (parent alias %s)", async alias => {
    const { result, children, requests } = await run({ alias });
    expect(result.status, JSON.stringify(result)).toBe("completed");
    expect(result.review.passed).toBe(true);
    expect(result.integration.status).toBe("integrated");
    const reviewer = children.find(child => child.role === "reviewer")!;
    expect(reviewer.workspacePath).not.toBe(repo);
    expect(reviewer.reviewEvidence?.complete).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.tools ?? []).toHaveLength(0);
    expect(requests[0]?.messages.some(message => message.content.includes("export const limit = 3;"))).toBe(true);
    expect(await readFile(path.join(repo, "math.mjs"), "utf8")).toBe("export const limit = 3;\n");
  });
  it.each([{ status: "NOT_QUALIFIED" as const }, { expired: true }, { stale: true }])("rejects invalid review before dispatch: %j", async options => {
    const { result, requests } = await run(options);
    expect(["blocked", "failed"]).toContain(result.status);
    expect(requests).toHaveLength(0);
    expect(await readFile(path.join(repo, "math.mjs"), "utf8")).toBe("export const limit = 4;\n");
  });
});
