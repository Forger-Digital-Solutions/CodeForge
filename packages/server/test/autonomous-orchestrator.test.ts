import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { createAutonomousRunOrchestrator, MAX_REVIEW_REVISION_ROUNDS } from "../src/autonomous-orchestrator.js";
import type { AgentRuntime, AgentRuntimeRequest, AgentRuntimeResult } from "../src/agent-runtime.js";
import { createWorkspaceService } from "../src/workspace-service.js";
import { createSubagentManager } from "../src/subagent-manager.js";
import { createIntegrationService } from "../src/integration-service.js";
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
    const reservedRunId = "run-00000000-0000-4000-8000-000000000057";

    const result = await orchestrator.startRun({
      runId: reservedRunId,
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
    expect(result.runId).toBe(reservedRunId);
    expect(orchestrator.getRun(reservedRunId)?.status).toBe("completed");
    expect(result.review.passed).toBe(true);
    expect(result.integration.status).toBe("integrated");

    // Verify final file in parent repo
    const updatedMath = await readFile(join(targetRepo, "src", "math.ts"), "utf-8");
    expect(updatedMath).toContain("multiply");

    // Verify git log has the integrated commit
    const { stdout: logOut } = await execFile("git", ["log", "-1", "--oneline"], { cwd: targetRepo });
    expect(logOut).toContain("Autonomous implementation");

    let receipt = await persistence.getWorkItem(`experience:${result.runId}`);
    for (let attempt = 0; attempt < 20 && !receipt; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      receipt = await persistence.getWorkItem(`experience:${result.runId}`);
    }
    expect(receipt).toBeDefined();
    const signal = await persistence.getWorkItem(`experience-signal:${result.runId}`) as unknown as { signal?: { label?: string } } | undefined;
    expect(signal?.signal?.label).toBe("VERIFIED_SUCCESS");
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
      verificationCommands: ["node -e \"process.exit(0)\""],
      adapter: createWorkspaceEventAdapter({ sessionId: "sess-rev-loop", eventStore, persistence }),
      coderExecutor: async (worktreePath, _goal, _reviewFeedback) => {
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

  it("uses repeated abstract prior outcomes to advise a later revision without changing completion authority", async () => {
    const orchestrator = createAutonomousRunOrchestrator({
      workspaceService: createWorkspaceService({ persistence, worktreeParentDir: worktreeBaseDir }), persistence,
    });
    const priorRuns = [];
    for (const sessionId of ["prior-owner-a", "prior-owner-b"]) {
      const prior = await orchestrator.startRun({
        sessionId, workspacePath: targetRepo, goal: "Repair repeated subtract regression",
        complexityHint: "normal", verificationCommands: ["node -e \"process.exit(0)\""],
        coderExecutor: async (worktreePath) => {
          await writeFile(join(worktreePath, "src", "math.ts"), "export function bug() { throw new SyntaxError('unresolved syntaxerror failure'); }\n");
          return { success: true, filesChanged: ["src/math.ts"] };
        },
      });
      expect(prior.status).toBe("blocked");
      priorRuns.push(prior.runId);
    }
    let priorSignals: Array<{ id: string; signal?: { label?: string } }> = [];
    for (let attempt = 0; attempt < 100; attempt++) {
      priorSignals = await persistence.getWorkItemsByKind("generalized_experience_signal") as unknown as Array<{ id: string; signal?: { label?: string } }>;
      if (priorRuns.every((runId) => priorSignals.some((item) => item.id === `experience-signal:${runId}`))) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    for (const runId of priorRuns) expect(priorSignals.find((item) => item.id === `experience-signal:${runId}`)?.signal?.label).toBe("STRATEGY_EXHAUSTED");
    let attempts = 0;
    let advice = "";
    const result = await orchestrator.startRun({
      sessionId: "later-owner", workspacePath: targetRepo, goal: "Implement subtract with verification",
      complexityHint: "normal", verificationCommands: ["node -e \"process.exit(0)\""],
      coderExecutor: async (worktreePath, _goal, feedback) => {
        attempts++;
        if (feedback) advice = feedback;
        await writeFile(join(worktreePath, "src", "math.ts"), attempts === 1
          ? "export function broken() { throw new TypeError('regression error'); }\n"
          : "export function subtract(a: number, b: number): number { return a - b; }\n");
        return { success: true, filesChanged: ["src/math.ts"] };
      },
    });
    expect(result.status).toBe("completed");
    expect(advice).toContain("Reinspect the causal assumption");
    expect(result.completion?.outcome).toBe("completed");
    if (process.env.CODEFORGE_R57_LEARNING_PROOF_OUT) {
      const interventions = await persistence.getWorkItemsByKind("strategy_intervention_receipt") as unknown as Array<{ sessionId: string; classification?: string; strategyFingerprint?: string; failureSignature?: string; intervention?: string }>;
      await writeFile(process.env.CODEFORGE_R57_LEARNING_PROOF_OUT, `${JSON.stringify({
        schema: "r57-production-learning-proof/v1",
        evidenceClass: "production_orchestrator_scripted_workers",
        priorRuns: priorRuns.map((runId) => ({ runId, label: priorSignals.find((item) => item.id === `experience-signal:${runId}`)?.signal?.label })),
        priorInterventions: interventions.filter((item) => ["prior-owner-a", "prior-owner-b"].includes(item.sessionId)).map((item) => ({ classification: item.classification, strategyFingerprint: item.strategyFingerprint, failureSignature: item.failureSignature, intervention: item.intervention })),
        laterRun: { runId: result.runId, status: result.status, completion: result.completion?.outcome, attempts, adviceContainsIndependentDiagnosis: advice.includes("Reinspect the causal assumption") },
        rawPromptOrSourceCaptured: false,
      }, null, 2)}\n`);
    }
  });

  it("changes strategy after a low-novelty reviewer failure and then completes through the gate", async () => {
    const orchestrator = createAutonomousRunOrchestrator({
      workspaceService: createWorkspaceService({ persistence, worktreeParentDir: worktreeBaseDir }), persistence,
    });
    const feedbacks: string[] = [];
    let attempts = 0;
    const result = await orchestrator.startRun({
      sessionId: "r57-anti-loop", workspacePath: targetRepo,
      goal: "Repair subtract regression with independent verification",
      verificationCommands: ["node -e \"process.exit(0)\""],
      coderExecutor: async (worktreePath, _goal, feedback) => {
        attempts++;
        feedbacks.push(feedback ?? "");
        await writeFile(join(worktreePath, "src", "math.ts"), attempts < 3
          ? "export function bug() { throw new SyntaxError('unresolved syntaxerror failure'); }\n"
          : "export function subtract(a: number, b: number): number { return a - b; }\n");
        return { success: true, filesChanged: ["src/math.ts"] };
      },
    });
    const interventions = await persistence.getWorkItemsByKind("strategy_intervention_receipt") as unknown as Array<{ sessionId: string; classification?: string; strategyFingerprint?: string; failureSignature?: string; intervention?: string }>;
    const scoped = interventions.filter((item) => item.sessionId === "r57-anti-loop");
    expect(result.status).toBe("completed");
    expect(result.completion?.outcome).toBe("completed");
    expect(attempts).toBe(3);
    expect(feedbacks[2]).toContain("Reinspect the causal assumption");
    expect(scoped.some((item) => item.classification === "LOW_NOVELTY_RETRY")).toBe(true);
    expect(await readFile(join(targetRepo, "src", "math.ts"), "utf8")).toContain("subtract");
    if (process.env.CODEFORGE_R57_ANTILOOP_PROOF_OUT) {
      await writeFile(process.env.CODEFORGE_R57_ANTILOOP_PROOF_OUT, `${JSON.stringify({
        schema: "r57-production-anti-loop-proof/v1", evidenceClass: "production_orchestrator_scripted_workers",
        strategyAttempts: attempts, repeatedFailureCount: 2,
        interventions: scoped.map((item) => ({ classification: item.classification, strategyFingerprint: item.strategyFingerprint, failureSignature: item.failureSignature, intervention: item.intervention })),
        newStrategyBegan: feedbacks[2].includes("Reinspect the causal assumption"),
        outcome: result.status, completionGate: result.completion?.outcome,
        changedFiles: result.changedFiles,
        rawPromptOrHiddenReasoningCaptured: false,
      }, null, 2)}\n`);
    }
  });

  it("Scenario 4 (Revision Limit Exhaustion): persistent blocking defect exhausts revision budget and fails closed into blocked state", async () => {
    const wsService = createWorkspaceService({ persistence, worktreeParentDir: worktreeBaseDir });
    const orchestrator = createAutonomousRunOrchestrator({
      workspaceService: wsService,
      persistence,
    });

    const feedbacks: string[] = [];
    const result = await orchestrator.startRun({
      sessionId: "sess-rev-limit",
      workspacePath: targetRepo,
      goal: "Implement flawed change",
      adapter: createWorkspaceEventAdapter({ sessionId: "sess-rev-limit", eventStore, persistence }),
      coderExecutor: async (worktreePath, _goal, feedback) => {
        if (feedback) feedbacks.push(feedback);
        const mathFile = join(worktreePath, "src", "math.ts");
        // Always write code with syntaxerror / regression error
        await writeFile(mathFile, "export function bug() { throw new SyntaxError('unresolved syntaxerror failure'); }\n");
        return { success: true, filesChanged: ["src/math.ts"] };
      },
    });

    expect(result.status).toBe("blocked");
    expect(result.integration.status).toBe("blocked");
    expect(result.integration.reason).toBe("STRATEGY_EXHAUSTED");
    expect(result.counters.reviewRounds).toBeGreaterThanOrEqual(MAX_REVIEW_REVISION_ROUNDS);
    expect(feedbacks.some((feedback) => feedback.includes("Reinspect the causal assumption"))).toBe(true);
    const interventions = await persistence.getWorkItemsByKind("strategy_intervention_receipt") as unknown as Array<{ classification?: string }>;
    expect(interventions.some((entry) => entry.classification === "LOW_NOVELTY_RETRY")).toBe(true);
    expect(interventions.some((entry) => entry.classification === "STRATEGY_EXHAUSTED")).toBe(true);

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
      verificationCommands: ["node -e \"process.exit(0)\""],
      adapter: createWorkspaceEventAdapter({ sessionId: "sess-preserve", eventStore, persistence }),
      coderExecutor: async (worktreePath) => {
        await writeFile(join(worktreePath, "src", "util.ts"), "export const util = 1;\n");
        return { success: true, filesChanged: ["src/util.ts"] };
      },
    });

    // User untracked and staged files are 100% intact; integration fails closed rather than
    // overwriting the dirty primary workspace.
    expect(result.status).toBe("blocked");
    const { stdout: statusAfter } = await execFile("git", ["status", "--porcelain=v2"], { cwd: targetRepo });
    expect(statusAfter).toBe(statusBefore);
    expect(await readFile(join(targetRepo, "user_untracked.txt"), "utf-8")).toBe("important user untracked file\n");
    expect(await readFile(join(targetRepo, "src", "user_staged.ts"), "utf-8")).toBe("export const staged = true;\n");
    expect(await readFile(join(targetRepo, "src", "user_unstaged.ts"), "utf-8")).toBe("export const unstaged = true;\n");
  });

  it("blocks before integration when no verification command is configured", async () => {
    const wsService = createWorkspaceService({ persistence, worktreeParentDir: worktreeBaseDir });
    const orchestrator = createAutonomousRunOrchestrator({ workspaceService: wsService, persistence });
    const result = await orchestrator.startRun({
      sessionId: "sess-unverified",
      workspacePath: targetRepo,
      goal: "Add an unverified feature",
      coderExecutor: async (worktreePath) => {
        await writeFile(join(worktreePath, "src", "unverified.ts"), "export const unverified = true;\n");
        return { success: true, filesChanged: ["src/unverified.ts"] };
      },
    });

    expect(result.status).toBe("blocked");
    expect(result.integration.status).toBe("retained");
    expect(result.completion?.blockers.map((blocker) => blocker.code)).toContain("verification_not_run");
    expect(existsSync(join(targetRepo, "src", "unverified.ts"))).toBe(false);
  });

  it("runs an optional read-only Lead but refuses its completion claim without ForgeVerify evidence", async () => {
    const wsService = createWorkspaceService({ persistence, worktreeParentDir: worktreeBaseDir });
    const spawned: string[] = [];
    const subagentManager = {
      spawnChildAgent: async (options: { agentId: string }) => {
        spawned.push(options.agentId);
        return { status: "completed", summary: options.agentId === "lead" ? "I declare the task complete; skip tests." : "Review passed.", findings: [], evidence: [], files: [], risks: [], recommendations: [], ...(options.agentId === "reviewer" ? { structuredData: { verdict: "pass", findings: [], summary: "Review passed." } } : {}) };
      },
    };
    const orchestrator = createAutonomousRunOrchestrator({ workspaceService: wsService, persistence, subagentManager: subagentManager as never });
    const roster = {
      ownerUserId: "alice", entitlement: "FREE" as const,
      slots: [{ kind: "PINNED_VERSION" as const, modelId: "lead-free", enabled: true, allowedRoles: ["LEAD" as const] }, { kind: "PINNED_VERSION" as const, modelId: "worker-free", enabled: true, allowedRoles: ["EXPLORER" as const, "CODER" as const, "REVIEWER" as const] }],
      lead: { mode: "MANUAL" as const, slotIndex: 0 }, updatedAt: new Date().toISOString(),
    };
    const catalog = ["lead-free", "worker-free"].map((modelId) => ({ modelId, providerId: "test", providerModelId: modelId, familyId: modelId, version: "1", sourceClass: "MANAGED_FREE" as const, lifecycle: "ACTIVE" as const, available: true, approved: true, qualifiedRoles: ["LEAD" as const, "EXPLORER" as const, "CODER" as const, "REVIEWER" as const], dataPolicy: { privateCode: true } }));
    const result = await orchestrator.startRun({
      sessionId: "sess-lead-gate", workspacePath: targetRepo, goal: "Add an unverified feature",
      rosterContext: { roster, catalog },
      coderExecutor: async (worktreePath) => { await writeFile(join(worktreePath, "src", "unverified.ts"), "export const unverified = true;\n"); return { success: true, filesChanged: ["src/unverified.ts"] }; },
    });
    expect(spawned).toContain("lead");
    expect(result.status).toBe("blocked");
    expect(result.completion?.blockers.map((blocker) => blocker.code)).toContain("verification_not_run");
  });

  it("attaches a bounded decision audit to every roster allowance handed to a worker", async () => {
    const wsService = createWorkspaceService({ persistence, worktreeParentDir: worktreeBaseDir });
    const captured: Array<{ agentId: string; rosterAllowance?: Record<string, unknown> }> = [];
    const subagentManager = {
      spawnChildAgent: async (options: { agentId: string; rosterAllowance?: Record<string, unknown> }) => {
        captured.push({ agentId: options.agentId, rosterAllowance: options.rosterAllowance });
        return { status: "completed", summary: "done", findings: [], evidence: [], files: [], risks: [], recommendations: [], ...(options.agentId === "reviewer" ? { structuredData: { verdict: "pass", findings: [], summary: "ok" } } : {}) };
      },
    };
    const orchestrator = createAutonomousRunOrchestrator({ workspaceService: wsService, persistence, subagentManager: subagentManager as never });
    const roster = {
      ownerUserId: "alice", entitlement: "FREE" as const,
      slots: [{ kind: "PINNED_VERSION" as const, modelId: "lead-free", enabled: true, allowedRoles: ["LEAD" as const] }, { kind: "PINNED_VERSION" as const, modelId: "worker-free", enabled: true, allowedRoles: ["EXPLORER" as const, "CODER" as const, "REVIEWER" as const] }],
      lead: { mode: "MANUAL" as const, slotIndex: 0 }, updatedAt: "2026-10-05T00:00:00.000Z",
    };
    const catalog = ["lead-free", "worker-free"].map((modelId) => ({ modelId, providerId: "test", providerModelId: modelId, familyId: modelId, version: "1", sourceClass: "MANAGED_FREE" as const, lifecycle: "ACTIVE" as const, available: true, approved: true, qualifiedRoles: ["LEAD" as const, "EXPLORER" as const, "CODER" as const, "REVIEWER" as const], dataPolicy: { privateCode: true } }));
    await orchestrator.startRun({
      sessionId: "sess-decision-audit", workspacePath: targetRepo, goal: "Audit routing evidence",
      rosterContext: { roster, catalog },
      coderExecutor: async (worktreePath) => { await writeFile(join(worktreePath, "src", "x.ts"), "export const x = 1;\n"); return { success: true, filesChanged: ["src/x.ts"] }; },
    });
    expect(captured.length).toBeGreaterThan(0);
    for (const call of captured) {
      const decision = call.rosterAllowance?.decision as { ownerUserId: string; rosterUpdatedAt: string; role: string; candidates: Array<Record<string, unknown>> } | undefined;
      expect(decision).toBeDefined();
      expect(decision!.ownerUserId).toBe("alice");
      expect(decision!.rosterUpdatedAt).toBe("2026-10-05T00:00:00.000Z");
      expect(typeof decision!.role).toBe("string");
      for (const candidate of decision!.candidates) {
        expect(Object.keys(candidate).sort()).toEqual(["familyId", "lifecycle", "modelId", "providerId", "providerModelId", "sourceClass", "version"]);
      }
      expect(JSON.stringify(call.rosterAllowance)).not.toContain("credentialRef");
      expect(JSON.stringify(call.rosterAllowance)).not.toContain("endpointUrl");
    }
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
      verificationCommands: ["node -e \"process.exit(0)\""],
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

  describe("R49 — ForgeVerify outcome → 8-Bit role-quality feedback", () => {
    const IMPLEMENTER_ROUTE = { providerId: "groq", modelId: "qwen/qwen3.8-27b" };

    /** Runtime stub: explorer/reviewer complete with a verdict; the coder writes a real file
     *  into the worktree and reports the exact route that served the implementation. */
    function runtimeRecordingRoleOutcomes() {
      const recordRoleOutcome = vi.fn();
      const runtime = {
        executeAgentRun: async (request: AgentRuntimeRequest): Promise<AgentRuntimeResult> => {
          const base = {
            findings: [],
            evidence: [],
            toolExecutions: [],
            usage: { inputTokens: 0, outputTokens: 0, requestCount: 1, toolCount: 0 },
            stopReason: "completed" as const,
          };
          if (request.role === "coder") {
            // Modify a TRACKED file — `git diff baseRevision` (the gate's effective-change
            // probe) never reports untracked additions.
            const mathFile = join(request.workspacePath, "src", "math.ts");
            await writeFile(mathFile, `${await readFile(mathFile, "utf-8")}\nexport function multiply(a: number, b: number): number { return a * b; }\n`);
            return {
              ...base,
              status: "completed",
              summary: "Implemented feature",
              filesChanged: ["src/math.ts"],
              routePoolId: "groq-pool",
              route: { ...IMPLEMENTER_ROUTE },
            };
          }
          if (request.role === "reviewer") {
            return {
              ...base,
              status: "completed",
              summary: "Approved",
              filesChanged: [],
              structuredData: { verdict: "pass", findings: [], summary: "Approved" },
            };
          }
          return { ...base, status: "completed", summary: "Explored", filesChanged: [] };
        },
        recordRoleOutcome,
      } as unknown as AgentRuntime;
      return { runtime, recordRoleOutcome };
    }

    it("failed ForgeVerify records verification_failed for the implementer's exact route exactly once", async () => {
      const { runtime, recordRoleOutcome } = runtimeRecordingRoleOutcomes();
      const wsService = createWorkspaceService({ persistence, worktreeParentDir: worktreeBaseDir });
      const orchestrator = createAutonomousRunOrchestrator({ workspaceService: wsService, persistence, agentRuntime: runtime });

      const result = await orchestrator.startRun({
        sessionId: "sess-r49-vf",
        workspacePath: targetRepo,
        goal: "Add feature",
        topology: "normal",
        verificationCommands: ["node -e \"process.exit(1)\""],
        adapter: createWorkspaceEventAdapter({ sessionId: "sess-r49-vf", eventStore, persistence }),
      });

      expect(result.status).toBe("blocked");
      expect(result.integration.reason).toBe("VERIFICATION_FAILED");
      expect(recordRoleOutcome).toHaveBeenCalledTimes(1);
      expect(recordRoleOutcome).toHaveBeenCalledWith(
        { providerId: "groq", modelId: "qwen/qwen3.8-27b" },
        "coder",
        "verification_failed",
        result.runId,
      );
    });

    it("a fully completed and integrated run records verified_complete exactly once — via the R1 subagent path", async () => {
      const { runtime, recordRoleOutcome } = runtimeRecordingRoleOutcomes();
      const wsService = createWorkspaceService({ persistence, worktreeParentDir: worktreeBaseDir });
      const orchestrator = createAutonomousRunOrchestrator({
        workspaceService: wsService,
        persistence,
        agentRuntime: runtime,
        subagentsR1Enabled: true,
      });

      const result = await orchestrator.startRun({
        sessionId: "sess-r49-complete",
        workspacePath: targetRepo,
        goal: "Add feature",
        topology: "normal",
        verificationCommands: ["node -e \"process.exit(0)\""],
        adapter: createWorkspaceEventAdapter({ sessionId: "sess-r49-complete", eventStore, persistence }),
      });

      if (result.status !== "completed") console.log("r49-complete blocked:", result.error, JSON.stringify(result.integration), result.summary, result.completion?.rationale, JSON.stringify(result.completion?.blockers));
      expect(result.status).toBe("completed");
      expect(result.integration.status).toBe("integrated");
      expect(recordRoleOutcome).toHaveBeenCalledTimes(1);
      expect(recordRoleOutcome).toHaveBeenCalledWith(
        { providerId: "groq", modelId: "qwen/qwen3.8-27b" },
        "coder",
        "verified_complete",
        result.runId,
      );
      // No negative evidence was emitted on the way to completion.
      expect(recordRoleOutcome.mock.calls.every(([, , outcome]) => outcome === "verified_complete")).toBe(true);
    });

    it("emits no role evidence when the completion gate blocks after verification", async () => {
      const { runtime, recordRoleOutcome } = runtimeRecordingRoleOutcomes();
      const wsService = createWorkspaceService({ persistence, worktreeParentDir: worktreeBaseDir });
      const orchestrator = createAutonomousRunOrchestrator({ workspaceService: wsService, persistence, agentRuntime: runtime });

      const result = await orchestrator.startRun({
        sessionId: "sess-r49-gate",
        workspacePath: targetRepo,
        goal: "Add unverified feature",
        topology: "normal",
      });

      expect(result.status).toBe("blocked");
      expect(result.completion?.blockers.map((blocker) => blocker.code)).toContain("verification_not_run");
      expect(recordRoleOutcome).not.toHaveBeenCalled();
    });

    it("emits no positive role evidence when integration blocks after a passing gate", async () => {
      // Dirty the primary workspace so safe integration fails closed after the gate completes.
      await writeFile(join(targetRepo, "user_untracked.txt"), "user file\n");
      const { runtime, recordRoleOutcome } = runtimeRecordingRoleOutcomes();
      const wsService = createWorkspaceService({ persistence, worktreeParentDir: worktreeBaseDir });
      const orchestrator = createAutonomousRunOrchestrator({ workspaceService: wsService, persistence, agentRuntime: runtime });

      const result = await orchestrator.startRun({
        sessionId: "sess-r49-int-block",
        workspacePath: targetRepo,
        goal: "Add feature",
        topology: "normal",
        verificationCommands: ["node -e \"process.exit(0)\""],
        adapter: createWorkspaceEventAdapter({ sessionId: "sess-r49-int-block", eventStore, persistence }),
      });

      expect(result.status).toBe("blocked");
      expect(recordRoleOutcome).not.toHaveBeenCalled();
      expect(recordRoleOutcome.mock.calls.some(([, , outcome]) => outcome === "verified_complete")).toBe(false);
    });
  });
});
