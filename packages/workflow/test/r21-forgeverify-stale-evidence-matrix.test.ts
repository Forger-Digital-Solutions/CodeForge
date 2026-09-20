import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { runVerification } from "../src/verification-service.js";
import { createVerificationInputStateHash, summarizeVerification, createVerifierRegistry, adaptTrustedLegacyVerifiers } from "../src/forge-verify.js";
import { evaluateCompletion, type CompletionGateDecision } from "../src/completion-gate.js";
import type { VerificationReport, WorkflowPlan } from "../src/types.js";
import { recordR21Evidence } from "./r21-evidence.js";

/**
 * R21 stale-evidence matrix. The required adversarial sequence is
 *
 *     edit → verify → PASS → edit again → attempt completion
 *
 * and the required verdict is BLOCK / STALE EVIDENCE / REVERIFY. Each scenario performs the second
 * edit through a different git mechanism (dirty tree, commit, amend, partial staging, alternate
 * worktree, subagent worktree, restored file) and asks the real completion gate, with the state
 * hash recomputed at decision time, whether the old PASS may certify the new state.
 */

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const GIT_ENV = ["-c", "user.email=r21@codeforge.test", "-c", "user.name=r21", "-c", "commit.gpgsign=false"];
function git(dir: string, ...args: string[]): string {
  return execFileSync("git", [...GIT_ENV, ...args], { cwd: dir, encoding: "utf8", windowsHide: true }).trim();
}

const TEST_SCRIPT = "const m = require('./src.js'); if (m.value !== 1) { console.log('Tests: 1 failed, 0 passed, 1 total'); process.exit(1); } console.log('Tests: 0 failed, 1 passed, 1 total'); process.exit(0);";

function repo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r21-fv-stale-"));
  cleanupDirs.push(dir);
  fs.writeFileSync(path.join(dir, "src.js"), "module.exports = { value: 1 };\n");
  fs.writeFileSync(path.join(dir, "test.cjs"), TEST_SCRIPT);
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "r21-stale", version: "0.0.0", private: true }));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  return dir;
}

async function verify(dir: string, runId: string): Promise<VerificationReport> {
  return runVerification(dir, ["node test.cjs"], { runId });
}

/** The gate as production calls it: the state hash is computed NOW, at decision time. */
function attemptCompletion(dir: string, report: VerificationReport): CompletionGateDecision {
  const plan: WorkflowPlan = {
    id: "p", title: "t", taskId: "r21-stale", status: "completed", createdAt: "", updatedAt: "",
    steps: [
      { id: "edit", description: "edit", status: "completed", kind: "edit", risk: "safe", requiresApproval: false, targetPath: "src.js" },
      { id: "verify", description: "verify", status: report.requiredPassed ? "completed" : "failed", kind: "verify", risk: "safe", requiresApproval: false },
    ],
  };
  return evaluateCompletion({
    plan,
    verification: report,
    verificationSummary: report.forgeVerify?.summary,
    analysis: { hasFailures: report.failed > 0, summary: report.output, diagnostics: [], suggestedRepairs: [], isRepairable: false },
    review: { approved: true, issues: [], findings: [], diffs: [{ path: "src.js", changeType: "modified", additions: 1, deletions: 0, diff: "+x", beforeHash: "a", afterHash: "b" }], summary: "1 file" },
    currentVerificationInputStateHash: createVerificationInputStateHash(dir),
  });
}

function expectStaleBlock(scenario: string, decision: CompletionGateDecision, extra: Record<string, unknown> = {}): void {
  expect(decision.outcome, scenario).not.toBe("completed");
  expect(decision.blockers.map((blocker) => blocker.code), scenario).toContain("verification_not_current");
  recordR21Evidence("forgeverify-stale-evidence-matrix", { scenario, outcome: decision.outcome, blockers: decision.blockers.map((blocker) => blocker.code), falseCompletion: decision.outcome === "completed", ...extra });
}

