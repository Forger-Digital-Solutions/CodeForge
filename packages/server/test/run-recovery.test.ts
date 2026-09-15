import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { AgentRunJournal } from "@codeforge/protocol";
import { createSessionPersistence, EventStore } from "@codeforge/sessions";
import { ForgeZero, createGenericFreeRecord } from "@codeforge/forge-zero";
import { InMemoryProviderCatalog } from "@codeforge/providers";
import {
  createAgentRuntime,
  createSubagentManager,
  createWorkspaceEventAdapter,
  type AgentRuntime,
  type SubagentManager,
} from "@codeforge/server";
import { classifyRunRecovery } from "../src/run-recovery.js";

const execFileAsync = promisify(execFile);
const fixturePath = fileURLToPath(new URL("./fixtures/run-recovery-worker.mjs", import.meta.url));

type RecoveryReport = Awaited<ReturnType<SubagentManager["recoverInterruptedWorkers"]>>;

const CHILD_TIMEOUT_MS = 90_000;

async function runFixtureChild(args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [fixturePath, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NODE_ENV: "test", CODEFORGE_ALLOW_TEST_PROVIDERS: "1" },
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`fixture child did not exit within ${CHILD_TIMEOUT_MS}ms\n${stderr.slice(-2_000)}`));
    }, CHILD_TIMEOUT_MS);
    child.on("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

interface RecoveryFixture {
  dbPath: string;
  repoDir: string;
  manager: SubagentManager;
  provider: CompletionScriptedProvider;
  persistence: ReturnType<typeof createSessionPersistence>;
  cleanup: () => Promise<void>;
}

/** Parent-side provider: never crashes. Serves the continuation turns of a resumed run. */
class CompletionScriptedProvider {
  providerId = "codeforge";
  isTestProvider = true;
  modelRequests = 0;

  async listModels() {
    return [{
      modelId: "free-model-1",
      displayName: "Free Model",
      isFree: true,
      freeStatus: "verified_free",
      capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true },
    }];
  }

  async chat(): Promise<never> {
    throw new Error("Use streamChat");
  }

  async healthCheck() {
    return { status: "available" as const };
  }

  async *streamChat(req: { messages: Array<{ role: string; content: string }> }): AsyncIterable<{ type: string; delta?: string; toolCallId?: string; toolName?: string; arguments?: string; finishReason?: string }> {
    this.modelRequests++;
    const system = req.messages.find((m) => m.role === "system")?.content ?? "";
    const isReviewer = system.includes("CodeForge Reviewer");
    const hasToolResult = req.messages.some((m) => m.role === "tool");
    if (isReviewer) {
      yield { type: "text_delta", delta: JSON.stringify({ verdict: "pass", findings: [], summary: "Reviewer approved after recovery." }) };
      yield { type: "finish", finishReason: "stop" };
      return;
    }
    if (hasToolResult) {
      yield { type: "text_delta", delta: "Continued after recovery and completed the fix." };
      yield { type: "finish", finishReason: "stop" };
      return;
    }
    yield { type: "text_delta", delta: "Task completed." };
    yield { type: "finish", finishReason: "stop" };
  }
}

async function buildRecoveryFixture(repoDir: string): Promise<RecoveryFixture> {
  const dbPath = path.join(repoDir, "session.db");
  const persistence = createSessionPersistence({ dbPath });
  const eventStore = new EventStore();
  const firewall = new ForgeZero();
  firewall.register(createGenericFreeRecord());
  const catalog = new InMemoryProviderCatalog();
  const provider = new CompletionScriptedProvider();
  catalog.register(provider);
  const runtime = createAgentRuntime({
    sessionId: "recovery-session",
    eventStore,
    persistence,
    firewall,
    providerCatalog: catalog,
    workspacePath: repoDir,
  });
  await runtime.init();
  const manager = createSubagentManager({ persistence, agentRuntime: runtime, r1Enabled: true });
  return {
    dbPath,
    repoDir,
    manager,
    provider,
    persistence,
    cleanup: async () => {
      persistence.close();
    },
  };
}

async function getItems(fixture: RecoveryFixture, kind: string): Promise<Array<Record<string, unknown>>> {
  const items = await fixture.persistence.getWorkItemsByKind(kind);
  return items.map((item) => (item ?? {}) as Record<string, unknown>);
}

