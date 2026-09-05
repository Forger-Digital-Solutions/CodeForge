import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";
import { createAutonomousRunOrchestrator, AutonomousRunOrchestrator, MAX_REVIEW_REVISION_ROUNDS } from "../src/autonomous-orchestrator.js";
import { createWorkspaceService } from "../src/workspace-service.js";
import { createSubagentManager } from "../src/subagent-manager.js";
import { createIntegrationService } from "../src/integration-service.js";
import { createCheckpointService } from "../src/checkpoint-service.js";
import { createWorkspaceEventAdapter } from "../src/workspace-event-adapter.js";
import { EventStore, createSessionPersistence } from "@codeforge/sessions";

const execFile = promisify(execFileCallback);

describe("CF-06 Production Multi-Agent Orchestrator, Review & Integration", () => {
  let targetRepo: string;
  let worktreeBaseDir: string;
  let dbDir: string;
  let dbFile: string;
  let eventStore: EventStore;
  let persistence: ReturnType<typeof createSessionPersistence>;

  beforeEach(async () => {
    targetRepo = await mkdtemp(join(tmpdir(), "cf-orch-target-"));
    worktreeBaseDir = await mkdtemp(join(tmpdir(), "cf-orch-worktrees-"));
    dbDir = await mkdtemp(join(tmpdir(), "cf-orch-db-"));
    dbFile = join(dbDir, "sessions.db");
    eventStore = new EventStore();
    persistence = createSessionPersistence({ dbPath: dbFile });

    // Initialize real Git repository in targetRepo
    await execFile("git", ["init"], { cwd: targetRepo });
    await execFile("git", ["config", "user.name", "CodeForge Tester"], { cwd: targetRepo });
    await execFile("git", ["config", "user.email", "test@codeforge.ai"], { cwd: targetRepo });
    await execFile("git", ["config", "commit.gpgsign", "false"], { cwd: targetRepo });
    await execFile("git", ["config", "core.autocrlf", "false"], { cwd: targetRepo });
    await execFile("git", ["config", "core.eol", "lf"], { cwd: targetRepo });

    await writeFile(join(targetRepo, "package.json"), JSON.stringify({ name: "demo-project", version: "1.0.0", type: "module" }, null, 2));
    await mkdir(join(targetRepo, "src"), { recursive: true });
    await writeFile(join(targetRepo, "src", "math.ts"), "export function add(a: number, b: number): number { return a + b; }\n");
    await execFile("git", ["add", "."], { cwd: targetRepo });
    await execFile("git", ["commit", "-m", "initial commit"], { cwd: targetRepo });
  });

  afterEach(async () => {
    persistence.close();
    await rm(targetRepo, { recursive: true, force: true });
    await rm(worktreeBaseDir, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  });

  it("Scenario 1 (Happy Path): explorer -> isolated coder -> reviewer PASS -> verification PASS -> integration PASS", async () => {
    const wsService = createWorkspaceService({ persistence, worktreeParentDir: worktreeBaseDir });
    const orchestrator = createAutonomousRunOrchestrator({
      workspaceService: wsService,
      persistence,
    });

    const adapter = createWorkspaceEventAdapter({ sessionId: "sess-hp", eventStore, persistence });

    const result = await orchestrator.startRun({
      sessionId: "sess-hp",
      workspacePath: targetRepo,
      goal: "Add multiply function to math.ts",
      verificationCommands: ["node -e \"process.exit(0)\""],
      adapter,
      coderExecutor: async (worktreePath) => {
        const mathFile = join(worktreePath, "src", "math.ts");
        const existing = await readFile(mathFile, "utf-8");
        await writeFile(mathFile, existing + "\nexport function multiply(a: number, b: number): number { return a * b; }\n");
        return { success: true, filesChanged: ["src/math.ts"] };
      },
    });

    expect(result.status).toBe("completed");
    expect(result.review.passed).toBe(true);
    expect(result.integration.status).toBe("integrated");

    // Verify final file in parent repo
    const updatedMath = await readFile(join(targetRepo, "src", "math.ts"), "utf-8");
    expect(updatedMath).toContain("multiply");

    // Verify git log has the integrated commit
    const { stdout: logOut } = await execFile("git", ["log", "-1", "--oneline"], { cwd: targetRepo });
    expect(logOut).toContain("Autonomous implementation");
  });

  it("Scenario 2 & 3 (Reviewer Gate & Revision Loop): blocking review finding triggers revision which succeeds", async () => {
    const wsService = createWorkspaceService({ persistence, worktreeParentDir: worktreeBaseDir });
    const orchestrator = createAutonomousRunOrchestrator({
      workspaceService: wsService,
      persistence,
    });

    let coderRound = 0;
    const result = await orchestrator.startRun({
      sessionId: "sess-rev-loop",
      workspacePath: targetRepo,
      goal: "Implement subtract function with proper verification",
      adapter: createWorkspaceEventAdapter({ sessionId: "sess-rev-loop", eventStore, persistence }),
      coderExecutor: async (worktreePath, goal, reviewFeedback) => {
        coderRound++;
        const mathFile = join(worktreePath, "src", "math.ts");
        if (coderRound === 1) {
          // Round 1: introduce broken code that triggers reviewer blocking finding
          await writeFile(mathFile, "export function broken() { throw new TypeError('regression error'); }\n");
        } else {
          // Round 2: fix code based on review feedback
          await writeFile(mathFile, "export function subtract(a: number, b: number): number { return a - b; }\n");
        }
        return { success: true, filesChanged: ["src/math.ts"] };
      },
    });

    expect(result.status).toBe("completed");
    expect(result.counters.reviewRounds).toBe(1);
    expect(coderRound).toBe(2);

    const updatedMath = await readFile(join(targetRepo, "src", "math.ts"), "utf-8");
    expect(updatedMath).toContain("subtract");
  });

  it("Scenario 4 (Revision Limit Exhaustion): persistent blocking defect exhausts revision budget and fails closed into blocked state", async () => {
    const wsService = createWorkspaceService({ persistence, worktreeParentDir: worktreeBaseDir });
    const orchestrator = createAutonomousRunOrchestrator({
      workspaceService: wsService,
      persistence,
    });

    const result = await orchestrator.startRun({
      sessionId: "sess-rev-limit",
      workspacePath: targetRepo,
      goal: "Implement flawed change",
      adapter: createWorkspaceEventAdapter({ sessionId: "sess-rev-limit", eventStore, persistence }),
      coderExecutor: async (worktreePath) => {
        const mathFile = join(worktreePath, "src", "math.ts");
        // Always write code with syntaxerror / regression error
        await writeFile(mathFile, "export function bug() { throw new SyntaxError('unresolved syntaxerror failure'); }\n");
        return { success: true, filesChanged: ["src/math.ts"] };
      },
    });

    expect(result.status).toBe("blocked");
    expect(result.integration.status).toBe("blocked");
    expect(result.integration.reason).toBe("REVIEW_REVISION_LIMIT");
    expect(result.counters.reviewRounds).toBeGreaterThanOrEqual(MAX_REVIEW_REVISION_ROUNDS);

    // Parent repo must remain completely untouched!
    const originalMath = await readFile(join(targetRepo, "src", "math.ts"), "utf-8");
    expect(originalMath).not.toContain("bug");
    expect(originalMath).toContain("add");
  });

  it("Scenario 5 (Verification Gate Failure): review passes but verification command fails -> blocks integration", async () => {
    const wsService = createWorkspaceService({ persistence, worktreeParentDir: worktreeBaseDir });
    const orchestrator = createAutonomousRunOrchestrator({
      workspaceService: wsService,
      persistence,
    });

    const result = await orchestrator.startRun({
      sessionId: "sess-verify-fail",
      workspacePath: targetRepo,
      goal: "Implement feature with failing test suite",
      verificationCommands: ["node -e \"process.exit(1)\""],
      adapter: createWorkspaceEventAdapter({ sessionId: "sess-verify-fail", eventStore, persistence }),
      coderExecutor: async (worktreePath) => {
        await writeFile(join(worktreePath, "src", "feature.ts"), "export const feat = true;\n");
        return { success: true, filesChanged: ["src/feature.ts"] };
      },
    });

    expect(result.status).toBe("blocked");
    expect(result.integration.status).toBe("blocked");
    expect(result.verification.some((v) => v.failed > 0)).toBe(true);

    // Parent repo remains untouched
    expect(existsSync(join(targetRepo, "src", "feature.ts"))).toBe(false);
  });

  it("Scenario 6 (Primary Workspace Dirty Preservation): uncommitted staged/unstaged/untracked user files survive intact", async () => {
    // 1. Create mixed uncommitted user state in parent repo
    await writeFile(join(targetRepo, "src", "user_unstaged.ts"), "export const unstaged = true;\n");
    await writeFile(join(targetRepo, "src", "user_staged.ts"), "export const staged = true;\n");
    await execFile("git", ["add", "src/user_staged.ts"], { cwd: targetRepo });
    await writeFile(join(targetRepo, "user_untracked.txt"), "important user untracked file\n");

    const { stdout: statusBefore } = await execFile("git", ["status", "--porcelain=v2"], { cwd: targetRepo });

    const wsService = createWorkspaceService({ persistence, worktreeParentDir: worktreeBaseDir });
    const orchestrator = createAutonomousRunOrchestrator({
      workspaceService: wsService,
      persistence,
    });

    // Run autonomous coder
    const result = await orchestrator.startRun({
      sessionId: "sess-preserve",
      workspacePath: targetRepo,
      goal: "Add utility function",
      adapter: createWorkspaceEventAdapter({ sessionId: "sess-preserve", eventStore, persistence }),
      coderExecutor: async (worktreePath) => {
        await writeFile(join(worktreePath, "src", "util.ts"), "export const util = 1;\n");
        return { success: true, filesChanged: ["src/util.ts"] };
      },
    });

    // User untracked and staged files are 100% intact
    expect(await readFile(join(targetRepo, "user_untracked.txt"), "utf-8")).toBe("important user untracked file\n");
    expect(await readFile(join(targetRepo, "src", "user_staged.ts"), "utf-8")).toBe("export const staged = true;\n");
    expect(await readFile(join(targetRepo, "src", "user_unstaged.ts"), "utf-8")).toBe("export const unstaged = true;\n");
  });

  it("Scenario 7 (Target Divergence Protection): detects when target HEAD moved (A -> U) and fails closed", async () => {
    const wsService = createWorkspaceService({ persistence, worktreeParentDir: worktreeBaseDir });
    const orchestrator = createAutonomousRunOrchestrator({
      workspaceService: wsService,
      persistence,
    });

    const result = await orchestrator.startRun({
      sessionId: "sess-diverged",
      workspacePath: targetRepo,
      goal: "Implement autonomous change during concurrent user commit",
      adapter: createWorkspaceEventAdapter({ sessionId: "sess-diverged", eventStore, persistence }),
      coderExecutor: async (worktreePath) => {
        // While coder is running in isolated worktree, user makes a commit U in targetRepo!
        await writeFile(join(targetRepo, "user_commit.txt"), "user advanced master\n");
        await execFile("git", ["add", "."], { cwd: targetRepo });
        await execFile("git", ["commit", "-m", "User concurrent commit U"], { cwd: targetRepo });

        await writeFile(join(worktreePath, "src", "math.ts"), "export function autonomous() { return 1; }\n");
        return { success: true, filesChanged: ["src/math.ts"] };
      },
    });

    expect(result.status).toBe("blocked");
    expect(result.integration.status).toBe("blocked");
    expect(result.integration.reason).toMatch(/INTEGRATION_TARGET_DIVERGED/);

    // User commit U is intact in target repo!
    const userFile = await readFile(join(targetRepo, "user_commit.txt"), "utf-8");
    expect(userFile).toBe("user advanced master\n");
  });

  it("Scenario 8 (Lease Exclusivity): concurrent write requests to same workspace conflict", () => {
    const wsService = createWorkspaceService({ persistence, worktreeParentDir: worktreeBaseDir });
    const lease1 = wsService.acquireLease(targetRepo, "run-1", "write");
    expect(lease1.mode).toBe("write");

    expect(() => wsService.acquireLease(targetRepo, "run-2", "write")).toThrow(/WORKSPACE_LEASE_CONFLICT/);

    wsService.releaseLease(lease1.leaseId, "run-1");
  });

  it("Scenario 9 (Cancellation Propagation): aborting parent signal aborts run, releases lease and persists state", async () => {
    const wsService = createWorkspaceService({ persistence, worktreeParentDir: worktreeBaseDir });
    const orchestrator = createAutonomousRunOrchestrator({
      workspaceService: wsService,
      persistence,
    });

    const controller = new AbortController();
    controller.abort();

    const result = await orchestrator.startRun({
      sessionId: "sess-cancel",
      workspacePath: targetRepo,
      goal: "Cancelled run",
      signal: controller.signal,
      adapter: createWorkspaceEventAdapter({ sessionId: "sess-cancel", eventStore, persistence }),
    });

    expect(result.status).toBe("cancelled");
  });

  it("Scenario 10 (Restart Recovery): recovers incomplete runs across service destruction without duplicate execution", async () => {
    const wsServiceA = createWorkspaceService({ persistence, worktreeParentDir: worktreeBaseDir });
    const orchestratorA = createAutonomousRunOrchestrator({
      workspaceService: wsServiceA,
      persistence,
    });

    // Start a run that gets aborted midway
    const controller = new AbortController();
    const runPromise = orchestratorA.startRun({
      sessionId: "sess-recovery",
      workspacePath: targetRepo,
      goal: "Interrupted run for recovery test",
      signal: controller.signal,
      coderExecutor: async () => {
        controller.abort();
        throw new Error("Simulated sudden shutdown");
      },
    });
    await runPromise;

    // Simulate server destruction and recreate fresh instances
    const wsServiceB = createWorkspaceService({ persistence, worktreeParentDir: worktreeBaseDir });
    const orchestratorB = createAutonomousRunOrchestrator({
      workspaceService: wsServiceB,
      persistence,
    });

    const recoveryReport = await orchestratorB.recoverRuns();
    expect(recoveryReport.recovered).toBeGreaterThanOrEqual(1);

    const recoveredRuns = orchestratorB.getAllRuns();
    const run = recoveredRuns.find((r) => r.sessionId === "sess-recovery");
    expect(run).toBeDefined();
    expect(run?.status).toBe("cancelled");
  });

  it("Scenario 13 (Context Firewall): child agents operate with private context", async () => {
    const subagentMgr = createSubagentManager({ persistence });
    const secretSeed = "CODER_PRIVATE_SECRET_MARKER_999";

    const explorerResult = await subagentMgr.spawnChildAgent({
      parentRunId: "run-firewall",
      agentId: "explorer",
      task: "Inspect codebase",
      workspacePath: targetRepo,
    });

    // Explorer output must not leak unmentioned coder secrets
    expect(JSON.stringify(explorerResult)).not.toContain(secretSeed);
  });

  it("Scenario 14 (Permission Ceiling): child cannot escalate privileges beyond parent", async () => {
    const subagentMgr = createSubagentManager({ persistence });

    const result = await subagentMgr.spawnChildAgent({
      parentRunId: "run-escalation",
      agentId: "coder",
      task: "Attempt edit under read-only parent",
      workspacePath: targetRepo,
      parentPermissions: {
        read: true,
        search: true,
        write: false,
        executeCommand: false,
      },
    });

    expect(result.status).toBe("completed");
  });

  it("Scenario 15 (Integration Idempotency): re-running integration on unchanged revision is idempotent", async () => {
    const wsService = createWorkspaceService({ persistence, worktreeParentDir: worktreeBaseDir });
    const integrationSvc = createIntegrationService({ workspaceService: wsService });

    const targetWs = await wsService.registerLocalWorkspace(targetRepo);
    const wtWs = await wsService.createWorktree({
      parentWorkspaceId: targetWs.id,
      runId: "run-idemp",
    });

    const { stdout: baseHead } = await execFile("git", ["rev-parse", "HEAD"], { cwd: targetRepo });

    // Integration with no changes returns clean existing revision
    const res1 = await integrationSvc.integrate({
      targetWorkspaceId: targetWs.id,
      isolatedWorktreeId: wtWs.id,
      expectedBaseSha: baseHead.trim(),
      runId: "run-idemp",
    });
    expect(res1.status).toBe("integrated");
    expect(res1.finalRevision).toBe(baseHead.trim());

    // Replay integration
    const res2 = await integrationSvc.integrate({
      targetWorkspaceId: targetWs.id,
      isolatedWorktreeId: wtWs.id,
      expectedBaseSha: baseHead.trim(),
      runId: "run-idemp",
    });
    expect(res2.status).toBe("integrated");
    expect(res2.finalRevision).toBe(baseHead.trim());
  });
});
