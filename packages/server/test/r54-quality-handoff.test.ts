import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile as callbackExecFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createSessionPersistence } from "@codeforge/sessions";
import { createAutonomousRunOrchestrator } from "../src/autonomous-orchestrator.js";
import { createWorkspaceService } from "../src/workspace-service.js";
import type { SubagentManager, SpawnChildOptions } from "../src/subagent-manager.js";

const execFile = promisify(callbackExecFile);

describe("R54 quality-driven Coder handoff", () => {
  let repo: string;
  let worktrees: string;
  let persistence: ReturnType<typeof createSessionPersistence>;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "r54-handoff-repo-"));
    worktrees = await mkdtemp(join(tmpdir(), "r54-handoff-wt-"));
    persistence = createSessionPersistence({ dbPath: ":memory:" });
    await execFile("git", ["init"], { cwd: repo });
    for (const [key, value] of [["user.name", "R54"], ["user.email", "r54@codeforge.test"], ["commit.gpgsign", "false"], ["core.autocrlf", "false"]]) {
      await execFile("git", ["config", key!, value!], { cwd: repo });
    }
    await mkdir(join(repo, "src"));
    await mkdir(join(repo, "test"));
    await writeFile(join(repo, "package.json"), '{"name":"handoff","type":"module"}\n');
    await writeFile(join(repo, "src", "math.mjs"), "export const base = 1;\n");
    await writeFile(join(repo, "test", "integration.test.mjs"), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { partial, finish } from '../src/math.mjs';\ntest('preserved and finished', () => { assert.equal(partial(), 2); assert.equal(finish(), 3); });\n");
    await execFile("git", ["add", "."], { cwd: repo });
    await execFile("git", ["commit", "-m", "base"], { cwd: repo });
  });

  afterEach(async () => {
    persistence.close();
    await rm(repo, { recursive: true, force: true });
    await rm(worktrees, { recursive: true, force: true });
  });

  it("keeps the first edit, excludes its healthy but stalled route, and completes through verification", async () => {
    const coderRoutes: Array<SpawnChildOptions["excludeRoleRoute"]> = [];
    let secondSawPartial = false;
    const manager = {
      spawnChildAgent: async (options: SpawnChildOptions) => {
        if (options.agentId === "explorer") return { status: "completed", summary: "explored", findings: [], evidence: [], files: [], risks: [], recommendations: [] };
        if (options.agentId === "reviewer") return { status: "completed", summary: "pass", findings: [], evidence: [], files: [], risks: [], recommendations: [], structuredData: { verdict: "pass", summary: "pass", findings: [] } };
        coderRoutes.push(options.excludeRoleRoute);
        const file = join(options.workspacePath, "src", "math.mjs");
        if (coderRoutes.length === 1) {
          await writeFile(file, "export const base = 1;\nexport function partial() { return 2; }\n");
          return { status: "blocked", summary: "[AGENT_NO_PROGRESS_DETECTED] repeated unchanged evidence", findings: [], evidence: [], files: ["src/math.mjs"], risks: [], recommendations: [], route: { providerId: "groq", modelId: "coder-a" }, routePoolId: "managed:groq:a" };
        }
        secondSawPartial = (await readFile(file, "utf8")).includes("function partial()");
        await writeFile(file, `${await readFile(file, "utf8")}export function finish() { return 3; }\n`);
        return { status: "completed", summary: "implemented", findings: [], evidence: [], files: ["src/math.mjs"], risks: [], recommendations: [], route: { providerId: "openrouter", modelId: "coder-b" }, routePoolId: "managed:openrouter:b" };
      },
      cancelParent: () => undefined,
    } as unknown as SubagentManager;
    const orchestrator = createAutonomousRunOrchestrator({
      workspaceService: createWorkspaceService({ persistence, worktreeParentDir: worktrees }),
      persistence,
      subagentManager: manager,
      subagentsR1Enabled: true,
    });
    const result = await orchestrator.startRun({ sessionId: "r54-handoff", workspacePath: repo, goal: "Implement partial and finish in the math module with tests", verificationCommands: ["node --test test/integration.test.mjs"] });
    expect(result.status).toBe("completed");
    expect(result.completion?.outcome).toBe("completed");
    expect(secondSawPartial).toBe(true);
    expect(coderRoutes).toEqual([undefined, { providerId: "groq", modelId: "coder-a" }]);
    expect((await readFile(join(repo, "src", "math.mjs"), "utf8"))).toContain("function partial()");
    const handoffs = await persistence.getWorkItemsByKind("role_quality_handoff");
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]).toMatchObject({ reason: "QUALITY_DRIVEN_ROLE_SWITCH", oldOwner: { providerId: "groq", modelId: "coder-a" }, newOwner: { providerId: "openrouter", modelId: "coder-b" }, changedFiles: ["src/math.mjs"] });
  });

  it("does not switch on a provider-capacity failure", async () => {
    let coderCalls = 0;
    const manager = {
      spawnChildAgent: async (options: SpawnChildOptions) => {
        if (options.agentId === "explorer") return { status: "completed", summary: "explored", findings: [], evidence: [], files: [], risks: [], recommendations: [] };
        if (options.agentId === "coder") {
          coderCalls++;
          return { status: "blocked", summary: "[RATE_LIMITED] provider 429", findings: [], evidence: [], files: [], risks: [], recommendations: [], route: { providerId: "groq", modelId: "coder-a" }, routePoolId: "managed:groq:a" };
        }
        throw new Error("Reviewer must not run");
      },
      cancelParent: () => undefined,
    } as unknown as SubagentManager;
    const orchestrator = createAutonomousRunOrchestrator({ workspaceService: createWorkspaceService({ persistence, worktreeParentDir: worktrees }), persistence, subagentManager: manager, subagentsR1Enabled: true });
    const result = await orchestrator.startRun({ sessionId: "r54-capacity", workspacePath: repo, goal: "Implement partial and finish in the math module with tests", verificationCommands: ["node --test test/integration.test.mjs"] });
    expect(result.status).toBe("blocked");
    expect(coderCalls).toBe(1);
    expect(await persistence.getWorkItemsByKind("role_quality_handoff")).toHaveLength(0);
  });

  it("requires a replacement semantic verdict when the first Reviewer has none", async () => {
    const reviewerRoutes: Array<SpawnChildOptions["excludeRoleRoute"]> = [];
    const manager = {
      spawnChildAgent: async (options: SpawnChildOptions) => {
        if (options.agentId === "explorer") return { status: "completed", summary: "explored", findings: [], evidence: [], files: [], risks: [], recommendations: [] };
        if (options.agentId === "coder") {
          await writeFile(join(options.workspacePath, "src", "math.mjs"), "export function partial() { return 2; }\nexport function finish() { return 3; }\n");
          return { status: "completed", summary: "implemented", findings: [], evidence: [], files: ["src/math.mjs"], risks: [], recommendations: [], route: { providerId: "groq", modelId: "coder" }, routePoolId: "managed:groq:coder" };
        }
        reviewerRoutes.push(options.excludeRoleRoute);
        if (reviewerRoutes.length === 1) return { status: "blocked", summary: "[AGENT_MODEL_TURN_LIMIT] no verdict", findings: [], evidence: [], files: [], risks: [], recommendations: [], route: { providerId: "openrouter", modelId: "reviewer-a" }, routePoolId: "managed:openrouter:a" };
        return { status: "completed", summary: "pass", findings: [], evidence: [], files: [], risks: [], recommendations: [], structuredData: { verdict: "pass", summary: "pass", findings: [] }, route: { providerId: "mistral", modelId: "reviewer-b" }, routePoolId: "managed:mistral:b" };
      },
      cancelParent: () => undefined,
    } as unknown as SubagentManager;
    const orchestrator = createAutonomousRunOrchestrator({ workspaceService: createWorkspaceService({ persistence, worktreeParentDir: worktrees }), persistence, subagentManager: manager, subagentsR1Enabled: true });
    const result = await orchestrator.startRun({ sessionId: "r54-semantic", workspacePath: repo, goal: "Implement partial and finish in the math module with tests", verificationCommands: ["node --test test/integration.test.mjs"] });
    expect(result.status).toBe("completed");
    expect(result.completion?.outcome).toBe("completed");
    expect(reviewerRoutes).toEqual([undefined, { providerId: "openrouter", modelId: "reviewer-a" }]);
    expect(await persistence.getWorkItemsByKind("semantic_verifier_handoff")).toMatchObject([{ oldOwner: { providerId: "openrouter", modelId: "reviewer-a" }, newOwner: { providerId: "mistral", modelId: "reviewer-b" }, priorVerdict: "NONE" }]);
  });

  it("blocks when the alternate Reviewer also has no valid verdict", async () => {
    let reviewerCalls = 0;
    const manager = {
      spawnChildAgent: async (options: SpawnChildOptions) => {
        if (options.agentId === "explorer") return { status: "completed", summary: "explored", findings: [], evidence: [], files: [], risks: [], recommendations: [] };
        if (options.agentId === "coder") {
          await writeFile(join(options.workspacePath, "src", "math.mjs"), "export function partial() { return 2; }\nexport function finish() { return 3; }\n");
          return { status: "completed", summary: "implemented", findings: [], evidence: [], files: ["src/math.mjs"], risks: [], recommendations: [], route: { providerId: "groq", modelId: "coder" }, routePoolId: "managed:groq:coder" };
        }
        reviewerCalls++;
        return { status: "blocked", summary: "[AGENT_MODEL_TURN_LIMIT] no verdict", findings: [], evidence: [], files: [], risks: [], recommendations: [], ...(reviewerCalls === 1 ? { route: { providerId: "openrouter", modelId: "reviewer-a" }, routePoolId: "managed:openrouter:a" } : {}) };
      },
      cancelParent: () => undefined,
    } as unknown as SubagentManager;
    const orchestrator = createAutonomousRunOrchestrator({ workspaceService: createWorkspaceService({ persistence, worktreeParentDir: worktrees }), persistence, subagentManager: manager, subagentsR1Enabled: true });
    const result = await orchestrator.startRun({ sessionId: "r54-no-alternate", workspacePath: repo, goal: "Implement partial and finish in the math module with tests", verificationCommands: ["node --test test/integration.test.mjs"] });
    expect(result.status).toBe("blocked");
    expect(result.completion?.outcome).not.toBe("completed");
    expect(reviewerCalls).toBe(2);
  });
});
