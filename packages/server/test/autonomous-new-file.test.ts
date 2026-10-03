import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentResult } from "@codeforge/agent";
import { createSessionPersistence } from "@codeforge/sessions";
import { createWorkspaceService } from "../src/workspace-service.js";
import { createAutonomousRunOrchestrator } from "../src/autonomous-orchestrator.js";
import type { SubagentManager, SpawnChildOptions } from "../src/subagent-manager.js";

const exec = promisify(execFile);
async function exercise(broken: boolean) {
  const root = await mkdtemp(join(tmpdir(), "cf-new-file-"));
  const repo = join(root, "repo");
  const persistence = createSessionPersistence({ dbPath: join(root, "session.db") });
  let reviewerContext = "";
  try {
    await mkdir(repo); await persistence.init();
    await writeFile(join(repo, "multiply.mjs"), "export const multiply = (a,b) => a*b;\n");
    for (const args of [["init"], ["config", "user.name", "New File Test"], ["config", "user.email", "test@codeforge.invalid"], ["config", "commit.gpgsign", "false"], ["add", "."], ["commit", "-m", "baseline"]]) await exec("git", args, { cwd: repo, windowsHide: true });
    const subagentManager = {
      async spawnChildAgent(options: SpawnChildOptions): Promise<AgentResult> {
        if (options.agentId === "coder") await writeFile(join(options.workspacePath, "multiply.test.mjs"), `import test from 'node:test'; import assert from 'node:assert/strict'; import {multiply} from './multiply.mjs'; test('multiply',()=>assert.equal(multiply(6,7),${broken ? 0 : 42}));\n`);
        if (options.agentId === "reviewer") reviewerContext = options.contextSummary ?? "";
        return { status: "completed", summary: "Done", findings: [], evidence: [], files: options.agentId === "coder" ? ["multiply.test.mjs"] : [], risks: [], recommendations: [], ...(options.agentId === "reviewer" ? { structuredData: { verdict: "pass" as const, findings: [], summary: "Reviewed" } } : {}) };
      },
      cancelParent() {},
    };
    const orchestrator = createAutonomousRunOrchestrator({ persistence, workspaceService: createWorkspaceService({ persistence, worktreeParentDir: join(root, "worktrees") }), subagentManager: subagentManager as unknown as SubagentManager, subagentsR1Enabled: true });
    const result = await orchestrator.startRun({ sessionId: "new-file", workspacePath: repo, topology: "normal", goal: "Add an exact multiply test while preserving implementation", verificationCommands: ["node --test"] });
    expect(reviewerContext).toContain("diff --git a/multiply.test.mjs b/multiply.test.mjs");
    expect(reviewerContext).toContain("new file mode");
    if (broken) {
      expect(result.status).toBe("blocked"); expect(result.integration.status).toBe("blocked");
      expect(result.verification.some(verifier => verifier.failed > 0)).toBe(true);
      await expect(readFile(join(repo, "multiply.test.mjs"))).rejects.toThrow();
    } else {
      expect(result.status).toBe("completed"); expect(result.completion?.outcome).toBe("completed");
      expect(result.changedFiles).toContain("multiply.test.mjs"); expect(result.integration.status).toBe("integrated");
      expect(await readFile(join(repo, "multiply.test.mjs"), "utf8")).toContain("42");
      expect(await readFile(join(repo, "multiply.mjs"), "utf8")).toBe("export const multiply = (a,b) => a*b;\n");
    }
  } finally { await persistence.close(); await rm(root, { recursive: true, force: true }); }
}
describe("Autonomous creation of new files", () => {
  it("reviews, verifies and integrates a change made only of a new untracked test file", () => exercise(false), 120000);
  it("refuses integration when the new test fails despite Reviewer PASS", () => exercise(true), 120000);
});
