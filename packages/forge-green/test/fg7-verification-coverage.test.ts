import { describe, expect, it } from "vitest";
import {
  FORGE_GREEN_COVERAGE_POLICY_VERSION,
  FORGE_GREEN_VERIFICATION_POLICY_VERSION,
  evaluateVerificationCoverage,
  type VerificationCoverageEvidence,
  type VerificationObligation,
} from "../src/index.js";

const workspacePath = "/workspace/codeforge";

function obligation(overrides: Partial<VerificationObligation> = {}): VerificationObligation {
  return {
    id: "obligation.targeted-test",
    kind: "TARGETED_TEST",
    scope: "target",
    targetPaths: ["packages/example/test/example.test.ts"],
    required: true,
    reasonCodes: ["CANDIDATE_TESTS_PRESENT"],
    identity: {
      namespace: "test",
      workspacePath,
      obligationId: "obligation.targeted-test",
      policyVersion: FORGE_GREEN_VERIFICATION_POLICY_VERSION,
      revision: 4,
    },
    ...overrides,
  };
}

function evidence(overrides: Partial<VerificationCoverageEvidence> = {}): VerificationCoverageEvidence {
  return {
    evidenceId: "evidence-1",
    authority: "forgeverify",
    verifierId: "fixture-test",
    verifierVersion: "v1",
    definitionDigest: "definition-1",
    planId: "plan-1",
    attemptId: "attempt-1",
    runId: "run-1",
    evidenceHash: "hash-evidence-1",
    kind: "TARGETED_TEST",
    scope: "target",
    workspacePath,
    targetPaths: ["packages/example/test/example.test.ts"],
    status: "passed",
    exitCode: 0,
    inputStateHash: "state-4",
    executionRevision: 4,
    policyVersion: FORGE_GREEN_VERIFICATION_POLICY_VERSION,
    ...overrides,
  };
}

function run(obligations: readonly VerificationObligation[], evidenceItems: readonly VerificationCoverageEvidence[]) {
  return evaluateVerificationCoverage({
    obligations,
    evidence: evidenceItems,
    workspacePath,
    currentInputStateHash: "state-4",
    currentExecutionRevision: 4,
    trustedVerifierIds: ["fixture-test"],
  });
}

