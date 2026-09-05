import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";
import { ForgeZero, createGenericFreeRecord } from "@codeforge/forge-zero";
import {
  type ProviderAdapter,
  type ProviderModel,
  type ChatRequest,
  type ChatResponse,
  type StreamEvent,
  InMemoryProviderCatalog,
} from "@codeforge/providers";
import { EventStore, createSessionPersistence } from "@codeforge/sessions";
import { createAutonomousRunOrchestrator } from "../src/autonomous-orchestrator.js";
import { createWorkspaceService } from "../src/workspace-service.js";
import { createSubagentManager } from "../src/subagent-manager.js";
import { createAgentRuntime } from "../src/agent-runtime.js";

const execFile = promisify(execFileCallback);

class FullFlowScriptedProvider implements ProviderAdapter {
  readonly providerId: string;
  readonly isTestProvider = true;
  readonly plannerTasks: unknown[];
  coderCalls = 0;

  constructor(providerId: string, plannerTasks?: unknown[]) {
    this.providerId = providerId;
    this.plannerTasks = plannerTasks ?? [
      { id: "implement-multiply", title: "Implement multiply", objective: "Update math.mjs to multiply inputs", dependencies: [], assignedRole: "coder" },
      { id: "review-multiply", title: "Review multiply", objective: "Review the implemented change", dependencies: ["implement-multiply"], assignedRole: "reviewer" },
    ];
  }

  async listModels(): Promise<ProviderModel[]> {
    return [{ modelId: "test-free", displayName: "Free Model", isFree: true, freeStatus: "verified_free", capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true } }];
  }

  async chat(_req: ChatRequest): Promise<ChatResponse> { throw new Error("Use streamChat"); }

  async *streamChat(req: ChatRequest): AsyncIterable<StreamEvent> {
    const systemPrompt = req.messages.find((message) => message.role === "system")?.content ?? "";
    const isExplorer = systemPrompt.includes("CodeForge Explorer");
    const isPlanner = systemPrompt.includes("CodeForge Planner");
    const isReviewer = systemPrompt.includes("CodeForge Reviewer");
    const isCoder = systemPrompt.includes("CodeForge Coder");

    if (isExplorer) {
      yield { type: "text_delta", delta: JSON.stringify({ summary: "Found the math module and its focused test.", findings: [{ id: "explore-math", severity: "advisory", category: "architecture", message: "math.mjs is the target module", evidence: "math.mjs" }], evidence: [{ kind: "file", ref: "math.mjs", description: "target module" }, { kind: "file", ref: "test/math.test.mjs", description: "focused verification" }] }) };
      yield { type: "finish", finishReason: "stop" };
      return;
    }

    if (isPlanner) {
      yield { type: "text_delta", delta: JSON.stringify({ summary: "Implement and verify multiply.", tasks: this.plannerTasks }) };
      yield { type: "finish", finishReason: "stop" };
      return;
    }

    if (isReviewer) {
      yield { type: "text_delta", delta: JSON.stringify({ verdict: "pass", findings: [], summary: "Reviewed the isolated diff; the implementation satisfies the task." }) };
      yield { type: "finish", finishReason: "stop" };
      return;
    }

    if (isCoder) {
      this.coderCalls++;
      // Check if tool result is already in history
      const hasToolResult = req.messages.some((m) => m.role === "tool");
      if (!hasToolResult) {
        // Coder calls write_file
        yield { type: "tool_call_started", toolCallId: "tc-write", toolName: "write_file" };
        yield {
          type: "tool_call_completed",
          toolCallId: "tc-write",
          toolName: "write_file",
          arguments: JSON.stringify({ path: "math.mjs", content: "export function multiply(a, b) { return a * b; }\n" }),
        };
        yield { type: "finish", finishReason: "tool_calls" };
      } else {
        yield { type: "text_delta", delta: "Completed multiply function in math.mjs." };
        yield { type: "finish", finishReason: "stop" };
      }
      return;
    }

    yield { type: "text_delta", delta: "Task completed." };
    yield { type: "finish", finishReason: "stop" };
  }

  async healthCheck() { return { status: "available" as const }; }
}

class RevisionScriptedProvider extends FullFlowScriptedProvider {
  readonly reviewerRequests: string[] = [];
  readonly coderRequests: string[] = [];
  private reviewerRound = 0;
  private coderRound = 0;

