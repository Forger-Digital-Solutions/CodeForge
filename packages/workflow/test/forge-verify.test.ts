import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverVerifiers,
  classifyVerifier,
  runVerification,
  verificationPassed,
  verificationFailed,
  evaluateCompletion,
  VerifierRegistry,
  createVerificationPlan,
  executeVerificationPlan,
  type WorkflowPlan,
  type FailureAnalysis,
  type ReviewDecision,
} from "../src/index.js";

function makeCleanPlan(): WorkflowPlan {
  return {
    id: "plan-1",
    title: "Test Plan",
    taskId: "task-1",
    status: "approved",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    steps: [
      {
        id: "step-1",
        description: "Implement feature",
        status: "completed",
        kind: "edit",
        targetPath: "src/feature.ts",
        risk: "safe",
        requiresApproval: false,
      },
    ],
  };
}

function makeCleanAnalysis(): FailureAnalysis {
  return {
    hasFailures: false,
    summary: "",
    diagnostics: [],
    suggestedRepairs: [],
    isRepairable: false,
  };
}

function makeCleanReview(): ReviewDecision {
  return {
    approved: true,
    risk: "safe",
    findings: [],
    comments: "Clean diff",
    issues: [],
    summary: "Clean diff",
    diffs: [
      {
        path: "src/feature.ts",
        changeType: "modified",
        additions: 5,
        deletions: 0,
        diff: "+ added line",
        beforeHash: "a1",
        afterHash: "b2",
      },
    ],
  };
}

