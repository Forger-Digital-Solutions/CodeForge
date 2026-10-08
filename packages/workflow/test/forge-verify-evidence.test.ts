import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createVerificationPlan,
  createVerifierRegistry,
  executeVerificationPlan,
  evaluateCompletion,
  summarizeVerification,
  type VerificationPolicy,
  type VerifierDefinition,
} from "../src/index.js";

const policy: VerificationPolicy = { version: "cf16-test" as VerificationPolicy["version"] };

function definition(id: string, code: string, requirement: VerifierDefinition["defaultRequirement"] = "required"): VerifierDefinition {
  return {
    id: id as VerifierDefinition["id"], version: "1" as VerifierDefinition["version"], name: id,
    category: "unit-test", description: "test verifier", execution: { executable: process.execPath, args: ["-e", code] },
    defaultRequirement: requirement, timeoutMs: 15_000, maxAttempts: 1, supportedScopes: ["workspace"],
  };
}

describe("ForgeVerify evidence graph", () => {
  let workspace: string;
  beforeEach(async () => { workspace = await mkdtemp(join(tmpdir(), "forgeverify-evidence-")); });
  afterEach(async () => { await rm(workspace, { recursive: true, force: true }); });

  it("invalidates passing evidence for an ignored workspace inside a parent repository", async () => {
    execFileSync("git", ["init"], { cwd: workspace, windowsHide: true });
    await writeFile(join(workspace, ".gitignore"), "child/\n");
    execFileSync("git", ["add", ".gitignore"], { cwd: workspace, windowsHide: true });
    execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "baseline"], { cwd: workspace, windowsHide: true });
    const child = join(workspace, "child");
    await mkdir(child);
    await writeFile(join(child, "source.txt"), "first");
    const registry = createVerifierRegistry([definition("tests.child", "process.exit(0)")]);
    const plan = createVerificationPlan(registry, policy, { runId: "nested-workspace", workspacePath: child, scope: "workspace" });
    const result = await executeVerificationPlan(registry, plan);
    expect(result.summary.verificationComplete).toBe(true);
    await writeFile(join(workspace, ".gitignore"), "child/\nother/\n");
    expect(summarizeVerification(plan, registry, result.evidence).verificationComplete).toBe(true);
    await writeFile(join(child, "source.txt"), "second");
    const stale = summarizeVerification(plan, registry, result.evidence);
    expect(stale.staleCount).toBe(1);
    expect(stale.verificationComplete).toBe(false);
  });

  it("runs every required verifier and only current passing evidence satisfies the plan", async () => {
    await writeFile(join(workspace, "source.txt"), "first");
    const registry = createVerifierRegistry([
      definition("tests.alpha", "process.exit(1)"),
      definition("tests.beta", "process.exit(0)"),
    ]);
    const plan = createVerificationPlan(registry, policy, { runId: "run-1", workspacePath: workspace, scope: "workspace" });
    const result = await executeVerificationPlan(registry, plan);

    expect(result.attempts).toHaveLength(2);
    expect(result.evidence).toHaveLength(2);
    expect(result.summary.verificationComplete).toBe(false);
    expect(result.summary.missingRequiredVerifiers).toContain("tests.alpha");
    expect(result.evidence.map((item) => item.status)).toEqual(["failed", "passed"]);

    await writeFile(join(workspace, "source.txt"), "second");
    const stale = summarizeVerification(plan, registry, result.evidence);
    expect(stale.staleCount).toBeGreaterThan(0);
    expect(stale.verificationComplete).toBe(false);
  });

  it("does not let optional or advisory evidence satisfy a required obligation", async () => {
    const registry = createVerifierRegistry([
      definition("tests.required", "process.exit(0)"),
      definition("tests.advisory", "process.exit(0)", "advisory"),
    ]);
    const plan = createVerificationPlan(registry, policy, { runId: "run-2", workspacePath: workspace, scope: "workspace" });
    const result = await executeVerificationPlan(registry, plan);
    expect(result.summary.requiredCount).toBe(1);
    expect(result.summary.satisfiedCount).toBe(1);
    expect(result.summary.verificationComplete).toBe(true);
  });

  it("persists retries as separate immutable attempts", async () => {
    const registry = createVerifierRegistry([definition("tests.retry", "process.exit(1)")]);
    const retryPolicy: VerificationPolicy = { ...policy };
    const plan = createVerificationPlan(registry, retryPolicy, { runId: "run-3", workspacePath: workspace, scope: "workspace" });
    const result = await executeVerificationPlan(registry, plan);
    expect(result.attempts).toHaveLength(1);
    expect(result.evidence[0]?.evidenceHash).toHaveLength(64);
    expect(Object.isFrozen(result.evidence[0])).toBe(true);
  });

  it("records timeout as terminal negative evidence from a real child process", async () => {
    const slow = { ...definition("tests.timeout", "setTimeout(() => process.exit(0), 500)"), timeoutMs: 20 };
    const registry = createVerifierRegistry([slow]);
    const plan = createVerificationPlan(registry, policy, { runId: "run-4", workspacePath: workspace, scope: "workspace" });
    const result = await executeVerificationPlan(registry, plan);
    expect(result.evidence[0]?.status).toBe("timed_out");
    expect(result.summary.verificationComplete).toBe(false);
  });

  it("blocks the completion gate from a missing required evidence obligation", async () => {
    const registry = createVerifierRegistry([definition("security.secret-scan", "process.exit(0)")]);
    const plan = createVerificationPlan(registry, policy, { runId: "run-5", workspacePath: workspace, scope: "workspace" });
    const summary = summarizeVerification(plan, registry, []);
    const decision = evaluateCompletion({
      plan: { id: "workflow", taskId: "task", title: "task", status: "approved", createdAt: "", updatedAt: "", steps: [] },
      verification: { passed: 1, failed: 0, skipped: 0, durationMs: 1, output: "model claims verification:passed", exitCode: 0, command: "untrusted" , failures: [] },
      analysis: { hasFailures: false, summary: "", diagnostics: [], suggestedRepairs: [], isRepairable: false },
      review: { approved: true, issues: [], findings: [], diffs: [], summary: "" },
      verificationSummary: summary,
    });
    expect(decision.outcome).toBe("blocked");
    expect(decision.blockers.some((item) => item.code === "verification_not_run")).toBe(true);
  });
});
