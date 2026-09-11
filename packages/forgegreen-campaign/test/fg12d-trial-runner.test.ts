import { describe, expect, it } from "vitest";
import { runTrialCase, type TrialCaseSpec } from "../src/fg12d/trial-runner.js";
import { FIXTURE_FILE_SETS, mutateFixtureFile } from "../src/fixtures.js";

const BILLING = FIXTURE_FILE_SETS[0]!;

describe("FG-12D trial runner — real paired control/treatment cases", () => {
  it("[positive] identical state: treatment reuses, control/treatment coverage stays equivalent", async () => {
    const spec: TrialCaseSpec = {
      id: "trial-positive-identical",
      category: "positive",
      fixtureFileSet: BILLING,
      verifierId: "fg12d.trial.positive",
      verifierRelPath: "src/billing/invoice.ts",
      expectPrimaryReuse: true,
      diversityDimensions: { repositoryState: "billing-s1" },
    };
    const result = await runTrialCase(spec);
    expect(result.failureReasons).toEqual([]);
    expect(result.passed).toBe(true);
    expect(result.receipt.actual.verificationAttemptsAvoided).toBe(1);
    expect(result.receipt.finalOverallStatus).toBe("passed");
  }, 20_000);

  it("[invalidation] source changed: treatment must run fresh, never reuse stale evidence", async () => {
    const spec: TrialCaseSpec = {
      id: "trial-invalidation-source",
      category: "invalidation",
      invalidationReason: "source_changed",
      fixtureFileSet: BILLING,
      verifierId: "fg12d.trial.source",
      verifierRelPath: "src/billing/invoice.ts",
      mutate: async (fixture) => mutateFixtureFile(fixture, "src/billing/invoice.ts", "import { formatCurrency } from './currency.js';\nexport class Invoice {\n  total(amount: number): string { return formatCurrency(amount * 2); }\n}\n"),
      expectPrimaryReuse: false,
      diversityDimensions: { repositoryState: "billing-s1->s2" },
    };
    const result = await runTrialCase(spec);
    expect(result.failureReasons).toEqual([]);
    expect(result.receipt.actual.verificationAttemptsAvoided).toBe(0);
  }, 20_000);

  it("[invalidation, mixed-plan] new obligation added: primary reuses, the new verifier runs fresh (partial reuse — amendment §2)", async () => {
    const spec: TrialCaseSpec = {
      id: "trial-invalidation-new-obligation",
      category: "invalidation",
      invalidationReason: "new_obligation_added",
      fixtureFileSet: BILLING,
      verifierId: "fg12d.trial.newobl.primary",
      verifierRelPath: "src/billing/invoice.ts",
      extraRequiredVerifier: { id: "fg12d.trial.newobl.extra", relPath: "src/billing/currency.ts" },
      expectPrimaryReuse: true,
      diversityDimensions: { repositoryState: "billing-s1" },
    };
    const result = await runTrialCase(spec);
    expect(result.failureReasons).toEqual([]);
    expect(result.receipt.actuallyReusedEvidenceIds.length).toBe(1);
    expect(result.receipt.freshlyExecutedVerifierIds).toContain("fg12d.trial.newobl.extra");
  }, 20_000);

  it("[invalidation] prior failed evidence must never be reused", async () => {
    const spec: TrialCaseSpec = {
      id: "trial-invalidation-failed-evidence",
      category: "invalidation",
      invalidationReason: "prior_failed_evidence",
      fixtureFileSet: BILLING,
      verifierId: "fg12d.trial.failed",
      verifierRelPath: "src/billing/does-not-parse.js",
      expectBaselineFailure: true,
      expectPrimaryReuse: false,
      diversityDimensions: { repositoryState: "billing-broken" },
    };
    const result = await runTrialCase(spec);
    expect(result.failureReasons).toEqual([]);
    expect(result.passed).toBe(true);
    expect(result.receipt.actual.verificationAttemptsAvoided).toBe(0);
    expect(result.receipt.verifierOutcomes[0]!.status).toBe("failed");
  }, 20_000);
});