describe("FG-7 verification coverage authority", () => {
  it("covers a required obligation only with current, identity-bound evidence", () => {
    const result = run([obligation()], [evidence()]);

    expect(result.outcome).toBe("SUFFICIENT");
    expect(result.isSufficient).toBe(true);
    expect(result.receipt.coveragePolicyVersion).toBe(FORGE_GREEN_COVERAGE_POLICY_VERSION);
    expect(result.receipt.coveredRequiredObligationCount).toBe(1);
  });

  it("does not treat a selected test or broad command as target coverage", () => {
    const result = run([obligation()], [evidence({ targetPaths: ["packages/other/test/other.test.ts"], command: "npm test packages/example/test/example.test.ts" })]);

    expect(result.outcome).toBe("INSUFFICIENT");
    expect(result.receipt.entries[0]?.status).toBe("incompatible");
    expect(result.receipt.entries[0]?.reasonCodes).toContain("TARGET_COVERAGE_MISSING");
  });

  it("rejects stale input, revision, and policy identities instead of reusing a pass", () => {
    const result = run([obligation()], [evidence({ inputStateHash: "old-state", executionRevision: 3 })]);

    expect(result.outcome).toBe("STALE");
    expect(result.receipt.entries[0]?.status).toBe("stale");
    expect(result.receipt.entries[0]?.reasonCodes).toContain("STALE_INPUT_STATE");
  });

  it("keeps failed current evidence blocking and never turns it into a pass", () => {
    const result = run([obligation()], [evidence({ status: "failed", exitCode: 1 })]);

    expect(result.outcome).toBe("BLOCKED");
    expect(result.isSufficient).toBe(false);
    expect(result.receipt.reasonCodes).toContain("REQUIRED_EVIDENCE_FAILED");
  });

  it("allows an explicit producer claim while still enforcing identity and scope", () => {
    const result = run([obligation({ targetPaths: undefined })], [evidence({
      obligationIds: ["obligation.targeted-test"],
      targetPaths: undefined,
    })]);

    expect(result.outcome).toBe("SUFFICIENT");
    expect(result.coveredObligationIds).toEqual(["obligation.targeted-test"]);
  });

  it("does not let an optional uncovered obligation downgrade required coverage", () => {
    const result = run([
      obligation(),
      obligation({ id: "obligation.optional", required: false, targetPaths: ["packages/example/test/optional.test.ts"] }),
    ], [evidence()]);

    expect(result.outcome).toBe("SUFFICIENT");
    expect(result.receipt.entries.find((entry) => entry.obligationId === "obligation.optional")?.status).toBe("incompatible");
    expect(result.receipt.reasonCodes).toContain("OPTIONAL_OBLIGATION_UNCOVERED");
  });

  it("returns a distinct empty-obligation result without creating authority fields", () => {
    const result = run([], []);

    expect(result.outcome).toBe("SUFFICIENT");
    expect(result.receipt.reasonCodes).toContain("NO_OBLIGATIONS");
    expect(result.receipt).not.toHaveProperty("approval");
    expect(result.receipt).not.toHaveProperty("completion");
  });

  it("rejects evidence from an untrusted producer even when its command and hashes look current", () => {
    const result = run([obligation()], [evidence({ authority: undefined })]);

    expect(result.outcome).toBe("INSUFFICIENT");
    expect(result.receipt.entries[0]?.status).toBe("incompatible");
    expect(result.receipt.reasonCodes).toContain("UNTRUSTED_EVIDENCE_SOURCE");
  });

  it("suppresses duplicate observations by immutable evidence identity", () => {
    const result = run([obligation()], [
      evidence(),
      evidence({ evidenceId: "evidence-duplicate" }),
    ]);

    expect(result.outcome).toBe("SUFFICIENT");
    expect(result.receipt.metrics.duplicateObservations).toBe(1);
    expect(result.receipt.reasonCodes).toContain("DUPLICATE_EVIDENCE_SUPPRESSED");
  });

  it("treats scope and requirement changes as incompatible coverage", () => {
    const scopeChanged = run([obligation({ scope: "package" })], [evidence()]);
    const requirementChanged = run([obligation({ id: "obligation.changed", targetPaths: ["packages/example/test/other.test.ts"] })], [evidence()]);

    expect(scopeChanged.outcome).toBe("INSUFFICIENT");
    expect(scopeChanged.receipt.entries[0]?.reasonCodes).toContain("EVIDENCE_SCOPE_MISMATCH");
    expect(requirementChanged.outcome).toBe("INSUFFICIENT");
    expect(requirementChanged.receipt.entries[0]?.reasonCodes).toContain("TARGET_COVERAGE_MISSING");
  });

  it("keeps partial coverage insufficient and records the gap", () => {
    const result = run([
      obligation(),
      obligation({ id: "obligation.second", targetPaths: ["packages/example/test/other.test.ts"] }),
    ], [evidence()]);

    expect(result.outcome).toBe("INSUFFICIENT");
    expect(result.receipt.coveredRequiredObligationCount).toBe(1);
    expect(result.receipt.missingRequiredObligationIds).toEqual(["obligation.second"]);
    expect(result.receipt.metrics.partialCoverageCount).toBe(1);
  });

  it("allows a fresh superseding pass while retaining stale invalidation telemetry", () => {
    const result = run([obligation()], [
      evidence({ evidenceId: "evidence-old", evidenceHash: "hash-old", inputStateHash: "old-state" }),
      evidence({ evidenceId: "evidence-current", evidenceHash: "hash-current" }),
    ]);

    expect(result.outcome).toBe("SUFFICIENT");
    expect(result.receipt.coveredEvidenceIds).toEqual(["evidence-current"]);
    expect(result.receipt.metrics.invalidationReasons).toContain("STALE_INPUT_STATE");
  });
});
