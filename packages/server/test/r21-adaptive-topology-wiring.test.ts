import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, readFile, rm, mkdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { createAutonomousRunOrchestrator, MAX_REVIEW_REVISION_ROUNDS, type AutonomousRunResult } from "../src/autonomous-orchestrator.js";
import { createWorkspaceService } from "../src/workspace-service.js";
import type { SubagentManager } from "../src/subagent-manager.js";
import { createWorkspaceEventAdapter } from "../src/workspace-event-adapter.js";
import { EventStore, createSessionPersistence } from "@codeforge/sessions";

const execFile = promisify(execFileCallback);

/**
 * R21 adaptive topology wiring. Before R21 the autonomous orchestrator always ran the fixed team
 * (explorers → planner → coder → reviewer) regardless of the task; `resolveAdaptiveTopology`
 * existed but had no production caller, and the deterministic diff review (sensitive files,
 * verification-config edits) ran only in the single-agent WorkflowEngine. Now:
 *   - the smallest useful team is chosen deterministically and recorded on the run;
 *   - the deterministic review runs on every topology, model-free;
 *   - ForgeVerify and the completion gate remain mandatory everywhere;
 *   - the certified R1 baseline stays reachable by explicit request or CODEFORGE_TOPOLOGY_POLICY.
 */
