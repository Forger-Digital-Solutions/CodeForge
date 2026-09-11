import path from "node:path";
import { describe, expect, it } from "vitest";
import { alternatingOrder, asGeneric, produceBaselineEvidence, runPair } from "../src/fg12e/pair-runner.js";
import { benchVerifiers, disposeBenchWorkspace, materializeBenchWorkspace, toVerifier } from "../src/fg12e/workloads.js";
import { buildInvalidationScenarios, definitionChangedCommand, runCompositionScenario, runInvalidationScenario, runPairedSeries } from "../src/fg12e/workload-runner.js";

const repoRoot = path.resolve(__dirname, "..", "..", "..");

describe("FG-12E pair runner — real paired control/treatment measurements", () => {
  it("alternates order across pairs (balanced ordering)", () => {
    expect([0, 1, 2, 3].map(alternatingOrder)).toEqual(["control-first", "treatment-first", "control-first", "treatment-first"]);
  });

  it("[full reuse] both orders record the order, avoid the real verifier process, and pass every safety check", async () => {
    const v = benchVerifiers(repoRoot);
    const control = materializeBenchWorkspace();
    const treatment = materializeBenchWorkspace();
    try {
      const verifier = toVerifier(v.syntaxCheck!);
      const baseline = await produceBaselineEvidence(treatment, [verifier]);
      expect(baseline.evidence).toHaveLength(1);
      expect(baseline.evidence[0]!.status).toBe("passed");

      for (const order of ["control-first", "treatment-first"] as const) {
        const receipt = await runPair({
          pairIndex: 0,
          scored: true,
          warm: "warm",
          order,
          workloadId: "test-full-reuse",
          expectedTier: "CHEAP",
          controlWorkspace: control,
          treatmentWorkspace: treatment,
          planVerifiers: [verifier],
          priorEvidence: asGeneric(baseline.evidence),
          expectedReusedVerifierIds: [verifier.id],
        });
        expect(receipt.order).toBe(order);
        expect(receipt.safety.passed, receipt.safety.failureReasons.join("; ")).toBe(true);
        expect(receipt.reuseExtent).toBe("full");
        expect(receipt.actualVerifierExecutionsAvoided).toBe(1);
        expect(receipt.treatment.freshAttempts).toBe(0);
        expect(receipt.control.freshAttempts).toBe(1);
        expect(receipt.control.verifierExecutionMs).toBeGreaterThan(0);
        expect(receipt.treatment.verifierExecutionMs).toBe(0);
        expect(receipt.treatment.reusedEvidenceIds).toEqual([baseline.evidence[0]!.evidenceId]);
        // Accounting identities.
        expect(receipt.netWallClockDeltaMs).toBeCloseTo(receipt.control.wallMs - receipt.treatment.wallMs, 2);
        expect(receipt.reuseCheckMs).toBeCloseTo(receipt.treatment.wallMs - (receipt.control.wallMs - receipt.control.verifierExecutionMs), 2);
        expect(receipt.verificationSavedReferenceMs).toBeGreaterThan(0);
        expect(receipt.verifierDefinitionDigests[Object.keys(receipt.verifierDefinitionDigests)[0]!]).toMatch(/^[0-9a-f]{64}$/);
      }
    } finally {
      disposeBenchWorkspace(control);
      disposeBenchWorkspace(treatment);
    }
  }, 60_000);

  it("[paired series] warmups are unscored/cold, scored pairs are warm, and state drift is detected as absent", async () => {
    const v = benchVerifiers(repoRoot);
    const control = materializeBenchWorkspace();
    const treatment = materializeBenchWorkspace();
    try {
      const verifier = toVerifier(v.syntaxCheck!);
      const series = await runPairedSeries({
        workloadId: "test-series",
        expectedTier: "CHEAP",
        control,
        treatment,
        baselineVerifiers: [verifier],
        planVerifiers: [verifier],
        expectedReusedVerifierIds: [verifier.id],
        warmupRepetitions: 1,
        scoredRepetitions: 2,
      });
      expect(series.warmupReceipts).toHaveLength(1);
      expect(series.warmupReceipts[0]!.scored).toBe(false);
      expect(series.warmupReceipts[0]!.warm).toBe("cold");
      expect(series.scoredReceipts).toHaveLength(2);
      expect(series.scoredReceipts.every((r) => r.scored && r.warm === "warm")).toBe(true);
      expect(series.scoredReceipts.map((r) => r.order)).toEqual(["treatment-first", "control-first"]);
      expect(series.stateDrift.drifted).toBe(false);
      expect(series.baseline.coldVerifierElapsedMs).toBeGreaterThan(0);
    } finally {
      disposeBenchWorkspace(control);
      disposeBenchWorkspace(treatment);
    }
  }, 60_000);

  it("[partial reuse] a real definition change on one of two verifiers: the other reuses, the changed one executes fresh, coverage complete, weighted share computed", async () => {
    const v = benchVerifiers(repoRoot);
    const result = await runCompositionScenario({
      id: "test-partial",
      label: "test partial",
      verifiers: [v.syntaxCheck!, v.singleUnitTest!],
      invalidatedVerifierIds: [v.singleUnitTest!.id],
      scoredRepetitions: 1,
      warmupRepetitions: 0,
    });
    expect(result.valid, result.invalidReasons.join("; ")).toBe(true);
    expect(result.countShareReusable).toBe(0.5);
    const receipt = result.scoredReceipts[0]!;
    expect(receipt.reuseExtent).toBe("partial");
    expect(receipt.treatment.reusedVerifierIds).toEqual([v.syntaxCheck!.id]);
    expect(receipt.treatment.freshAttempts).toBe(1);
    expect(receipt.treatment.verificationComplete).toBe(true);
    expect(receipt.control.freshAttempts).toBe(2);
    expect(result.weightedRuntimeShareReusable).toBeGreaterThan(0);
    expect(result.weightedRuntimeShareReusable).toBeLessThan(1);
  }, 60_000);

  it("definitionChangedCommand yields an equivalent-output command for each verifier family", () => {
    expect(definitionChangedCommand("node --test tests/a.test.ts")).toBe("node --test --test-reporter=tap tests/a.test.ts");
    expect(definitionChangedCommand("node --check src/a.ts")).toBe("node --stack-trace-limit=64 --check src/a.ts");
    expect(definitionChangedCommand("node x/node_modules/typescript/bin/tsc -p tsconfig.json --noEmit")).toContain("--pretty false");
    expect(() => definitionChangedCommand("npm test")).toThrow();
  });

  it("[invalidation, expensive verifier] source change forces fresh tsc in treatment; overhead is measured, not reused", async () => {
    const scenario = { ...buildInvalidationScenarios().find((s) => s.category === "source_changed")!, scoredRepetitions: 1, warmupRepetitions: 0 };
    const result = await runInvalidationScenario(scenario, repoRoot);
    expect(result.valid, result.invalidReasons.join("; ")).toBe(true);
    expect(result.freshVerificationAlwaysExecuted).toBe(true);
    const receipt = result.scoredReceipts[0]!;
    expect(receipt.treatment.freshAttempts).toBe(1);
    expect(receipt.actualVerifierExecutionsAvoided).toBe(0);
    expect(receipt.treatment.verifierExecutionMs).toBeGreaterThan(200);
    expect(receipt.safety.passed).toBe(true);
  }, 60_000);

  it("[invalidation, expensive verifier] real failed prior evidence is never reused and both arms fail equivalently", async () => {
    const scenario = { ...buildInvalidationScenarios().find((s) => s.category === "prior_failed_evidence")!, scoredRepetitions: 1, warmupRepetitions: 0 };
    const result = await runInvalidationScenario(scenario, repoRoot);
    expect(result.valid, result.invalidReasons.join("; ")).toBe(true);
    const receipt = result.scoredReceipts[0]!;
    expect(receipt.treatment.overallStatus).toBe("failed");
    expect(receipt.control.overallStatus).toBe("failed");
    expect(receipt.treatment.freshAttempts).toBe(1);
    expect(receipt.safety.noFailedEvidenceReused).toBe(true);
  }, 60_000);
});