describe("run recovery classification (pure)", () => {
  const baseJournal = {
    kind: "agent_run_journal" as const,
    id: "agent-run-journal-child-1",
    sessionId: "s",
    runId: "child-1",
    agentId: "coder",
    role: "coder",
    state: "active" as const,
    recoveryOutcome: "none" as const,
    messages: [
      { role: "system" as const, content: "system" },
      { role: "user" as const, content: "task" },
      {
        role: "assistant" as const,
        content: "",
        toolCalls: [{ id: "tc-1", name: "write_file", arguments: "{}" }],
      },
      { role: "tool" as const, content: "ok", toolCallId: "tc-1" },
    ],
    turnCount: 1,
    toolCallCount: 1,
    writeCallCount: 1,
    commandCallCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  it("FAIL when no journal exists", () => {
    const outcome = classifyRunRecovery(undefined, []);
    expect(outcome.outcome).toBe("fail");
  });

  it("FAIL when the journal transcript is empty", () => {
    const outcome = classifyRunRecovery({ ...baseJournal, messages: [] }, []);
    expect(outcome.outcome).toBe("fail");
  });

  it("REPLAN when the journal is already terminal", () => {
    const outcome = classifyRunRecovery({ ...baseJournal, state: "completed" }, []);
    expect(outcome.outcome).toBe("replan");
  });

  it("RESUME a consistent transcript with all tool records terminal", () => {
    const outcome = classifyRunRecovery(baseJournal, [
      { toolName: "write_file", executionClass: "write", state: "observation_recorded" },
    ]);
    expect(outcome.outcome).toBe("resume");
    if (outcome.outcome === "resume") expect(outcome.replayToolCallIds).toEqual([]);
  });

  it("REPLAN when a write tool was mid-flight even if the transcript looks consistent", () => {
    const outcome = classifyRunRecovery(baseJournal, [
      { toolName: "write_file", executionClass: "write", state: "observation_recorded" },
      { toolName: "write_file", executionClass: "write", state: "started" },
    ]);
    expect(outcome.outcome).toBe("replan");
  });

  it("RESUME with replay when only trailing read-only calls lack observations", () => {
    const journal = {
      ...baseJournal,
      messages: [
        { role: "system" as const, content: "system" },
        { role: "user" as const, content: "task" },
        {
          role: "assistant" as const,
          content: "",
          toolCalls: [{ id: "tc-1", name: "list_files", arguments: "{}" }],
        },
      ],
    };
    const outcome = classifyRunRecovery(journal, [
      { toolName: "list_files", executionClass: "read_only", state: "started" },
    ]);
    expect(outcome.outcome).toBe("resume");
    if (outcome.outcome === "resume") expect(outcome.replayToolCallIds).toEqual(["tc-1"]);
  });

  it("REPLAN when trailing unobserved calls include a command", () => {
    const journal = {
      ...baseJournal,
      messages: [
        { role: "system" as const, content: "system" },
        { role: "user" as const, content: "task" },
        {
          role: "assistant" as const,
          content: "",
          toolCalls: [{ id: "tc-1", name: "run_command", arguments: "{}" }],
        },
      ],
    };
    const outcome = classifyRunRecovery(journal, [
      { toolName: "run_command", executionClass: "command", state: "started" },
    ]);
    expect(outcome.outcome).toBe("replan");
  });
});

describe("durable active-worker crash recovery (real process boundaries)", () => {
  let rootDir: string;

  beforeAll(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "r2-recovery-"));
  });

  afterAll(async () => {
    try {
      await fs.rm(rootDir, { recursive: true, force: true });
    } catch {}
  });

  async function makeRepo(name: string): Promise<string> {
    const repoDir = path.join(rootDir, name);
    await fs.mkdir(repoDir, { recursive: true });
    await execFileAsync("git", ["init", "-b", "main"], { cwd: repoDir });
    await execFileAsync("git", ["config", "user.name", "CodeForge Agent"], { cwd: repoDir });
    await execFileAsync("git", ["config", "user.email", "agent@codeforge.local"], { cwd: repoDir });
    await fs.writeFile(path.join(repoDir, "package.json"), JSON.stringify({ name: "math-lib", version: "1.0.0", type: "module" }), "utf-8");
    await fs.writeFile(path.join(repoDir, "math.mjs"), "export function multiply(a, b) { return 0; }\n", "utf-8");
    await fs.mkdir(path.join(repoDir, "test"));
    await fs.writeFile(path.join(repoDir, "test", "math.test.mjs"), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { multiply } from '../math.mjs';\ntest('multiply', () => assert.equal(multiply(6, 7), 42));\n", "utf-8");
    await execFileAsync("git", ["add", "."], { cwd: repoDir });
    await execFileAsync("git", ["commit", "-m", "Initial commit"], { cwd: repoDir });
    return repoDir;
  }

  it("RESUME: crash before the first model call, run completes after restart", async () => {
    const repoDir = await makeRepo("kill-before-first-call");
    await runFixtureChild(["kill-before-first-call", path.join(repoDir, "session.db"), repoDir]);
    const fixture = await buildRecoveryFixture(repoDir);
    try {
      const report = await fixture.manager.recoverInterruptedWorkers();
      expect(report.resumed).toBe(1);
      expect(report.decisions[0]?.outcome).toBe("resume");

      const workers = await getItems(fixture, "subagent_run");
      expect(workers).toHaveLength(1);
      expect(workers[0].status).toBe("completed");

      const journals = await getItems(fixture, "agent_run_journal");
      expect(journals[0].state).toBe("completed");
    } finally {
      await fixture.cleanup();
    }
  });

  it("RESUME: crash after a real file write, no duplicate write after restart", async () => {
    const repoDir = await makeRepo("kill-after-write");
    const dbPath = path.join(repoDir, "session.db");
    await runFixtureChild(["kill-after-write", dbPath, repoDir]);
    const fixture = await buildRecoveryFixture(repoDir);
    try {
      const report = await fixture.manager.recoverInterruptedWorkers();
      expect(report.resumed).toBe(1);

      const workers = await getItems(fixture, "subagent_run");
      expect(workers[0].status).toBe("completed");

      const journals = await getItems(fixture, "agent_run_journal");
      expect(journals[0].state).toBe("completed");

      const fixed = await fs.readFile(path.join(repoDir, "math.mjs"), "utf-8");
      expect(fixed).toContain("return a * b");

      const writeRecords = (await getItems(fixture, "agent_tool_execution"))
        .filter((r) => r.toolName === "write_file" && r.state === "observation_recorded");
      expect(writeRecords).toHaveLength(1);
    } finally {
      await fixture.cleanup();
    }
  }, 120_000);

  it("RESUME: crash with an unobserved read-only call is replayed exactly once", async () => {
    const repoDir = await makeRepo("kill-readonly-unobserved");
    const dbPath = path.join(repoDir, "session.db");
    await runFixtureChild(["kill-readonly-unobserved", dbPath, repoDir]);
    const fixture = await buildRecoveryFixture(repoDir);
    try {
      const report = await fixture.manager.recoverInterruptedWorkers();
      expect(report.resumed).toBe(1);
      expect(report.decisions[0]?.reason).toContain("read-only");

      const workers = await getItems(fixture, "subagent_run");
      expect(workers[0].status).toBe("completed");

      const listRecords = (await getItems(fixture, "agent_tool_execution"))
        .filter((r) => r.toolName === "list_files");
      const observed = listRecords.filter((r) => r.state === "observation_recorded");
      expect(observed).toHaveLength(1);
      const superseded = listRecords.filter((r) => r.state !== "observation_recorded" && r.state !== "started" && r.state !== "requested");
      expect(superseded.length).toBeGreaterThanOrEqual(1);
    } finally {
      await fixture.cleanup();
    }
  }, 120_000);

  it("REPLAN: crash with an unobserved write converges honestly and never re-executes it", async () => {
    const repoDir = await makeRepo("kill-write-unobserved");
    const dbPath = path.join(repoDir, "session.db");
    await runFixtureChild(["kill-write-unobserved", dbPath, repoDir]);
    const fixture = await buildRecoveryFixture(repoDir);
    try {
      const report = await fixture.manager.recoverInterruptedWorkers();
      expect(report.replanned).toBeGreaterThanOrEqual(1);
      expect(report.decisions[0]?.outcome).toBe("replan");
      expect(report.decisions[0]?.reason).toContain("RECOVERY_REPLAN");

      const workers = await getItems(fixture, "subagent_run");
      expect(workers[0].status).toBe("failed");

      const journals = await getItems(fixture, "agent_run_journal");
      expect(journals[0].state).toBe("converged_failed");

      const content = await fs.readFile(path.join(repoDir, "math.mjs"), "utf-8");
      expect(content).not.toContain("RECOVERY_MUST_NOT_WRITE_THIS");
      expect(content).toContain("return 0");
    } finally {
      await fixture.cleanup();
    }
  }, 120_000);

  it("REPLAN: crash with an unobserved command converges honestly and never re-executes it", async () => {
    const repoDir = await makeRepo("kill-command-unobserved");
    const dbPath = path.join(repoDir, "session.db");
    await runFixtureChild(["kill-command-unobserved", dbPath, repoDir]);
    const fixture = await buildRecoveryFixture(repoDir);
    try {
      const report = await fixture.manager.recoverInterruptedWorkers();
      expect(report.replanned).toBeGreaterThanOrEqual(1);
      expect(report.decisions[0]?.reason).toContain("not provably replay-safe");

      const journals = await getItems(fixture, "agent_run_journal");
      expect(journals[0].state).toBe("converged_failed");
    } finally {
      await fixture.cleanup();
    }
  }, 120_000);

  it("RESUME: a reviewer killed mid-run resumes and still fails the run closed when its verdict blocks", async () => {
    const repoDir = await makeRepo("kill-reviewer");
    await runFixtureChild(["kill-reviewer", path.join(repoDir, "session.db"), repoDir]);
    const fixture = await buildRecoveryFixture(repoDir);
    try {
      const report = await fixture.manager.recoverInterruptedWorkers();
      expect(report.resumed).toBe(1);

      const workers = await getItems(fixture, "subagent_run");
      expect(workers[0].agentId).toBe("reviewer");
      expect(workers[0].status).toBe("completed");
    } finally {
      await fixture.cleanup();
    }
  }, 120_000);

  it("FAIL: a non-terminal worker record without a journal converges to failed", async () => {
    const repoDir = await makeRepo("no-journal");
    const fixture = await buildRecoveryFixture(repoDir);
    try {
      const now = new Date().toISOString();
      await fixture.persistence.upsertSession({
        id: "recovery-session",
        title: "Recovery Session",
        createdAt: now,
        updatedAt: now,
        status: "running",
      });
      await fixture.persistence.upsertWorkItem({
        kind: "subagent_run",
        id: "child-legacy",
        sessionId: "recovery-session",
        parentRunId: "parent-legacy",
        agentId: "coder",
        role: "coder",
        task: "t",
        depth: 1,
        status: "running",
        capsule: {
          schemaVersion: 1,
          assignment: "a",
          goal: "g",
          relevantFiles: [],
          knownEvidence: [],
          constraints: [],
          requiredOutput: [],
        },
        permissions: { read: true, search: true, write: true, executeCommand: true, network: false },
        allowedTools: [],
        workspace: { id: "child-legacy", kind: "local" },
        budget: { maxModelTurns: 25, maxToolCalls: 50, maxContextTokens: 64_000, wallTimeMs: 60_000 },
        telemetry: { wallTimeMs: 0, modelRequests: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0, retryCount: 0, duplicateWorkCount: 0, providerFailures: 0 },
        artifacts: [],
        createdAt: now,
        updatedAt: now,
      } as never);

      const report = await fixture.manager.recoverInterruptedWorkers();
      expect(report.failed).toBe(1);
      expect(report.decisions[0]?.outcome).toBe("fail");
      expect(report.decisions[0]?.reason).toContain("RECOVERY_FAIL");
    } finally {
      await fixture.cleanup();
    }
  });

  it("CANCELLATION: a worker cancelled before the crash never resurrects", async () => {
    const repoDir = await makeRepo("cancelled-worker");
    const fixture = await buildRecoveryFixture(repoDir);
    try {
      const now = new Date().toISOString();
      await fixture.persistence.upsertSession({
        id: "recovery-session",
        title: "Recovery Session",
        createdAt: now,
        updatedAt: now,
        status: "running",
      });
      await fixture.persistence.upsertWorkItem({
        kind: "subagent_run",
        id: "child-cancelled",
        sessionId: "recovery-session",
        parentRunId: "parent-1",
        agentId: "coder",
        role: "coder",
        task: "t",
        depth: 1,
        status: "cancelled",
        budget: { maxModelTurns: 5, maxToolCalls: 10, maxContextTokens: 10_000, wallTimeMs: 10_000 },
        telemetry: { wallTimeMs: 0, modelRequests: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0, retryCount: 0, duplicateWorkCount: 0, providerFailures: 0 },
        artifacts: [],
        createdAt: now,
        updatedAt: now,
      } as never);

      const report = await fixture.manager.recoverInterruptedWorkers();
      expect(report.resumed).toBe(0);
      expect(report.replanned).toBe(0);
      expect(report.failed).toBe(0);
      expect(fixture.provider.modelRequests).toBe(0);

      const workers = await getItems(fixture, "subagent_run");
      expect(workers[0]?.status).toBe("cancelled");
    } finally {
      await fixture.cleanup();
    }
  });

  it("TERMINAL: an already completed worker is skipped and never resumes", async () => {
    const repoDir = await makeRepo("completed-worker");
    const fixture = await buildRecoveryFixture(repoDir);
    try {
      const now = new Date().toISOString();
      await fixture.persistence.upsertSession({
        id: "recovery-session",
        title: "Recovery Session",
        createdAt: now,
        updatedAt: now,
        status: "running",
      });
      await fixture.persistence.upsertWorkItem({
        kind: "subagent_run",
        id: "child-done",
        sessionId: "recovery-session",
        parentRunId: "parent-1",
        agentId: "coder",
        role: "coder",
        task: "t",
        depth: 1,
        status: "completed",
        budget: { maxModelTurns: 5, maxToolCalls: 10, maxContextTokens: 10_000, wallTimeMs: 10_000 },
        telemetry: { wallTimeMs: 0, modelRequests: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0, retryCount: 0, duplicateWorkCount: 0, providerFailures: 0 },
        artifacts: [],
        createdAt: now,
        updatedAt: now,
      } as never);

      const report = await fixture.manager.recoverInterruptedWorkers();
      expect(report.resumed).toBe(0);
      expect(fixture.provider.modelRequests).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  });

  it("DUPLICATE LEASE: recovery lease prevents simultaneous recovery of the same worker", async () => {
    const repoDir = await makeRepo("duplicate-recovery");
    const fixture = await buildRecoveryFixture(repoDir);
    try {
      const now = new Date().toISOString();
      await fixture.persistence.upsertSession({
        id: "recovery-session",
        title: "Recovery Session",
        createdAt: now,
        updatedAt: now,
        status: "running",
      });
      await fixture.persistence.upsertWorkItem({
        kind: "subagent_run",
        id: "child-stale",
        sessionId: "recovery-session",
        parentRunId: "parent-1",
        agentId: "coder",
        role: "coder",
        task: "t",
        depth: 1,
        status: "running",
        budget: { maxModelTurns: 5, maxToolCalls: 10, maxContextTokens: 10_000, wallTimeMs: 10_000 },
        telemetry: { wallTimeMs: 0, modelRequests: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0, retryCount: 0, duplicateWorkCount: 0, providerFailures: 0 },
        artifacts: [],
        createdAt: now,
        updatedAt: now,
      } as never);

      await fixture.persistence.upsertWorkItem({
        kind: "agent_recovery_lease",
        id: "recovery-lease-child-stale",
        sessionId: "recovery-session",
        workerId: "child-stale",
        ownerId: "other-recovery-process-42",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        createdAt: now,
        updatedAt: now,
      } as never);

      const report = await fixture.manager.recoverInterruptedWorkers({ recoveryOwnerId: "my-recovery-caller" });
      expect(report.resumed).toBe(0);
      expect(report.decisions).toHaveLength(0);
    } finally {
      await fixture.cleanup();
    }
  });

  it("WORKTREE: missing worktree fails closed as replan", async () => {
    const repoDir = await makeRepo("worktree-missing");
    const fixture = await buildRecoveryFixture(repoDir);
    try {
      const now = new Date().toISOString();
      await fixture.persistence.upsertSession({
        id: "recovery-session",
        title: "Recovery Session",
        createdAt: now,
        updatedAt: now,
        status: "running",
      });
      await fixture.persistence.upsertWorkItem({
        kind: "subagent_run",
        id: "child-worktree-missing",
        sessionId: "recovery-session",
        parentRunId: "parent-1",
        agentId: "coder",
        role: "coder",
        task: "t",
        depth: 1,
        status: "running",
        workspace: { id: "child-worktree-missing", kind: "git-worktree" },
        workspacePath: path.join(repoDir, "non-existent-worktree-dir"),
        budget: { maxModelTurns: 5, maxToolCalls: 10, maxContextTokens: 10_000, wallTimeMs: 10_000 },
        telemetry: { wallTimeMs: 0, modelRequests: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0, retryCount: 0, duplicateWorkCount: 0, providerFailures: 0 },
        artifacts: [],
        createdAt: now,
        updatedAt: now,
      } as never);

      await fixture.persistence.upsertWorkItem({
        kind: "agent_run_journal",
        id: "agent-run-journal-child-worktree-missing",
        sessionId: "recovery-session",
        runId: "child-worktree-missing",
        agentId: "coder",
        role: "coder",
        state: "active",
        recoveryOutcome: "none",
        messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }],
        turnCount: 1,
        toolCallCount: 0,
        writeCallCount: 0,
        commandCallCount: 0,
        createdAt: now,
        updatedAt: now,
      } as never);

      const report = await fixture.manager.recoverInterruptedWorkers();
      expect(report.replanned).toBe(1);
      const workers = await getItems(fixture, "subagent_run");
      expect(workers[0]?.status).toBe("failed");
      expect(workers[0]?.error).toContain("RECOVERY_REPLAN: worktree path does not exist on disk");
    } finally {
      await fixture.cleanup();
    }
  });
});
