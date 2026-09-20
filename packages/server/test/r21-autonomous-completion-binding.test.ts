import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { createVerificationInputStateHash, runVerification } from "@codeforge/workflow";
import { evaluateAutonomousCompletion } from "../src/completion-authority.js";

/**
 * R21: the mission supervisor and the parallel orchestrator hand the completion authority legacy
 * per-verifier results, not a structured ForgeVerify report. Those results now carry the
 * ForgeVerify `inputStateHash`, and the authority recomputes the workspace state at decision time
 * — so a workspace edited after its final verification is blocked on those paths too, not only
 * in the WorkflowEngine.
 */

const cleanup: string[] = [];
afterEach(() => { for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

const GIT = ["-c", "user.email=r21@codeforge.test", "-c", "user.name=r21", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false"];
function repo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r21-auto-completion-"));
  cleanup.push(dir);
  fs.writeFileSync(path.join(dir, "src.js"), "module.exports = { value: 1 };\n");
  fs.writeFileSync(path.join(dir, "test.cjs"), "const m = require('./src.js'); if (m.value !== 1) { console.log('Tests: 1 failed, 0 passed, 1 total'); process.exit(1); } console.log('Tests: 0 failed, 1 passed, 1 total'); process.exit(0);");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "r21", version: "0.0.0", private: true }));
  execFileSync("git", [...GIT, "init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", [...GIT, "add", "-A"], { cwd: dir });
  execFileSync("git", [...GIT, "commit", "-q", "-m", "base"], { cwd: dir });
  return dir;
}

/** Exactly the mapping mission-supervisor.ts / parallel-orchestrator.ts perform. */
async function legacyResults(dir: string) {
  const report = await runVerification(dir, ["node test.cjs"], { runId: "r21-auto" });
  return report.verifiers.map((verifier) => ({
    command: verifier.command, cwd: dir, passed: verifier.passed, failed: verifier.failed, skipped: verifier.skipped, exitCode: verifier.exitCode, durationMs: verifier.durationMs, output: verifier.output, failures: verifier.failures,
    ...(verifier.testSignal ? { testSignal: verifier.testSignal } : {}),
    ...(verifier.noTestsDiscovered ? { noTestsDiscovered: true } : {}),
    ...(verifier.contradictoryOutput ? { contradictoryOutput: true } : {}),
    ...(verifier.inputStateHash ? { inputStateHash: verifier.inputStateHash } : {}),
  }));
}

describe("R21 evaluateAutonomousCompletion — legacy results are rebound to live workspace state", () => {
  it("completes when the workspace is unchanged since verification", async () => {
    const dir = repo();
    const verification = await legacyResults(dir);
    expect(verification[0]!.inputStateHash).toBe(createVerificationInputStateHash(dir));
    const decision = evaluateAutonomousCompletion({ runId: "r", title: "t", changedFiles: ["src.js"], diff: "+x", verification, reviewPassed: true, workspacePath: dir });
    expect(decision.outcome).toBe("completed");
  });

  it("blocks with verification_not_current when the workspace was edited after the final verification", async () => {
    const dir = repo();
    const verification = await legacyResults(dir);
    fs.writeFileSync(path.join(dir, "src.js"), "module.exports = { value: 2 };\n");
    const decision = evaluateAutonomousCompletion({ runId: "r", title: "t", changedFiles: ["src.js"], diff: "+x", verification, reviewPassed: true, workspacePath: dir });
    expect(decision.outcome).toBe("blocked");
    expect(decision.blockers.map((blocker) => blocker.code)).toContain("verification_not_current");
  });

  it("blocks when results disagree about which workspace state they verified", async () => {
    const dir = repo();
    const verification = await legacyResults(dir);
    const mixed = [...verification, { ...verification[0]!, inputStateHash: "0".repeat(64) }];
    const decision = evaluateAutonomousCompletion({ runId: "r", title: "t", changedFiles: ["src.js"], diff: "+x", verification: mixed, reviewPassed: true, workspacePath: dir });
    expect(decision.outcome).toBe("blocked");
    expect(decision.blockers.map((blocker) => blocker.code)).toContain("verification_not_current");
  });

  it("keeps legacy semantics for callers that provide no workspace path (no binding possible, no false block)", async () => {
    const dir = repo();
    const verification = await legacyResults(dir);
    fs.writeFileSync(path.join(dir, "src.js"), "module.exports = { value: 2 };\n");
    const decision = evaluateAutonomousCompletion({ runId: "r", title: "t", changedFiles: ["src.js"], diff: "+x", verification, reviewPassed: true });
    expect(decision.outcome).toBe("completed");
  });

  it("propagates the no-tests-discovered and contradictory-output classifications", async () => {
    const dir = repo();
    fs.writeFileSync(path.join(dir, "test.cjs"), "console.log('No test files found, exiting with code 0'); process.exit(0);");
    execFileSync("git", [...GIT, "commit", "-q", "-am", "empty runner"], { cwd: dir });
    const none = evaluateAutonomousCompletion({ runId: "r", title: "t", changedFiles: ["src.js"], diff: "+x", verification: await legacyResults(dir), reviewPassed: true, workspacePath: dir });
    expect(none.outcome).toBe("blocked");
    expect(none.blockers.map((blocker) => blocker.code)).toContain("verification_not_run");

    fs.writeFileSync(path.join(dir, "test.cjs"), "console.log('Tests: 2 failed, 3 passed, 5 total'); process.exit(0);");
    execFileSync("git", [...GIT, "commit", "-q", "-am", "lying runner"], { cwd: dir });
    const contradictory = evaluateAutonomousCompletion({ runId: "r", title: "t", changedFiles: ["src.js"], diff: "+x", verification: await legacyResults(dir), reviewPassed: true, workspacePath: dir });
    expect(contradictory.outcome).toBe("failed");
    expect(contradictory.blockers.map((blocker) => blocker.code)).toContain("verification_failed");
  });
});