describe("R21 stale-evidence matrix — old PASS evidence can never certify changed work", () => {
  it("[baseline] verify → PASS → attempt completion with no further change → COMPLETED", async () => {
    const dir = repo();
    const report = await verify(dir, "m0");
    expect(report.requiredPassed).toBe(true);
    const decision = attemptCompletion(dir, report);
    expect(decision.outcome).toBe("completed");
    recordR21Evidence("forgeverify-stale-evidence-matrix", { scenario: "baseline_unchanged", outcome: decision.outcome, falseCompletion: false });
  });

  it("[same-branch dirty tree] a tracked edit after PASS → BLOCK verification_not_current", async () => {
    const dir = repo();
    const report = await verify(dir, "m1");
    expect(report.requiredPassed).toBe(true);
    fs.writeFileSync(path.join(dir, "src.js"), "module.exports = { value: 2 };\n"); // breaks the test
    expectStaleBlock("same_branch_dirty_tree", attemptCompletion(dir, report));
  });

  it("[untracked file] a new untracked file after PASS → BLOCK", async () => {
    const dir = repo();
    const report = await verify(dir, "m2");
    fs.writeFileSync(path.join(dir, "extra.js"), "module.exports = 'new';\n");
    expectStaleBlock("untracked_file_added", attemptCompletion(dir, report));
  });

  it("[commit change] a commit after PASS (HEAD moves) → BLOCK", async () => {
    const dir = repo();
    const report = await verify(dir, "m3");
    fs.writeFileSync(path.join(dir, "src.js"), "module.exports = { value: 2 };\n");
    git(dir, "commit", "-q", "-am", "break it");
    expect(git(dir, "status", "--porcelain")).toBe(""); // clean tree, but HEAD differs
    expectStaleBlock("commit_after_pass", attemptCompletion(dir, report));
  });

  it("[amend] amending HEAD after PASS with different content → BLOCK", async () => {
    const dir = repo();
    const report = await verify(dir, "m4");
    fs.writeFileSync(path.join(dir, "src.js"), "module.exports = { value: 2 };\n");
    git(dir, "commit", "-q", "-a", "--amend", "-m", "base (amended)");
    expectStaleBlock("amend_after_pass", attemptCompletion(dir, report));
  });

  it("[partial staging] staging a broken change but leaving the worktree file broken too → BLOCK; staged-only differences are also detected", async () => {
    const dir = repo();
    const report = await verify(dir, "m5");
    fs.writeFileSync(path.join(dir, "src.js"), "module.exports = { value: 2 };\n");
    git(dir, "add", "src.js");
    // Now the index holds value:2 and the worktree holds value:2 → diff HEAD shows the change.
    expectStaleBlock("partial_staging_index_and_worktree", attemptCompletion(dir, report));
    // Revert the worktree copy but leave the index staged: `git diff HEAD` is now EMPTY, and only
    // the index (`git diff --cached`) still carries the broken change a commit would deliver.
    fs.writeFileSync(path.join(dir, "src.js"), "module.exports = { value: 1 };\n");
    expect(git(dir, "diff", "--name-only", "--cached")).toBe("src.js");
    expectStaleBlock("partial_staging_index_only", attemptCompletion(dir, report), { note: "index differs from HEAD although the worktree file was restored" });
  });

  it("[restored file] editing and then restoring the exact prior content returns to the verified state → COMPLETED is honest", async () => {
    const dir = repo();
    const report = await verify(dir, "m6");
    fs.writeFileSync(path.join(dir, "src.js"), "module.exports = { value: 2 };\n");
    expectStaleBlock("restored_file_before_restore", attemptCompletion(dir, report));
    fs.writeFileSync(path.join(dir, "src.js"), "module.exports = { value: 1 };\n");
    const decision = attemptCompletion(dir, report);
    // The workspace is byte-identical to the verified state; the evidence is valid for it.
    expect(decision.outcome).toBe("completed");
    recordR21Evidence("forgeverify-stale-evidence-matrix", { scenario: "restored_file_after_restore", outcome: decision.outcome, note: "identical content ⇒ identical input-state hash ⇒ evidence valid; this is correct, not a leak" });
  });

  it("[alternate worktree] PASS in worktree A never certifies worktree B, even at the same commit", async () => {
    const dir = repo();
    const report = await verify(dir, "m7");
    const other = path.join(os.tmpdir(), `r21-fv-wt-${path.basename(dir)}`);
    cleanupDirs.push(other);
    git(dir, "worktree", "add", "-q", "-b", "feature", other, "main");
    // Same commit, different path: the evidence is bound to the canonical workspace path.
    expectStaleBlock("alternate_worktree_same_commit", attemptCompletion(other, report), { note: "workspacePath is part of the evidence identity" });
    // And a change made in the other worktree is invisible to a hash of the original — the
    // original's evidence remains valid for the original, which is the correct scoping.
    fs.writeFileSync(path.join(other, "src.js"), "module.exports = { value: 2 };\n");
    expect(attemptCompletion(dir, report).outcome).toBe("completed");
    git(dir, "worktree", "remove", "--force", other);
  });

  it("[subagent worktree] a child worktree's PASS cannot certify the parent workspace and vice versa", async () => {
    const dir = repo();
    const child = path.join(os.tmpdir(), `r21-fv-child-${path.basename(dir)}`);
    cleanupDirs.push(child);
    git(dir, "worktree", "add", "-q", "-b", "subagent/coder", child, "main");
    const childReport = await verify(child, "m8-child");
    expect(childReport.requiredPassed).toBe(true);
    expectStaleBlock("subagent_child_pass_vs_parent", attemptCompletion(dir, childReport));
    // The child commits its (broken) work; the parent's own evidence is still parent-scoped.
    fs.writeFileSync(path.join(child, "src.js"), "module.exports = { value: 2 };\n");
    git(child, "commit", "-q", "-am", "child work");
    expectStaleBlock("subagent_child_pass_after_child_commit", attemptCompletion(child, childReport));
    git(dir, "worktree", "remove", "--force", child);
  });

  it("[summary re-evaluation] summarizeVerification itself reports `stale` for the same evidence once the workspace changes", async () => {
    const dir = repo();
    const report = await verify(dir, "m9");
    const plan = report.forgeVerify!.plan;
    // Rebuild the registry exactly as runVerification did for the configured command list.
    const registry = createVerifierRegistry(adaptTrustedLegacyVerifiers(dir, [{ id: "verifier-1-test", kind: "test", command: "node test.cjs", required: true, source: "configured" }]));
    expect(summarizeVerification(plan, registry, report.forgeVerify!.evidence).verificationComplete).toBe(true);
    fs.writeFileSync(path.join(dir, "src.js"), "module.exports = { value: 2 };\n");
    const after = summarizeVerification(plan, registry, report.forgeVerify!.evidence);
    expect(after.verificationComplete).toBe(false);
    expect(after.reasons).toContain("stale");
    expect(after.inputStateHash).not.toBe(plan.inputStateHash);
    recordR21Evidence("forgeverify-stale-evidence-matrix", { scenario: "summary_reevaluation", stale: true, staleCount: after.staleCount });
  });

  it("[reverify] after a stale block, a fresh verification of the changed state produces the honest verdict", async () => {
    const dir = repo();
    const first = await verify(dir, "m10a");
    fs.writeFileSync(path.join(dir, "src.js"), "module.exports = { value: 2 };\n");
    expectStaleBlock("reverify_before", attemptCompletion(dir, first));
    const second = await verify(dir, "m10b");
    expect(second.requiredPassed).toBe(false);
    const decision = attemptCompletion(dir, second);
    expect(decision.outcome).toBe("failed");
    fs.writeFileSync(path.join(dir, "src.js"), "module.exports = { value: 1 };\n");
    const third = await verify(dir, "m10c");
    expect(attemptCompletion(dir, third).outcome).toBe("completed");
    recordR21Evidence("forgeverify-stale-evidence-matrix", { scenario: "reverify_cycle", verdicts: ["blocked", decision.outcome, "completed"] });
  }, 30_000);
});
