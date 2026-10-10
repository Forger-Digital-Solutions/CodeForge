import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSessionPersistence } from "@codeforge/sessions";

const exec = promisify(execFile);
const fixture = fileURLToPath(new URL("./fixtures/personal-parent-worker.mjs", import.meta.url));
const runId = "run-00000000-0000-4000-8000-000000000073";

async function exercise(mode: string, options: { crashCoder?: boolean; missingIdentity?: boolean; retryParked?: boolean; concurrentRetry?: boolean } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "cf-personal-parent-recovery-"));
  const repo = path.join(root, "repo");
  const dbPath = path.join(root, "session.db");
  try {
    await mkdir(path.join(repo, "test"), { recursive: true });
    await writeFile(path.join(repo, "math.mjs"), "export function multiply(a, b) { return 0; }\n");
    await writeFile(path.join(repo, "test/math.test.mjs"), "import test from 'node:test'; import assert from 'node:assert/strict'; import {multiply} from '../math.mjs'; test('multiply',()=>assert.equal(multiply(6,7),42));\n");
    for (const args of [["init"], ["config", "user.name", "Recovery Test"], ["config", "user.email", "test@codeforge.invalid"], ["config", "commit.gpgsign", "false"], ["add", "."], ["commit", "-m", "baseline"]]) await exec("git", args, { cwd: repo, windowsHide: true });
    const args = [dbPath, repo, path.join(root, "worktrees")];
    const crash = await exec(process.execPath, [fixture, options.crashCoder ? "kill-coder" : "kill-reviewer", ...args], { windowsHide: true, timeout: 90_000 })
      .catch((error: { stdout: string }) => ({ stdout: error.stdout }));
    expect(crash.stdout).toContain("CRASH_PERSONAL_REVIEWER");
    const before = createSessionPersistence({ dbPath }); await before.init();
    try {
      const state = await before.getWorkItem(`parent-state-${runId}`);
      expect(state).toBeDefined();
      const serialized = JSON.stringify(state);
      expect(serialized).toContain('"ownerUserId":"alice"');
      expect(serialized).toContain('"personalRoutingMode":"FREE_PREFERRED"');
      expect(serialized).not.toContain("fixture-reference-must-not-enter-parent");
      expect(serialized).not.toContain("catalog");
      expect(serialized).not.toContain("spending");
      if (options.missingIdentity) {
        const { rosterRecovery: _identity, ...legacy } = state as unknown as Record<string, unknown>;
        await before.upsertWorkItem(legacy as never);
      }
    } finally { await before.close(); }
    const resumed = await exec(process.execPath, [fixture, mode, ...args], { windowsHide: true, timeout: 90_000 });
    let receipt = JSON.parse(resumed.stdout.trim()) as { status: string; error?: string; requests: number; result?: { completion?: { outcome: string }; review: { passed: boolean }; integration: { status: string } } };
    if (options.retryParked) {
      expect(receipt.status).toBe("blocked"); expect(receipt.requests).toBe(0);
      const parked = createSessionPersistence({ dbPath }); await parked.init();
      try {
        expect(await parked.getWorkItem(`parent-recovery-${runId}`)).toMatchObject({ outcome: "parked" });
        expect(await parked.getWorkItem(`parent-state-${runId}`)).not.toHaveProperty("recoveryAttempts");
      } finally { await parked.close(); }
      const retry = await exec(process.execPath, [fixture, options.concurrentRetry ? "recover-parked-concurrent" : "recover-parked-only", ...args], { windowsHide: true, timeout: 90_000 });
      receipt = JSON.parse(retry.stdout.trim()) as typeof receipt;
    }
    const shouldComplete = (mode === "recover" && !options.missingIdentity) || options.retryParked;
    const after = createSessionPersistence({ dbPath }); await after.init();
    try {
      const writes = (await after.getWorkItemsByKind("agent_tool_execution")).filter(item => item.kind === "agent_tool_execution" && item.toolName === "write_file" && item.state === "observation_recorded");
      expect(writes).toHaveLength(1);
      if (shouldComplete) {
        const workers = (await after.getWorkItemsByKind("subagent_run")).filter(item => item.kind === "subagent_run");
        const resumedWorker = workers.find(item => item.kind === "subagent_run" && item.agentId === (options.crashCoder ? "coder" : "reviewer"));
        expect(resumedWorker?.kind === "subagent_run" && resumedWorker.rosterAllowance?.userRoutes?.[0]?.priceSource).toBe("CURRENT_AUTHORITY");
      }
    } finally { await after.close(); }
    const content = await readFile(path.join(repo, "math.mjs"), "utf8");
    if (shouldComplete) {
      expect(receipt.status, JSON.stringify(receipt)).toBe("completed");
      expect(receipt.result?.completion?.outcome).toBe("completed");
      expect(receipt.result?.review.passed).toBe(true);
      expect(receipt.result?.integration.status).toBe("integrated");
      expect(content).toContain("a * b");
      if (options.concurrentRetry) expect(receipt.requests).toBe(1);
    } else {
      expect(receipt.status, JSON.stringify(receipt)).toBe("blocked");
      expect(receipt.requests).toBe(0);
      expect(content).toContain("return 0");
    }
    return receipt;
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
}

