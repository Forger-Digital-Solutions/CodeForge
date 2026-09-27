#!/usr/bin/env node
// Deterministically verifies the frozen E3 artifact without issuing another paid model call.
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import {
  createVerificationInputStateHash,
  evaluateCompletion,
  runVerification,
} from "../packages/workflow/dist/index.js";

const evidencePath = path.resolve("docs/evidence/r48-role-routing/R48-16BIT-ROLE-MISSION.json");
const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
if (evidence.finalStatus) {
  throw new Error(`Refusing to replace existing completion evidence (${evidence.finalStatus}).`);
}

const byPhase = Object.fromEntries(evidence.phases.map((phase) => [phase.phase, phase]));
const coder = byPhase["coder-selection"];
const reviewer = byPhase["reviewer-independence"];
if (!coder || !reviewer || typeof evidence.mathFile !== "string") {
  throw new Error("Frozen E3 evidence is missing the Coder, Reviewer, or math artifact.");
}

const repoDir = mkdtempSync(path.join(os.tmpdir(), "r48-paid-finalize-"));
try {
  execFileSync("git", ["init", "-b", "main"], { cwd: repoDir });
  execFileSync("git", ["config", "user.name", "CodeForge Agent"], { cwd: repoDir });
  execFileSync("git", ["config", "user.email", "agent@codeforge.local"], { cwd: repoDir });
  writeFileSync(path.join(repoDir, "package.json"), JSON.stringify({ name: "r48-math-lib", version: "1.0.0", type: "module" }));
  writeFileSync(path.join(repoDir, "math.mjs"), "export function multiply(a, b) { return 0; }\n");
  mkdirSync(path.join(repoDir, "test"));
  writeFileSync(path.join(repoDir, "test", "math.test.mjs"), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { multiply } from '../math.mjs';\ntest('multiply', () => assert.equal(multiply(6, 7), 42));\n");
  execFileSync("git", ["add", "."], { cwd: repoDir });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repoDir });

  writeFileSync(path.join(repoDir, "math.mjs"), evidence.mathFile);
  const diff = execFileSync("git", ["diff", "HEAD", "--", "math.mjs"], { cwd: repoDir, encoding: "utf8" });
  const numstat = execFileSync("git", ["diff", "--numstat", "HEAD", "--", "math.mjs"], { cwd: repoDir, encoding: "utf8" }).trim().split(/\s+/);
  const beforeHash = execFileSync("git", ["rev-parse", "HEAD:math.mjs"], { cwd: repoDir, encoding: "utf8" }).trim();
  const afterHash = execFileSync("git", ["hash-object", "math.mjs"], { cwd: repoDir, encoding: "utf8" }).trim();
  const reviewerPassed = reviewer.status === "completed" && (
    /REVIEW_VERDICT:\s*PASS/i.test(reviewer.summary) ||
    /"verdict"\s*:\s*"pass"/i.test(reviewer.summary)
  );
  const independentReviewer = Boolean(coder.routePoolId && reviewer.routePoolId && coder.routePoolId !== reviewer.routePoolId);
  const reviewFindings = [];
  if (!reviewerPassed) {
    reviewFindings.push({
      code: reviewer.status === "completed" ? "goal_not_satisfied" : "goal_review_inconclusive",
      severity: "blocking",
      path: "math.mjs",
      message: reviewer.status === "completed"
        ? "The frozen independent review did not contain a PASS verdict."
        : "The frozen independent reviewer run did not complete.",
    });
  }
  if (!independentReviewer) {
    reviewFindings.push({
      code: "goal_not_satisfied",
      severity: "blocking",
      path: "math.mjs",
      message: "The reviewer did not serve from a physical route independent of the implementer.",
    });
  }

  if (diff) execFileSync("git", ["add", "--", "math.mjs"], { cwd: repoDir });
  const verification = await runVerification(repoDir, [{
    id: "r48-math-test",
    kind: "test",
    command: "node --test test/math.test.mjs",
    required: true,
    source: "configured",
  }], {
    runId: "r48-paid-completion",
    executionRevision: 1,
    changedPaths: ["math.mjs"],
  });
  const plan = {
    id: "r48-paid-plan",
    title: "Implement and verify multiply",
    taskId: "r48-paid-mission",
    status: "approved",
    revision: 1,
    createdAt: evidence.startedAt,
    updatedAt: new Date().toISOString(),
    steps: [
      { id: "edit", description: "Implement multiply", status: coder.status === "completed" ? "completed" : "failed", kind: "edit", targetPath: "math.mjs", risk: "safe", requiresApproval: false },
      { id: "review", description: "Independent review", status: reviewerPassed && independentReviewer ? "completed" : "failed", kind: "review", targetPath: "math.mjs", risk: "safe", requiresApproval: false },
      { id: "verify", description: "Run focused test", status: verification.requiredPassed ? "completed" : "failed", kind: "verify", command: "node --test test/math.test.mjs", risk: "safe", requiresApproval: false },
    ],
  };
  const analysis = {
    hasFailures: verification.hasFailures,
    summary: verification.summary,
    diagnostics: verification.failures.map((failure) => failure.message),
    suggestedRepairs: [],
    isRepairable: false,
  };
  const review = {
    approved: reviewFindings.length === 0,
    issues: reviewFindings.map((finding) => finding.message),
    findings: reviewFindings,
    diffs: diff ? [{
      path: "math.mjs",
      changeType: "modified",
      additions: Number(numstat[0] ?? 0),
      deletions: Number(numstat[1] ?? 0),
      diff,
      beforeHash,
      afterHash,
    }] : [],
    summary: reviewFindings.length === 0 ? "Frozen independent reviewer passed on a distinct physical route." : "Independent review requirements were not satisfied.",
  };
  const completion = evaluateCompletion({
    plan,
    verification,
    analysis,
    review,
    currentExecutionRevision: 1,
    verifiedExecutionRevision: 1,
    currentVerificationInputStateHash: createVerificationInputStateHash(repoDir),
  });

  let integration = { status: "retained", reason: completion.rationale };
  if (completion.outcome === "completed") {
    const verifiedTree = execFileSync("git", ["write-tree"], { cwd: repoDir, encoding: "utf8" }).trim();
    execFileSync("git", ["commit", "-m", "implement multiply"], { cwd: repoDir });
    const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim();
    const integratedTree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: repoDir, encoding: "utf8" }).trim();
    if (integratedTree !== verifiedTree) throw new Error("Integration changed the tree authorized by the completion gate.");
    integration = { status: "committed", revision, verifiedTree, integratedTree };
  }

  evidence.finalizedAt = new Date().toISOString();
  evidence.verificationSource = {
    mode: "reconstructed_from_frozen_mission_artifact",
    sourceGeneratedAt: evidence.generatedAt,
    providerCallsIssued: 0,
    artifact: "mathFile",
    testFixture: "scripts/r48-paid-mission.mjs",
  };
  evidence.verification = {
    overallStatus: verification.overallStatus,
    requiredPassed: verification.requiredPassed,
    passed: verification.passed,
    failed: verification.failed,
    skipped: verification.skipped,
    durationMs: verification.durationMs,
    inputStateHash: verification.inputStateHash,
    verifiers: verification.verifiers,
    forgeVerify: {
      planId: verification.forgeVerify?.plan.planId ?? null,
      verificationComplete: verification.forgeVerify?.summary.verificationComplete ?? false,
      evidenceIds: verification.forgeVerify?.evidence.map((item) => item.evidenceId) ?? [],
    },
  };
  evidence.completion = completion;
  evidence.integration = integration;
  evidence.finalStatus = completion.outcome;
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`[r48-paid-finalize] verification=${verification.overallStatus} completion=${completion.outcome} integration=${integration.status}`);
  if (completion.outcome !== "completed" || integration.status !== "committed") {
    process.exitCode = 1;
  }
} finally {
  rmSync(repoDir, { recursive: true, force: true });
}