  override async *streamChat(req: ChatRequest): AsyncIterable<StreamEvent> {
    const systemPrompt = req.messages.find((message) => message.role === "system")?.content ?? "";
    if (systemPrompt.includes("CodeForge Reviewer")) {
      this.reviewerRequests.push(req.messages.map((message) => message.content).join("\n"));
      this.reviewerRound++;
      const payload = this.reviewerRound === 1
        ? { verdict: "revision_required", findings: [{ id: "zero", severity: "blocking", category: "correctness", message: "divide must reject zero divisors", evidence: "divide.mjs" }], summary: "CF07_REVIEWER_PRIVATE_MARKER_a3f9" }
        : { verdict: "pass", findings: [], summary: "Revision safely handles division by zero." };
      yield { type: "text_delta", delta: JSON.stringify(payload) };
      yield { type: "finish", finishReason: "stop" };
      return;
    }
    if (systemPrompt.includes("CodeForge Coder")) {
      this.coderRequests.push(req.messages.map((message) => message.content).join("\n"));
      const hasToolResult = req.messages.some((message) => message.role === "tool");
      if (!hasToolResult) {
        this.coderRound++;
        const content = this.coderRound === 1
          ? "export function divide(a, b) { return a / b; }\n"
          : "export function divide(a, b) { if (b === 0) throw new RangeError('division by zero'); return a / b; }\n";
        yield { type: "tool_call_started", toolCallId: `divide-${this.coderRound}`, toolName: "write_file" };
        yield { type: "tool_call_completed", toolCallId: `divide-${this.coderRound}`, toolName: "write_file", arguments: JSON.stringify({ path: "divide.mjs", content }) };
        yield { type: "finish", finishReason: "tool_calls" };
      } else {
        yield { type: "text_delta", delta: "CF07_CODER_PRIVATE_REVISION_MARKER_7d91" };
        yield { type: "finish", finishReason: "stop" };
      }
      return;
    }
    yield* super.streamChat(req);
  }
}