describe("personal-roster parent crash recovery", () => {
  it("resumes a real Reviewer process crash with fresh authority, review, ForgeVerify and integration", () => exercise("recover"), 120_000);
  it("preserves the Coder edit across a real process crash without repeating its write", () => exercise("recover", { crashCoder: true }), 120_000);
  it("rejects a different current owner before any model request", async () => expect((await exercise("recover-owner-changed")).error).toContain("PARENT_RECOVERY_OWNER_CHANGED"), 120_000);
  it("rejects an active workspace change before any model request", async () => expect((await exercise("recover-workspace-changed")).error).toContain("PARENT_RECOVERY_WORKSPACE_MISMATCH"), 120_000);
  it("keeps revoked account authorization blocked while preserving the edit", async () => expect((await exercise("recover-revoked")).error).toContain("PARENT_RECOVERY_ROSTER_AUTHORIZATION_DENIED"), 120_000);
  it("does not restore an old paid-routing preference after current policy changes", async () => expect((await exercise("recover-mode-changed")).error).toContain("PARENT_RECOVERY_ROUTING_POLICY_CHANGED"), 120_000);
  it("does not substitute changed configured roster slots", async () => expect((await exercise("recover-roster-changed")).error).toContain("PARENT_RECOVERY_ROUTING_POLICY_CHANGED"), 120_000);
  it("rechecks current workspace privacy before resuming the Reviewer", async () => expect((await exercise("recover-privacy-revoked")).error).toContain("ROSTER_NO_ELIGIBLE_ROLE_MODEL:REVIEWER"), 120_000);
  it("fails closed without a trusted current roster resolver", async () => expect((await exercise("recover-no-authority")).error).toContain("PARENT_RECOVERY_ROSTER_AUTHORITY_UNAVAILABLE"), 120_000);
  it("preserves progress and blocks when current authorization cannot be refreshed", async () => expect((await exercise("recover-authority-error")).error).toContain("Current authorization unavailable"), 120_000);
  it("does not resume legacy personal allowances that lack a durable parent owner identity", async () => expect((await exercise("recover", { missingIdentity: true })).error).toContain("PARENT_RECOVERY_ROSTER_IDENTITY_MISSING"), 120_000);
  it("parks missing startup authority without spending recovery budget and resumes after restoration", () => exercise("recover-no-authority", { retryParked: true }), 120_000);
  it("serializes concurrent parked-parent retries without repeating review or edits", () => exercise("recover-no-authority", { retryParked: true, concurrentRetry: true }), 120_000);
});