describe("R21 adaptive topology wiring in the autonomous orchestrator", () => {
  let targetRepo: string;
  let worktreeBaseDir: string;
  let dbDir: string;
  let eventStore: EventStore;
  let persistence: ReturnType<typeof createSessionPersistence>;
  const spawned: string[] = [];

  beforeEach(async () => {
    targetRepo = await mkdtemp(join(tmpdir(), "r21-topo-target-"));
    worktreeBaseDir = await mkdtemp(join(tmpdir(), "r21-topo-worktrees-"));
    dbDir = await mkdtemp(join(tmpdir(), "r21-topo-db-"));
    eventStore = new EventStore();
    persistence = createSessionPersistence({ dbPath: join(dbDir, "sessions.db") });
    spawned.length = 0;
    await execFile("git", ["init"], { cwd: targetRepo });
    for (const [key, value] of [["user.name", "R21"], ["user.email", "r21@codeforge.test"], ["commit.gpgsign", "false"], ["core.autocrlf", "false"]]) await execFile("git", ["config", key!, value!], { cwd: targetRepo });
    await writeFile(join(targetRepo, "package.json"), JSON.stringify({ name: "demo", version: "1.0.0", type: "module", scripts: { test: "node -e \"process.exit(0)\"" } }, null, 2));
    await mkdir(join(targetRepo, "src"), { recursive: true });
    await writeFile(join(targetRepo, "src", "math.ts"), "export function add(a: number, b: number): number { return a + b; }\n");
    await writeFile(join(targetRepo, "README.md"), "# demo\n\nThis is a demo with a tpyo.\n");
    await execFile("git", ["add", "."], { cwd: targetRepo });
    await execFile("git", ["commit", "-m", "initial"], { cwd: targetRepo });
    delete process.env.CODEFORGE_TOPOLOGY_POLICY;
  });

  afterEach(async () => {
    persistence.close();
    delete process.env.CODEFORGE_TOPOLOGY_POLICY;
    for (const dir of [targetRepo, worktreeBaseDir, dbDir]) await rm(dir, { recursive: true, force: true });
  });

  /** Records every child spawn; explorer/reviewer results are benign stubs. */
  function countingManager(): SubagentManager {
    return {
      spawnChildAgent: async (options: { agentId: string }) => {
        spawned.push(options.agentId);
        if (options.agentId === "reviewer") return { status: "completed", summary: "pass", findings: [], evidence: [], files: [], risks: [], recommendations: [], structuredData: { verdict: "pass", summary: "pass", findings: [] } };
        return { status: "completed", summary: `${options.agentId} done`, findings: [], evidence: [], files: [], risks: [], recommendations: [] };
      },
      cancelParent: () => undefined,
    } as unknown as SubagentManager;
  }

  async function run(goal: string, extra: Record<string, unknown> = {}, coder?: (worktreePath: string, goal: string, feedback?: string) => Promise<{ success: boolean; filesChanged: string[] }>): Promise<AutonomousRunResult> {
    const orchestrator = createAutonomousRunOrchestrator({ workspaceService: createWorkspaceService({ persistence, worktreeParentDir: worktreeBaseDir }), persistence, subagentManager: countingManager() });
    return orchestrator.startRun({
      sessionId: `sess-${Math.random().toString(16).slice(2)}`,
      workspacePath: targetRepo,
      goal,
      verificationCommands: ["node -e \"process.exit(0)\""],
      adapter: createWorkspaceEventAdapter({ sessionId: "sess-topo", eventStore, persistence }),
      coderExecutor: coder ?? (async (worktreePath) => {
        const file = join(worktreePath, "src", "math.ts");
        await writeFile(file, `${await readFile(file, "utf-8")}\nexport function multiply(a: number, b: number): number { return a * b; }\n`);
        return { success: true, filesChanged: ["src/math.ts"] };
      }),
      ...extra,
    });
  }

  it("tiny goal → coder + ForgeVerify only: no explorer, no planner, no independent reviewer; still completes through the gate", async () => {
    const result = await run("Fix the typo in README.md", {}, async (worktreePath) => {
      await writeFile(join(worktreePath, "README.md"), "# demo\n\nThis is a demo with a typo.\n");
      return { success: true, filesChanged: ["README.md"] };
    });
    expect(result.status).toBe("completed");
    expect(result.topology?.policy).toBe("adaptive");
    expect(result.topology?.complexity.tier).toBe("tiny");
    expect(result.topology?.plan.topology).toBe("tiny");
    expect(result.topology?.plan.requiresForgeVerify).toBe(true);
    expect(spawned).toEqual([]);
    expect(result.counters.childrenSpawned).toBe(0);
    expect(result.verification.length).toBeGreaterThan(0);
    expect(result.completion?.outcome).toBe("completed");
  });

  it("normal goal → one explorer + coder + independent reviewer", async () => {
    const result = await run("Add a multiply function to the math module and cover it with a test");
    expect(result.status).toBe("completed");
    expect(result.topology?.plan.topology).toBe("normal");
    expect(spawned).toEqual(["explorer", "reviewer"]);
  });

  it("complex goal → two explorers (+ planner when a runtime exists) + reviewer", async () => {
    const result = await run("Migrate the database from SQLite to PostgreSQL across the api and the frontend");
    expect(result.status).toBe("completed");
    expect(result.topology?.plan.topology).toBe("complex");
    expect(spawned.filter((id) => id === "explorer")).toHaveLength(2);
    expect(spawned).toContain("reviewer");
  });

  it("explicit topology request wins over the classifier and is recorded as such", async () => {
    const result = await run("Fix the typo in README.md", { topology: "fixed_r1" });
    expect(result.topology?.policy).toBe("explicit");
    expect(result.topology?.plan.topology).toBe("fixed_r1");
    expect(spawned.filter((id) => id === "explorer")).toHaveLength(2);
    expect(spawned).toContain("reviewer");
  });

  it("CODEFORGE_TOPOLOGY_POLICY=fixed_r1 restores the certified R1 baseline for every goal", async () => {
    process.env.CODEFORGE_TOPOLOGY_POLICY = "fixed_r1";
    const result = await run("Fix the typo in README.md");
    expect(result.topology?.policy).toBe("fixed_r1_env");
    expect(result.topology?.plan.topology).toBe("fixed_r1");
    expect(spawned.filter((id) => id === "explorer")).toHaveLength(2);
  });

  it("an explicit complexity hint steers the classifier", async () => {
    const result = await run("Fix the typo in README.md", { complexityHint: "normal" });
    expect(result.topology?.complexity.reasonCodes).toEqual(["EXPLICIT_HINT"]);
    expect(result.topology?.plan.topology).toBe("normal");
  });

  it("deterministic diff review runs even without an independent reviewer: a .env edit is a blocking finding that drives revision", async () => {
    let round = 0;
    const result = await run("Fix the typo in README.md", {}, async (worktreePath) => {
      round += 1;
      await writeFile(join(worktreePath, "README.md"), "# demo\n\nThis is a demo with a typo.\n");
      if (round === 1) await writeFile(join(worktreePath, ".env"), "API_KEY=leaked\n");
      else await unlink(join(worktreePath, ".env")).catch(() => undefined);
      return { success: true, filesChanged: ["README.md"] };
    });
    expect(spawned).toEqual([]);
    expect(round).toBe(2);
    expect(result.counters.reviewRounds).toBe(1);
    expect(result.status).toBe("completed");
  });

  it("deterministic review blocks a run that keeps rewriting its own verification script", async () => {
    const result = await run("Fix the typo in README.md", {}, async (worktreePath) => {
      await writeFile(join(worktreePath, "README.md"), "# demo\n\nThis is a demo with a typo.\n");
      await writeFile(join(worktreePath, "package.json"), JSON.stringify({ name: "demo", version: "1.0.0", type: "module", scripts: { test: "echo ok" } }, null, 2));
      return { success: true, filesChanged: ["README.md", "package.json"] };
    });
    expect(result.status).toBe("blocked");
    expect(result.integration.status).not.toBe("integrated");
    expect(result.counters.reviewRounds).toBe(MAX_REVIEW_REVISION_ROUNDS + 1);
    expect(result.review.findings.some((finding) => finding.category === "verification_config_modified")).toBe(true);
  });
});