describe("Autonomous Orchestrator & Agent Runtime Full Pipeline (CF-07)", () => {
  let repoDir: string;
  let worktreeBaseDir: string;
  let persistence: ReturnType<typeof createSessionPersistence>;
  let eventStore: EventStore;
  let firewall: ForgeZero;

  beforeEach(async () => {
    repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "cf-e2e-repo-"));
    worktreeBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), "cf-e2e-worktrees-"));
    persistence = createSessionPersistence();
    eventStore = new EventStore();
    firewall = new ForgeZero();
    firewall.register(createGenericFreeRecord());

    // Initialize git repository
    await execFile("git", ["init", "-b", "main"], { cwd: repoDir });
    await execFile("git", ["config", "user.name", "CodeForge Agent"], { cwd: repoDir });
    await execFile("git", ["config", "user.email", "agent@codeforge.local"], { cwd: repoDir });
    await fs.writeFile(path.join(repoDir, "package.json"), JSON.stringify({ name: "math-lib", version: "1.0.0", type: "module" }), "utf-8");
    await fs.writeFile(path.join(repoDir, "math.mjs"), "export function multiply(a, b) { return 0; }\n", "utf-8");
    await fs.mkdir(path.join(repoDir, "test"));
    await fs.writeFile(path.join(repoDir, "test", "math.test.mjs"), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { multiply } from '../math.mjs';\ntest('multiply', () => assert.equal(multiply(6, 7), 42));\n", "utf-8");
    await execFile("git", ["add", "."], { cwd: repoDir });
    await execFile("git", ["commit", "-m", "Initial commit"], { cwd: repoDir });
  });

  afterEach(async () => {
    persistence.close();
    await fs.rm(repoDir, { recursive: true, force: true });
    await fs.rm(worktreeBaseDir, { recursive: true, force: true });
  });

  it("runs full production pipeline: Explorer -> Planner -> Coder -> Reviewer -> Verification -> Integration", async () => {
    const catalog = new InMemoryProviderCatalog();
    catalog.register(new FullFlowScriptedProvider("test-provider"));

    const workspaceService = createWorkspaceService({ persistence, worktreeParentDir: worktreeBaseDir });
    const runtime = createAgentRuntime({
      sessionId: "session-e2e",
      eventStore,
      persistence,
      firewall,
      providerCatalog: catalog,
      workspacePath: repoDir,
    });

    const subagentManager = createSubagentManager({
      persistence,
      workspaceService,
      agentRuntime: runtime,
    });

    const orchestrator = createAutonomousRunOrchestrator({
      workspaceService,
      persistence,
      subagentManager,
      agentRuntime: runtime,
    });

    const result = await orchestrator.startRun({
      sessionId: "session-e2e",
      workspacePath: repoDir,
      goal: "Implement multiply function and make its focused test pass",
      verificationCommands: ["node --test test/math.test.mjs"],
    });
    expect(result.status).toBe("completed");
    expect(result.integration.status).toBe("integrated");
    expect(result.review.passed).toBe(true);
    expect(result.changedFiles).toContain("math.mjs");
    expect(result.verification).toHaveLength(1);
    expect(result.verification[0]).toMatchObject({ command: "node --test test/math.test.mjs", cwd: expect.any(String), exitCode: 0, failed: 0 });

    // Verify file content in primary repository
    const mainMath = await fs.readFile(path.join(repoDir, "math.mjs"), "utf-8");
    expect(mainMath).toContain("return a * b;");
  });

  it("rejects a cyclic production Planner graph before the Coder starts", async () => {
    const catalog = new InMemoryProviderCatalog();
    const provider = new FullFlowScriptedProvider("test-provider", [
      { id: "A", title: "First", objective: "First task", dependencies: ["B"], assignedRole: "coder" },
      { id: "B", title: "Second", objective: "Second task", dependencies: ["A"], assignedRole: "reviewer" },
    ]);
    catalog.register(provider);
    const workspaceService = createWorkspaceService({ persistence, worktreeParentDir: worktreeBaseDir });
    const runtime = createAgentRuntime({ sessionId: "session-cycle", eventStore, persistence, firewall, providerCatalog: catalog, workspacePath: repoDir });
    const orchestrator = createAutonomousRunOrchestrator({ workspaceService, persistence, agentRuntime: runtime });

    const result = await orchestrator.startRun({ sessionId: "session-cycle", workspacePath: repoDir, goal: "Plan safely" });
    expect(result.status).not.toBe("completed");
    expect(result.integration.status).toBe("not_attempted");
    expect(provider.coderCalls).toBe(0);
  });

  it("rejects a Planner task with a missing dependency before the Coder starts", async () => {
    const catalog = new InMemoryProviderCatalog();
    const provider = new FullFlowScriptedProvider("test-provider", [
      { id: "code", title: "Code", objective: "Implement safely", dependencies: ["does-not-exist"], assignedRole: "coder" },
    ]);
    catalog.register(provider);
    const workspaceService = createWorkspaceService({ persistence, worktreeParentDir: worktreeBaseDir });
    const runtime = createAgentRuntime({ sessionId: "session-missing-dep", eventStore, persistence, firewall, providerCatalog: catalog, workspacePath: repoDir });
    const orchestrator = createAutonomousRunOrchestrator({ workspaceService, persistence, agentRuntime: runtime });
    const result = await orchestrator.startRun({ sessionId: "session-missing-dep", workspacePath: repoDir, goal: "Plan safely" });
    expect(result.status).not.toBe("completed");
    expect(result.integration.status).toBe("not_attempted");
    expect(provider.coderCalls).toBe(0);
  });

  it("blocks integration when real verification fails despite a structured reviewer pass", async () => {
    const catalog = new InMemoryProviderCatalog();
    catalog.register(new FullFlowScriptedProvider("test-provider"));
    const workspaceService = createWorkspaceService({ persistence, worktreeParentDir: worktreeBaseDir });
    const runtime = createAgentRuntime({ sessionId: "session-verify-fail", eventStore, persistence, firewall, providerCatalog: catalog, workspacePath: repoDir });
    const orchestrator = createAutonomousRunOrchestrator({ workspaceService, persistence, agentRuntime: runtime });

    const result = await orchestrator.startRun({
      sessionId: "session-verify-fail",
      workspacePath: repoDir,
      goal: "Implement multiply",
      verificationCommands: ["node -e \"process.exit(17)\""],
    });
    expect(result.status).toBe("blocked");
    expect(result.integration).toMatchObject({ status: "blocked", reason: "VERIFICATION_FAILED" });
    expect(result.verification[0]).toMatchObject({ command: "node -e \"process.exit(17)\"", failed: 1 });
  });

  it("uses the real AgentRuntime revision loop with structured findings and private-context isolation", async () => {
    await fs.writeFile(path.join(repoDir, "divide.mjs"), "export function divide(a, b) { return 0; }\n");
    await fs.writeFile(path.join(repoDir, "test", "divide.test.mjs"), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { divide } from '../divide.mjs';\ntest('divide', () => { assert.equal(divide(8, 2), 4); assert.throws(() => divide(1, 0)); });\n");
    await execFile("git", ["add", "."], { cwd: repoDir });
    await execFile("git", ["commit", "-m", "Add divide fixture"], { cwd: repoDir });
    const catalog = new InMemoryProviderCatalog();
    const provider = new RevisionScriptedProvider("revision-provider");
    catalog.register(provider);
    const workspaceService = createWorkspaceService({ persistence, worktreeParentDir: worktreeBaseDir });
    const runtime = createAgentRuntime({ sessionId: "session-revision", eventStore, persistence, firewall, providerCatalog: catalog, workspacePath: repoDir });
    const orchestrator = createAutonomousRunOrchestrator({ workspaceService, persistence, agentRuntime: runtime });
    const result = await orchestrator.startRun({ sessionId: "session-revision", workspacePath: repoDir, goal: "Implement divide with zero protection", verificationCommands: ["node --test test/divide.test.mjs"] });
    expect(result.status).toBe("completed");
    expect(result.counters.reviewRounds).toBe(1);
    expect(provider.reviewerRequests.join("\n")).not.toContain("CF07_CODER_PRIVATE_REVISION_MARKER_7d91");
    const revisionRequest = provider.coderRequests.find((request) => request.includes("divide must reject zero divisors"));
    expect(revisionRequest).toBeDefined();
    expect(revisionRequest).not.toContain("CF07_REVIEWER_PRIVATE_MARKER_a3f9");
    expect(await fs.readFile(path.join(repoDir, "divide.mjs"), "utf8")).toContain("b === 0");
  });
});
