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

  it.each([
    ["groq", "managed:groq:a"],
    ["blockrun-free-direct", "blockrun-direct:egress"],
    ["public-anonymous", "public-ip:egress"],
  ])("keeps the first edit from %s, excludes its stalled route, and completes through verification", async (providerId, routePoolId) => {
    const coderRoutes: Array<SpawnChildOptions["excludeRoleRoute"]> = [];
    const coderContexts: Array<SpawnChildOptions["contextSummary"]> = [];
    let secondSawPartial = false;
    const manager = {
      spawnChildAgent: async (options: SpawnChildOptions) => {
        if (options.agentId === "explorer") return { status: "completed", summary: "explored", findings: [], evidence: [], files: [], risks: [], recommendations: [] };
        if (options.agentId === "reviewer") return { status: "completed", summary: "pass", findings: [], evidence: [], files: [], risks: [], recommendations: [], structuredData: { verdict: "pass", summary: "pass", findings: [] } };
        coderRoutes.push(options.excludeRoleRoute);
        coderContexts.push(options.contextSummary);
        const file = join(options.workspacePath, "src", "math.mjs");
        if (coderRoutes.length === 1) {
          await writeFile(file, "export const base = 1;\nexport function partial() { return 2; }\n");
          return { status: "blocked", summary: "[AGENT_NO_PROGRESS_DETECTED] repeated unchanged evidence", findings: [], evidence: [], files: ["src/math.mjs"], risks: [], recommendations: [], route: { providerId, modelId: "coder-a" }, routePoolId };
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
    expect(coderRoutes).toEqual([undefined, { providerId, modelId: "coder-a" }]);
    expect(coderContexts).toHaveLength(2);
    for (const context of coderContexts) {
      expect(context).toContain("network:false");
      expect(context).toContain("node --test test/integration.test.mjs");
    }
    expect(coderContexts[1]).toContain("same isolated worktree is preserved");
    expect((await readFile(join(repo, "src", "math.mjs"), "utf8"))).toContain("function partial()");
    const handoffs = await persistence.getWorkItemsByKind("role_quality_handoff");
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]).toMatchObject({ reason: "QUALITY_DRIVEN_ROLE_SWITCH", oldOwner: { providerId, modelId: "coder-a" }, newOwner: { providerId: "openrouter", modelId: "coder-b" }, changedFiles: ["src/math.mjs"] });
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

  it.each([
    ["openrouter", "managed:openrouter:a"],
    ["ai-horde", "shared:ai-horde"],
    ["kilo-free-direct", "kilo-direct:egress"],
    ["public-anonymous", "public-ip:egress"],
  ])("requires a replacement semantic verdict when %s has none", async (providerId, routePoolId) => {
    const reviewerRoutes: Array<SpawnChildOptions["excludeRoleRoute"]> = [];
    const manager = {
      spawnChildAgent: async (options: SpawnChildOptions) => {
        if (options.agentId === "explorer") return { status: "completed", summary: "explored", findings: [], evidence: [], files: [], risks: [], recommendations: [] };
        if (options.agentId === "coder") {
          await writeFile(join(options.workspacePath, "src", "math.mjs"), "export function partial() { return 2; }\nexport function finish() { return 3; }\n");
          return { status: "completed", summary: "implemented", findings: [], evidence: [], files: ["src/math.mjs"], risks: [], recommendations: [], route: { providerId: "groq", modelId: "coder" }, routePoolId: "managed:groq:coder" };
        }
        reviewerRoutes.push(options.excludeRoleRoute);
        if (reviewerRoutes.length === 1) return { status: "blocked", summary: "[AGENT_MODEL_TURN_LIMIT] no verdict", findings: [], evidence: [], files: [], risks: [], recommendations: [], route: { providerId, modelId: "reviewer-a" }, routePoolId };
        return { status: "completed", summary: "pass", findings: [], evidence: [], files: [], risks: [], recommendations: [], structuredData: { verdict: "pass", summary: "pass", findings: [] }, route: { providerId: "mistral", modelId: "reviewer-b" }, routePoolId: "managed:mistral:b" };
      },
      cancelParent: () => undefined,
    } as unknown as SubagentManager;
    const orchestrator = createAutonomousRunOrchestrator({ workspaceService: createWorkspaceService({ persistence, worktreeParentDir: worktrees }), persistence, subagentManager: manager, subagentsR1Enabled: true });
    const result = await orchestrator.startRun({ sessionId: "r54-semantic", workspacePath: repo, goal: "Implement partial and finish in the math module with tests", verificationCommands: ["node --test test/integration.test.mjs"] });
    expect(result.status).toBe("completed");
    expect(result.completion?.outcome).toBe("completed");
    expect(reviewerRoutes).toEqual([undefined, { providerId, modelId: "reviewer-a" }]);
    expect(await persistence.getWorkItemsByKind("semantic_verifier_handoff")).toMatchObject([{ oldOwner: { providerId, modelId: "reviewer-a" }, newOwner: { providerId: "mistral", modelId: "reviewer-b" }, priorVerdict: "NONE" }]);
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

  it("preserves one coding edit while rotating three Reviewer candidates with cumulative exclusions", async () => {
    let coderCalls = 0;
    const exclusions: SpawnChildOptions["excludeRoleRoutes"][] = [];
    const manager = {
      spawnChildAgent: async (options: SpawnChildOptions) => {
        const base = { summary: "done", findings: [], evidence: [], files: [], risks: [], recommendations: [] };
        if (options.agentId === "explorer") return { ...base, status: "completed" };
        if (options.agentId === "coder") {
          coderCalls++;
          await writeFile(join(options.workspacePath, "src", "math.mjs"), "export function partial() { return 2; }\nexport function finish() { return 3; }\n");
          return { ...base, status: "completed", files: ["src/math.mjs"], route: { providerId: "coder", modelId: "coder" }, routePoolId: "coder:ip" };
        }
        exclusions.push(options.excludeRoleRoutes?.map((route) => ({ ...route })));
        expect(options.preferIndependentFromPoolId).toBe("coder:ip");
        expect(await readFile(join(options.workspacePath, "src", "math.mjs"), "utf8")).toContain("function finish()");
        const route = { providerId: "public-anonymous", modelId: `reviewer-${exclusions.length}` };
        if (exclusions.length < 3) return { ...base, status: "blocked", summary: "[AGENT_INVALID_STRUCTURED_OUTPUT] no verdict", route, routePoolId: "public-ip:egress" };
        return { ...base, status: "completed", structuredData: { verdict: "pass", summary: "Reviewed", findings: [] }, route, routePoolId: "public-ip:egress" };
      },
      cancelParent: () => undefined,
    } as unknown as SubagentManager;
    const orchestrator = createAutonomousRunOrchestrator({ workspaceService: createWorkspaceService({ persistence, worktreeParentDir: worktrees }), persistence, subagentManager: manager, subagentsR1Enabled: true });
    const result = await orchestrator.startRun({ sessionId: "r73-reviewer-roster", workspacePath: repo, goal: "Implement partial and finish in the math module with tests", verificationCommands: ["node --test test/integration.test.mjs"] });
    expect(result.status).toBe("completed");
    expect(result.completion?.outcome).toBe("completed");
    expect(result.review.passed).toBe(true);
    expect(result.verification.every((item) => item.passed)).toBe(true);
    expect(result.integration.status).toBe("integrated");
    expect(coderCalls).toBe(1);
    expect(exclusions).toEqual([undefined, [{ providerId: "public-anonymous", modelId: "reviewer-1" }], [{ providerId: "public-anonymous", modelId: "reviewer-1" }, { providerId: "public-anonymous", modelId: "reviewer-2" }]]);
    const handoffs = await persistence.getWorkItemsByKind("semantic_verifier_handoff");
    expect(handoffs).toHaveLength(2);
    expect(handoffs.map((handoff) => (handoff as unknown as { diffHash: string }).diffHash)[0]).toBe((handoffs[1] as unknown as { diffHash: string }).diffHash);
  });

  it("bounds the Reviewer roster and never interprets a malformed verdict as approval", async () => {
    let coderCalls = 0;
    let reviewerCalls = 0;
    const manager = {
      spawnChildAgent: async (options: SpawnChildOptions) => {
        const base = { summary: "done", findings: [], evidence: [], files: [], risks: [], recommendations: [] };
        if (options.agentId === "explorer") return { ...base, status: "completed" };
        if (options.agentId === "coder") {
          coderCalls++;
          await writeFile(join(options.workspacePath, "src", "math.mjs"), "export function partial() { return 2; }\nexport function finish() { return 3; }\n");
          return { ...base, status: "completed", files: ["src/math.mjs"] };
        }
        reviewerCalls++;
        return { ...base, status: "completed", structuredData: { verdict: "approve", findings: [] }, route: { providerId: "public-anonymous", modelId: `reviewer-${reviewerCalls}` } };
      },
      cancelParent: () => undefined,
    } as unknown as SubagentManager;
    const orchestrator = createAutonomousRunOrchestrator({ workspaceService: createWorkspaceService({ persistence, worktreeParentDir: worktrees }), persistence, subagentManager: manager, subagentsR1Enabled: true });
    const result = await orchestrator.startRun({ sessionId: "r73-reviewer-bound", workspacePath: repo, goal: "Implement partial and finish in the math module with tests", verificationCommands: ["node --test test/integration.test.mjs"] });
    expect(result.status).toBe("blocked");
    expect(result.integration.status).not.toBe("integrated");
    expect(result.review.passed).toBe(false);
    expect(reviewerCalls).toBe(3);
    expect(coderCalls).toBe(1);
    expect(await readFile(join(repo, "src", "math.mjs"), "utf8")).not.toContain("function finish()");
  });
});