describe("ForgeVerify — Structured Verifier Registry & Multi-Verifier Execution", () => {
  let ws: string;

  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), "cf-forgeverify-"));
  });

  afterEach(async () => {
    await rm(ws, { recursive: true, force: true });
  });

  it("classifies verifiers accurately into required and advisory kinds", () => {
    expect(classifyVerifier("npm test")).toEqual({ kind: "test", required: true });
    expect(classifyVerifier("vitest run")).toEqual({ kind: "test", required: true });
    expect(classifyVerifier("npm run typecheck")).toEqual({ kind: "typecheck", required: true });
    expect(classifyVerifier("tsc --noEmit")).toEqual({ kind: "typecheck", required: true });
    expect(classifyVerifier("npm run build")).toEqual({ kind: "build", required: true });
    expect(classifyVerifier("npm run lint")).toEqual({ kind: "lint", required: false });
    expect(classifyVerifier("eslint .")).toEqual({ kind: "lint", required: false });
    expect(classifyVerifier("node custom-check.js")).toEqual({ kind: "custom", required: true });
  });

  it("preserves Electron-as-Node for a structured verifier", async () => {
    Object.defineProperty(process.versions, "electron", { configurable: true, value: "test" });
    try {
      const registry = new VerifierRegistry();
      registry.register({
        id: "electron.node.environment",
        version: "test-v1",
        name: "Electron runtime environment",
        category: "custom",
        description: "Regression coverage for Electron verifier execution.",
        execution: {
          executable: process.execPath,
          args: ["-e", "process.exit(process.env.ELECTRON_RUN_AS_NODE === '1' ? 0 : 1)"],
        },
        defaultRequirement: "required",
        timeoutMs: 5_000,
        maxAttempts: 1,
        supportedScopes: ["workspace"],
      });
      const plan = createVerificationPlan(registry, { version: "test" }, {
        workspacePath: ws,
        scope: "workspace",
        runId: "electron-runtime-test",
      });
      const result = await executeVerificationPlan(registry, plan);
      expect(result.evidence[0]).toMatchObject({ status: "passed", exitCode: 0 });
    } finally {
      delete (process.versions as Record<string, string | undefined>).electron;
    }
  });

  it("discovers all declared verifiers from package.json manifest in canonical order", async () => {
    const pkg = {
      name: "test-pkg",
      scripts: {
        test: "node -e \"process.exit(0)\"",
        typecheck: "node -e \"process.exit(0)\"",
        build: "node -e \"process.exit(0)\"",
        lint: "node -e \"process.exit(0)\"",
      },
    };
    await writeFile(join(ws, "package.json"), JSON.stringify(pkg, null, 2));

    const verifiers = discoverVerifiers(ws);
    expect(verifiers).toHaveLength(4);
    expect(verifiers[0]).toMatchObject({ id: "test", kind: "test", required: true, command: "npm test" });
    expect(verifiers[1]).toMatchObject({ id: "typecheck", kind: "typecheck", required: true, command: "npm run typecheck" });
    expect(verifiers[2]).toMatchObject({ id: "build", kind: "build", required: true, command: "npm run build" });
    expect(verifiers[3]).toMatchObject({ id: "lint", kind: "lint", required: false, command: "npm run lint" });
  });

  it("executes ALL applicable verifiers and passes when all required verifiers succeed (even if advisory lint fails)", async () => {
    const pkg = {
      name: "test-pkg",
      scripts: {
        test: "node -e \"console.log('3 passed'); process.exit(0)\"",
        typecheck: "node -e \"console.log('typecheck OK'); process.exit(0)\"",
        build: "node -e \"console.log('build OK'); process.exit(0)\"",
        lint: "node -e \"console.error('lint warning: unused var'); process.exit(1)\"",
      },
    };
    await writeFile(join(ws, "package.json"), JSON.stringify(pkg, null, 2));

    const report = await runVerification(ws);
    expect(report.verifiers).toHaveLength(4);
    expect(report.requiredPassed).toBe(true);
    expect(report.hasFailures).toBe(true);
    expect(report.advisories).toHaveLength(1);
    expect(report.advisories[0]?.id).toBe("lint");
    expect(report.overallStatus).toBe("passed");
    expect(verificationPassed(report)).toBe(true);
    expect(verificationFailed(report)).toBe(false);

    // Completion Gate evaluation
    const decision = evaluateCompletion({
      plan: makeCleanPlan(),
      verification: report,
      analysis: makeCleanAnalysis(),
      review: makeCleanReview(),
    });

    expect(decision.outcome).toBe("completed");
    expect(decision.advisories).toHaveLength(1);
    expect(decision.advisories[0]?.message).toContain("Advisory verifier 'lint'");
  });

  it("fails closed when any required verifier fails (test passes, typecheck fails)", async () => {
    const pkg = {
      name: "test-pkg",
      scripts: {
        test: "node -e \"console.log('5 passed'); process.exit(0)\"",
        typecheck: "node -e \"console.error('Type error in src/feature.ts'); process.exit(1)\"",
        build: "node -e \"process.exit(0)\"",
      },
    };
    await writeFile(join(ws, "package.json"), JSON.stringify(pkg, null, 2));

    const report = await runVerification(ws);
    expect(report.verifiers).toHaveLength(3);
    expect(report.requiredPassed).toBe(false);
    expect(report.hasFailures).toBe(true);
    expect(report.overallStatus).toBe("failed");
    expect(verificationPassed(report)).toBe(false);
    expect(verificationFailed(report)).toBe(true);

    // Completion Gate evaluation MUST reject completion
    const decision = evaluateCompletion({
      plan: makeCleanPlan(),
      verification: report,
      analysis: {
        hasFailures: true,
        summary: "Type error in feature.ts",
        diagnostics: ["Type error"],
        suggestedRepairs: [],
        isRepairable: true,
      },
      review: makeCleanReview(),
    });

    expect(decision.outcome).toBe("failed");
    const blocker = decision.blockers.find((b) => b.code === "verification_failed");
    expect(blocker).toBeDefined();
    expect(blocker?.message).toContain("Required verifier 'typecheck'");
  });

  it("returns blocked with honest notConfigured when workspace has no runnable verifiers", async () => {
    await writeFile(join(ws, "package.json"), JSON.stringify({ name: "empty-scripts" }));

    const report = await runVerification(ws);
    expect(report.notConfigured).toBe(true);
    expect(report.overallStatus).toBe("blocked");
    expect(report.verifiers).toHaveLength(0);
    expect(verificationPassed(report)).toBe(false);

    const decision = evaluateCompletion({
      plan: makeCleanPlan(),
      verification: report,
      analysis: makeCleanAnalysis(),
      review: makeCleanReview(),
    });

    expect(decision.outcome).toBe("blocked");
    expect(decision.blockers[0]?.code).toBe("verification_not_run");
  });
});
