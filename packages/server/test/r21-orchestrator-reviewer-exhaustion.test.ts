import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { createAutonomousRunOrchestrator } from "../src/autonomous-orchestrator.js";
import { createWorkspaceService } from "../src/workspace-service.js";
import type { SubagentManager } from "../src/subagent-manager.js";
import { createWorkspaceEventAdapter } from "../src/workspace-event-adapter.js";
import { EventStore, createSessionPersistence } from "@codeforge/sessions";

const execFile = promisify(execFileCallback);

/**
 * R21: a reviewer that ran out of turns (blocked, no verdict) must never pass the review by
 * silence. Before R21 the agent runtime reported such a reviewer as `completed` with no findings,
 * and the orchestrator read "no blocking findings" as approval.
 */
describe("R21 orchestrator — an exhausted reviewer is not approval", () => {
  let targetRepo: string;
  let worktreeBaseDir: string;
  let dbDir: string;
  let eventStore: EventStore;
  let persistence: ReturnType<typeof createSessionPersistence>;

  beforeEach(async () => {
    targetRepo = await mkdtemp(join(tmpdir(), "r21-orch-target-"));
    worktreeBaseDir = await mkdtemp(join(tmpdir(), "r21-orch-worktrees-"));
    dbDir = await mkdtemp(join(tmpdir(), "r21-orch-db-"));
    eventStore = new EventStore();
    persistence = createSessionPersistence({ dbPath: join(dbDir, "sessions.db") });
    await execFile("git", ["init"], { cwd: targetRepo });
    for (const [key, value] of [["user.name", "R21"], ["user.email", "r21@codeforge.test"], ["commit.gpgsign", "false"], ["core.autocrlf", "false"]]) await execFile("git", ["config", key!, value!], { cwd: targetRepo });
    await writeFile(join(targetRepo, "package.json"), JSON.stringify({ name: "demo", version: "1.0.0", type: "module" }, null, 2));
    await mkdir(join(targetRepo, "src"), { recursive: true });
    await writeFile(join(targetRepo, "src", "math.ts"), "export function add(a: number, b: number): number { return a + b; }\n");
    await execFile("git", ["add", "."], { cwd: targetRepo });
    await execFile("git", ["commit", "-m", "initial"], { cwd: targetRepo });
  });

  afterEach(async () => {
    persistence.close();
    for (const dir of [targetRepo, worktreeBaseDir, dbDir]) await rm(dir, { recursive: true, force: true });
  });

  function managerWithReviewer(reviewer: () => Promise<Record<string, unknown>>): SubagentManager {
    const stub = {
      spawnChildAgent: async (options: { agentId: string }) => {
        if (options.agentId === "reviewer") return reviewer();
        return { status: "completed", summary: `${options.agentId} done`, findings: [], evidence: [], files: [], risks: [], recommendations: [] };
      },
      cancelParent: () => undefined,
    };
    return stub as unknown as SubagentManager;
  }

  it("blocks the run (REVIEWER_BUDGET_EXHAUSTED) and never integrates when the reviewer ran out of turns", async () => {
    const orchestrator = createAutonomousRunOrchestrator({
      workspaceService: createWorkspaceService({ persistence, worktreeParentDir: worktreeBaseDir }),
      persistence,
      subagentManager: managerWithReviewer(async () => ({ status: "blocked", summary: "[AGENT_MODEL_TURN_LIMIT] The reviewer agent used all 10 model turns without finishing.", findings: [], evidence: [], files: [], risks: ["Reviewer or budget blocker"], recommendations: ["Resolve blockers"], error: "AGENT_MODEL_TURN_LIMIT" })),
    });
    const result = await orchestrator.startRun({
      sessionId: "sess-r21-exhausted",
      workspacePath: targetRepo,
      goal: "Add multiply function to math.ts",
      verificationCommands: ["node -e \"process.exit(0)\""],
      adapter: createWorkspaceEventAdapter({ sessionId: "sess-r21-exhausted", eventStore, persistence }),
      coderExecutor: async (worktreePath) => {
        const file = join(worktreePath, "src", "math.ts");
        await writeFile(file, `${await readFile(file, "utf-8")}\nexport function multiply(a: number, b: number): number { return a * b; }\n`);
        return { success: true, filesChanged: ["src/math.ts"] };
      },
    });
    expect(result.status).toBe("blocked");
    expect(result.integration.status).not.toBe("integrated");
    expect(result.integration.reason).toBe("REVIEWER_BUDGET_EXHAUSTED");
    expect(result.review.passed).toBe(false);
    expect(await readFile(join(targetRepo, "src", "math.ts"), "utf-8")).not.toContain("multiply");
  });

  it("still lets a reviewer that delivered a revision_required verdict drive the revision loop", async () => {
    let rounds = 0;
    const orchestrator = createAutonomousRunOrchestrator({
      workspaceService: createWorkspaceService({ persistence, worktreeParentDir: worktreeBaseDir }),
      persistence,
      subagentManager: managerWithReviewer(async () => {
        rounds += 1;
        return rounds === 1
          ? { status: "blocked", summary: "revision required", findings: [{ id: "r1", severity: "blocking", category: "correctness", message: "needs a fix" }], evidence: [], files: [], risks: [], recommendations: [], structuredData: { verdict: "revision_required", summary: "revision required", findings: [{ id: "r1", severity: "blocking", category: "correctness", message: "needs a fix" }] } }
          : { status: "completed", summary: "pass", findings: [], evidence: [], files: [], risks: [], recommendations: [], structuredData: { verdict: "pass", summary: "pass", findings: [] } };
      }),
    });
    const result = await orchestrator.startRun({
      sessionId: "sess-r21-revision",
      workspacePath: targetRepo,
      goal: "Add multiply function to math.ts",
      verificationCommands: ["node -e \"process.exit(0)\""],
      adapter: createWorkspaceEventAdapter({ sessionId: "sess-r21-revision", eventStore, persistence }),
      coderExecutor: async (worktreePath) => {
        const file = join(worktreePath, "src", "math.ts");
        await writeFile(file, `${await readFile(file, "utf-8")}\nexport function multiply(a: number, b: number): number { return a * b; }\n`);
        return { success: true, filesChanged: ["src/math.ts"] };
      },
    });
    expect(rounds).toBe(2);
    expect(result.status).toBe("completed");
  });
});
