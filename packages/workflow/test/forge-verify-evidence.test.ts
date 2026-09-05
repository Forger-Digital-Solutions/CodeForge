import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
    defaultRequirement: requirement, timeoutMs: 2_000, maxAttempts: 1, supportedScopes: ["workspace"],
  };
}

describe("ForgeVerify evidence graph", () => {
  let workspace: string;
  beforeEach(async () => { workspace = await mkdtemp(join(tmpdir(), "forgeverify-evidence-")); });
  afterEach(async () => { await rm(workspace, { recursive: true, force: true }); });

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
