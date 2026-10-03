import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSessionPersistence } from "@codeforge/sessions";

const exec = promisify(execFile);
const fixture = fileURLToPath(new URL("../../../benchmarks/r67/parent-worker.mjs", import.meta.url));

async function exercise(options: { changeBase?: boolean; resultWindow?: boolean; ambiguousIntegration?: boolean; exhaustedRepair?: boolean; mode?: string } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "cf-parent-recovery-"));
  const repo = path.join(root, "repo");
  const dbPath = path.join(root, "session.db");
  try {
    await mkdir(path.join(repo, "test"), { recursive: true });
    await writeFile(path.join(repo, "math.mjs"), "export function multiply(a, b) { return 0; }\n");
    await writeFile(path.join(repo, "test/math.test.mjs"), "import test from 'node:test'; import assert from 'node:assert/strict'; import {multiply} from '../math.mjs'; test('multiply',()=>assert.equal(multiply(6,7),42));\n");
    for (const args of [["init"], ["config", "user.name", "Recovery Test"], ["config", "user.email", "test@codeforge.invalid"], ["config", "commit.gpgsign", "false"], ["add", "."], ["commit", "-m", "baseline"]]) await exec("git", args, { cwd: repo, windowsHide: true });
    const args = [dbPath, repo, path.join(root, "worktrees")];
    const crash = await exec(process.execPath, [fixture, options.mode ?? "kill-reviewer", ...args], { windowsHide: true, timeout: 90000 }).catch((error: { stdout: string }) => ({ stdout: error.stdout }));
    expect(crash.stdout).toContain("CRASH_REVIEWER");
    if (options.changeBase) {
      await writeFile(path.join(repo, "human.txt"), "Independent human change\n");
      await exec("git", ["add", "human.txt"], { cwd: repo });
      await exec("git", ["commit", "-m", "human change"], { cwd: repo });
    }
    if (options.resultWindow) {
      const db = createSessionPersistence({ dbPath }); await db.init();
      const coder = (await db.getWorkItemsByKind("subagent_run")).find(item => item.kind === "subagent_run" && item.agentId === "coder");
      if (!coder || coder.kind !== "subagent_run") throw new Error("Coder missing");
      await db.upsertWorkItem({ ...coder, status: "running" }); await db.close();
    }
    if (options.ambiguousIntegration || options.exhaustedRepair) {
      const db = createSessionPersistence({ dbPath }); await db.init();
      if (options.ambiguousIntegration) {
        const state = await db.getWorkItem("parent-state-run-00000000-0000-4000-8000-000000000067");
        if (!state) throw new Error("Parent state missing");
        await db.upsertWorkItem({ ...state, phase: "integrating" } as never);
      } else {
        const reviewer = (await db.getWorkItemsByKind("subagent_run")).find(item => item.kind === "subagent_run" && item.agentId === "reviewer");
        if (!reviewer) throw new Error("Reviewer missing");
        const journal = await db.getWorkItem(`agent-run-journal-${reviewer.id}`);
        if (!journal) throw new Error("Reviewer journal missing");
        await db.upsertWorkItem({ ...journal, telemetry: { ...journal.telemetry, structuredOutput: { repairs: 1, truncationRepairs: 0, repairStrategies: [], rejections: [], missingFields: [], exhausted: false } } } as never);
      }
      await db.close();
    }
    const resumed = await exec(process.execPath, [fixture, options.exhaustedRepair ? "recover-invalid-reviewer" : "recover", ...args], { windowsHide: true, timeout: 90000 }).catch((error: { stdout: string }) => ({ stdout: error.stdout }));
    const receipt = JSON.parse(resumed.stdout.trim()) as { status: string; error?: string; result?: { completion?: { outcome: string }; review: { passed: boolean }; integration: { status: string } } };
    const db = createSessionPersistence({ dbPath }); await db.init();
    let writes;
    try {
      writes = (await db.getWorkItemsByKind("agent_tool_execution")).filter(item => item.kind === "agent_tool_execution" && item.toolName === "write_file" && item.state === "observation_recorded");
      if (options.exhaustedRepair) {
        const reviewer = (await db.getWorkItemsByKind("subagent_run")).find(item => item.kind === "subagent_run" && item.agentId === "reviewer");
        const turns = (await db.getWorkItemsByKind("agent_model_turn")).filter(item => item.runId === reviewer?.id);
        expect(turns.filter(item => item.state === "provider_response_completed")).toHaveLength(1);
        expect(turns.filter(item => item.state === "provider_request_started")).toHaveLength(1);
      }
    } finally { await db.close(); }
    expect(writes).toHaveLength(1);
    const content = await readFile(path.join(repo, "math.mjs"), "utf8");
    if (options.changeBase || options.ambiguousIntegration || options.exhaustedRepair) {
      expect(receipt.status).toBe("blocked");
      if (options.changeBase) expect(receipt.error).toContain("PARENT_RECOVERY_BASE_CHANGED");
      if (options.ambiguousIntegration) expect(receipt.error).toContain("AMBIGUOUS_INTEGRATION_REQUIRES_REVALIDATION");
      expect(content).toContain("return 0");
    } else {
      expect(receipt.status).toBe("completed"); expect(receipt.result?.completion?.outcome).toBe("completed");
      expect(receipt.result?.review.passed).toBe(true); expect(receipt.result?.integration.status).toBe("integrated"); expect(content).toContain("a * b");
    }
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
}

describe("Autonomous parent recovery", () => {
  it("recovers an Explorer process interruption through the parent gate", () => exercise({ mode: "kill-explorer" }), 120000);
  it("recovers a Coder interruption after a recorded edit without replaying it", () => exercise({ mode: "kill-coder" }), 120000);
  it("recovers an actual reviewer process crash through verification and integration without replaying edits", () => exercise(), 120000);
  it("reuses the durable result when a crash preceded the worker terminal write", () => exercise({ resultWindow: true }), 120000);
  it("blocks integration when the human's target HEAD changed after the crash", () => exercise({ changeBase: true }), 120000);
  it("blocks an ambiguous integration boundary instead of replaying integration", () => exercise({ ambiguousIntegration: true }), 120000);
  it("preserves an exhausted Reviewer repair budget across a process restart", () => exercise({ exhaustedRepair: true }), 120000);
});
