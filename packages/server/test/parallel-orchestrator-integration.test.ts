import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { EventStore, createSessionPersistence } from "@codeforge/sessions";
import { ForgeZero, createGenericFreeRecord } from "@codeforge/forge-zero";
import { InMemoryProviderCatalog, type ChatRequest, type ChatResponse, type ProviderAdapter, type ProviderModel, type StreamEvent } from "@codeforge/providers";
import { createAgentRuntime } from "../src/agent-runtime.js";
import { createWorkspaceService } from "../src/workspace-service.js";
import { createParallelAutonomousRunOrchestrator } from "../src/parallel-orchestrator.js";
import { createIntegrationService } from "../src/integration-service.js";

const execFile = promisify(execFileCallback);

class Latch {
  private readonly active = new Set<string>();
  private release!: () => void;
  private readonly releasePromise: Promise<void>;
  private observedResolve!: () => void;
  private readonly observed: Promise<void>;
  constructor() { this.releasePromise = new Promise<void>((resolve) => { this.release = resolve; }); this.observed = new Promise<void>((resolve) => { this.observedResolve = resolve; }); }
  async enter(id: string): Promise<void> { this.active.add(id); if (this.active.size === 2) this.observedResolve(); await this.releasePromise; }
  waitForBoth(): Promise<void> { return this.observed; }
  continue(): void { this.release(); }
  ids(): string[] { return [...this.active].sort(); }
}

class ParallelProvider implements ProviderAdapter {
  readonly providerId = "parallel-test";
  readonly isTestProvider = true;
  constructor(private readonly latch?: Latch, private readonly scenario: "clean" | "textual" | "semantic" = "clean") {}
  async listModels(): Promise<ProviderModel[]> { return [{ modelId: "free", displayName: "Free", isFree: true, freeStatus: "verified_free", capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true } }]; }
  async chat(_request: ChatRequest): Promise<ChatResponse> { throw new Error("stream only"); }
  async healthCheck() { return { status: "available" as const }; }
  async *streamChat(request: ChatRequest): AsyncIterable<StreamEvent> {
    const system = request.messages.find((message) => message.role === "system")?.content ?? "";
    const all = request.messages.map((message) => message.content).join("\n");
    if (system.includes("CodeForge Planner")) {
      const payload = this.scenario === "textual" ? { id: "conflict", goal: "conflict", summary: "conflict", workstreams: [{ id: "upper", title: "Upper", objective: "Return uppercase", dependencies: [] }, { id: "lower", title: "Lower", objective: "Return lowercase", dependencies: [] }] } : this.scenario === "semantic" ? { id: "semantic", goal: "semantic", summary: "semantic", workstreams: [{ id: "nullable", title: "Nullable API", objective: "Make getUser nullable", dependencies: [], expectedFiles: ["src/user.mjs"] }, { id: "caller", title: "Caller", objective: "Add unsafe caller", dependencies: [], expectedFiles: ["src/caller.mjs"] }], globalVerificationCommands: ["node --test test/semantic.test.mjs"] } : { id: "parallel-plan", goal: "add functions", summary: "two independent writers", workstreams: [{ id: "math", title: "Math", objective: "Add multiply", dependencies: [], expectedFiles: ["src/math.mjs"], verificationCommands: ["node --test test/math.test.mjs"] }, { id: "string", title: "String", objective: "Add slugify", dependencies: [], expectedFiles: ["src/string.mjs"], verificationCommands: ["node --test test/string.test.mjs"] }], globalVerificationCommands: ["node --test test/math.test.mjs", "node --test test/string.test.mjs"] };
      yield { type: "text_delta", delta: JSON.stringify(payload) }; yield { type: "finish", finishReason: "stop" }; return;
    }
    if (system.includes("CodeForge Reviewer")) { yield { type: "text_delta", delta: JSON.stringify({ verdict: "pass", findings: [], summary: "isolated change approved" }) }; yield { type: "finish", finishReason: "stop" }; return; }
    if (system.includes("CodeForge Coder")) {
      const stringTask = all.includes("slugify") || all.includes('"string"'); const upperTask = all.includes("uppercase"); const nullableTask = all.includes("nullable"); const id = this.scenario === "textual" ? upperTask ? "upper" : "lower" : this.scenario === "semantic" ? nullableTask ? "nullable" : "caller" : stringTask ? "string" : "math";
      if (!request.messages.some((message) => message.role === "tool")) {
        if (this.latch) await this.latch.enter(id);
        const target = this.scenario === "textual" ? { path: "src/format.mjs", content: upperTask ? "export function formatName(value) { return value.toUpperCase(); }\n" : "export function formatName(value) { return value.toLowerCase(); }\n" } : this.scenario === "semantic" ? nullableTask ? { path: "src/user.mjs", content: "export function getUser() { return null; }\n" } : { path: "src/caller.mjs", content: "import { getUser } from './user.mjs'; export const userName = () => getUser().name;\n" } : stringTask ? { path: "src/string.mjs", content: "export function slugify(value) { return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }\n" } : { path: "src/math.mjs", content: "export function multiply(a, b) { return a * b; }\n" };
        yield { type: "tool_call_started", toolCallId: `write-${id}`, toolName: "write_file" }; yield { type: "tool_call_completed", toolCallId: `write-${id}`, toolName: "write_file", arguments: JSON.stringify(target) }; yield { type: "finish", finishReason: "tool_calls" }; return;
      }
      yield { type: "text_delta", delta: `${id} complete` }; yield { type: "finish", finishReason: "stop" }; return;
    }
    yield { type: "text_delta", delta: "done" }; yield { type: "finish", finishReason: "stop" };
  }
}

describe("CF-08 real concurrent worktree orchestration", () => {
  let repoDir: string; let worktreeDir: string; let persistence: ReturnType<typeof createSessionPersistence>;
  beforeEach(async () => {
    repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "cf08-parallel-")); worktreeDir = await fs.mkdtemp(path.join(os.tmpdir(), "cf08-worktrees-")); persistence = createSessionPersistence();
    await execFile("git", ["init", "-b", "main"], { cwd: repoDir }); await execFile("git", ["config", "user.name", "CodeForge"], { cwd: repoDir }); await execFile("git", ["config", "user.email", "codeforge@example.test"], { cwd: repoDir });
    await fs.mkdir(path.join(repoDir, "src")); await fs.mkdir(path.join(repoDir, "test")); await fs.writeFile(path.join(repoDir, "package.json"), JSON.stringify({ type: "module" }));
    await fs.writeFile(path.join(repoDir, "src", "math.mjs"), "export function multiply() { return 0; }\n"); await fs.writeFile(path.join(repoDir, "src", "string.mjs"), "export function slugify() { return 'bad'; }\n");
    await fs.writeFile(path.join(repoDir, "test", "math.test.mjs"), "import test from 'node:test'; import assert from 'node:assert/strict'; import { multiply } from '../src/math.mjs'; test('multiply', () => assert.equal(multiply(6, 7), 42));\n");
    await fs.writeFile(path.join(repoDir, "test", "string.test.mjs"), "import test from 'node:test'; import assert from 'node:assert/strict'; import { slugify } from '../src/string.mjs'; test('slugify', () => assert.equal(slugify('Hello, World!'), 'hello-world'));\n");
    await execFile("git", ["add", "."], { cwd: repoDir }); await execFile("git", ["commit", "-m", "base"], { cwd: repoDir });
  });
  afterEach(async () => { persistence.close(); await fs.rm(repoDir, { recursive: true, force: true }); await fs.rm(worktreeDir, { recursive: true, force: true }); });

  it("proves two Coders overlap in separate real worktrees and safely promotes their clean synthesis", async () => {
    const latch = new Latch(); const catalog = new InMemoryProviderCatalog(); catalog.register(new ParallelProvider(latch)); const firewall = new ForgeZero(); firewall.register(createGenericFreeRecord());
    const workspaceService = createWorkspaceService({ persistence, worktreeParentDir: worktreeDir }); const runtime = createAgentRuntime({ sessionId: "parallel-session", eventStore: new EventStore(), persistence, firewall, providerCatalog: catalog, workspacePath: repoDir }); const orchestrator = createParallelAutonomousRunOrchestrator({ workspaceService, agentRuntime: runtime, persistence });
    const pending = orchestrator.startRun({ sessionId: "parallel-session", workspacePath: repoDir, goal: "Add multiply and slugify" });
    await latch.waitForBoth(); expect(latch.ids()).toEqual(["math", "string"]); expect((await orchestrator.listRuns("parallel-session"))[0]?.workstreams).toHaveLength(0);
    latch.continue(); const result = await pending;
    expect(result.status).toBe("completed"); expect(result.workstreams).toHaveLength(2);
    const [math, string] = result.workstreams.sort((left, right) => left.workstreamId.localeCompare(right.workstreamId));
    expect(math.workspaceId).not.toBe(string.workspaceId); expect(math.branch).not.toBe(string.branch); expect(workspaceService.getWorkspace(math.workspaceId)?.rootPath).not.toBe(workspaceService.getWorkspace(string.workspaceId)?.rootPath);
    expect(await fs.readFile(path.join(workspaceService.getWorkspace(math.workspaceId)!.rootPath, "src", "math.mjs"), "utf8")).toContain("a * b");
    expect(await fs.readFile(path.join(workspaceService.getWorkspace(string.workspaceId)!.rootPath, "src", "string.mjs"), "utf8")).toContain("toLowerCase");
    expect(await fs.readFile(path.join(repoDir, "src", "math.mjs"), "utf8")).toContain("a * b"); expect(await fs.readFile(path.join(repoDir, "src", "string.mjs"), "utf8")).toContain("toLowerCase");
  });

  it("fails closed on a real textual Git conflict while retaining every workstream branch", async () => {
    await fs.writeFile(path.join(repoDir, "src", "format.mjs"), "export function formatName(value) { return value; }\n"); await execFile("git", ["add", "."], { cwd: repoDir }); await execFile("git", ["commit", "-m", "format base"], { cwd: repoDir }); const before = (await execFile("git", ["rev-parse", "HEAD"], { cwd: repoDir })).stdout.trim();
    const catalog = new InMemoryProviderCatalog(); catalog.register(new ParallelProvider(undefined, "textual")); const firewall = new ForgeZero(); firewall.register(createGenericFreeRecord()); const workspaceService = createWorkspaceService({ persistence, worktreeParentDir: worktreeDir }); const runtime = createAgentRuntime({ sessionId: "conflict", eventStore: new EventStore(), persistence, firewall, providerCatalog: catalog, workspacePath: repoDir }); const result = await createParallelAutonomousRunOrchestrator({ workspaceService, agentRuntime: runtime, persistence }).startRun({ sessionId: "conflict", workspacePath: repoDir, goal: "conflict" });
    expect(result).toMatchObject({ status: "blocked", error: "SYNTHESIS_CONFLICT_UNRESOLVED" }); expect(result.synthesis?.conflicts[0]?.paths).toContain("src/format.mjs"); expect(result.workstreams.every((workstream) => workstream.branch)).toBe(true); expect((await execFile("git", ["rev-parse", "HEAD"], { cwd: repoDir })).stdout.trim()).toBe(before);
  });

  it("blocks promotion when a clean Git synthesis fails real global verification", async () => {
    await fs.writeFile(path.join(repoDir, "src", "user.mjs"), "export function getUser() { return { name: 'Ada' }; }\n"); await fs.writeFile(path.join(repoDir, "test", "semantic.test.mjs"), "import test from 'node:test'; import assert from 'node:assert/strict'; import { userName } from '../src/caller.mjs'; test('user', () => assert.equal(userName(), 'Ada'));\n"); await execFile("git", ["add", "."], { cwd: repoDir }); await execFile("git", ["commit", "-m", "semantic base"], { cwd: repoDir }); const before = (await execFile("git", ["rev-parse", "HEAD"], { cwd: repoDir })).stdout.trim();
    const catalog = new InMemoryProviderCatalog(); catalog.register(new ParallelProvider(undefined, "semantic")); const firewall = new ForgeZero(); firewall.register(createGenericFreeRecord()); const workspaceService = createWorkspaceService({ persistence, worktreeParentDir: worktreeDir }); const runtime = createAgentRuntime({ sessionId: "semantic", eventStore: new EventStore(), persistence, firewall, providerCatalog: catalog, workspacePath: repoDir }); const result = await createParallelAutonomousRunOrchestrator({ workspaceService, agentRuntime: runtime, persistence }).startRun({ sessionId: "semantic", workspacePath: repoDir, goal: "semantic" });
    expect(result).toMatchObject({ status: "blocked", error: "GLOBAL_VERIFICATION_FAILED" }); expect(result.synthesis?.conflicts).toEqual([]); expect(result.verification[0]?.failed).toBe(1); expect((await execFile("git", ["rev-parse", "HEAD"], { cwd: repoDir })).stdout.trim()).toBe(before);
  });

  it("uses IntegrationService divergence protection when the user advances the target before promotion", async () => {
    const catalog = new InMemoryProviderCatalog(); catalog.register(new ParallelProvider()); const firewall = new ForgeZero(); firewall.register(createGenericFreeRecord()); const workspaceService = createWorkspaceService({ persistence, worktreeParentDir: worktreeDir }); const runtime = createAgentRuntime({ sessionId: "divergence", eventStore: new EventStore(), persistence, firewall, providerCatalog: catalog, workspacePath: repoDir }); const integration = createIntegrationService({ workspaceService });
    const advancingIntegration = { integrate: async (params: Parameters<typeof integration.integrate>[0]) => { await fs.writeFile(path.join(repoDir, "user-advance.txt"), "user commit\n"); await execFile("git", ["add", "user-advance.txt"], { cwd: repoDir }); await execFile("git", ["commit", "-m", "user advance"], { cwd: repoDir }); return integration.integrate(params); } };
    const result = await createParallelAutonomousRunOrchestrator({ workspaceService, agentRuntime: runtime, persistence, integrationService: advancingIntegration as never }).startRun({ sessionId: "divergence", workspacePath: repoDir, goal: "Add multiply and slugify" });
    expect(result).toMatchObject({ status: "blocked", error: "PROMOTION_TARGET_DIVERGED" }); expect(await fs.readFile(path.join(repoDir, "user-advance.txt"), "utf8")).toBe("user commit\n"); expect(result.synthesis?.branch).toMatch(/^codeforge\//);
  });
});
