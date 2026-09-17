import {
  runVerification,
  runVerificationWithControlledReuse,
  type ReuseTrialMode,
  type Verifier,
  type VerificationReport,
} from "@codeforge/workflow";
import type { GenericVerificationEvidence } from "@codeforge/forge-green";
import { disposeFixture, materializeFixture, type CampaignFixture, type FixtureFileSet } from "../fixtures.js";
import { buildTrialReceipt, type TrialReceipt } from "./trial-receipt.js";

function nodeCheckCommand(relPath: string): string {
  return `node --check ${relPath}`;
}

export interface ExtraVerifierSpec {
  id: string;
  relPath: string;
}

export interface TrialCaseSpec {
  id: string;
  category: TrialReceipt["category"];
  invalidationReason?: string;
  fixtureFileSet: FixtureFileSet;
  verifierId: string;
  verifierRelPath: string;
  /** Applied to the treatment fixture between baseline evidence production and the treatment
   * run. Control never sees this — it always runs against an independently materialized,
   * unmutated fixture (spec §12: paired runs must not let control mutate treatment inputs, and
   * vice versa). */
  mutate?: (fixture: CampaignFixture) => Promise<void>;
  /** Treatment's primary verifier command differs from the one that produced baseline evidence
   * (command/definition-digest-changed cases). Control always uses the ORIGINAL command. */
  treatmentCommandOverride?: string;
  /** Treatment plan includes this additional required verifier, absent from baseline (new
   * obligation / policy-changed / plan-changed-materially cases) — proves partial reuse
   * (amendment §2): the primary verifier still reuses, the extra one executes fresh. */
  extraRequiredVerifier?: ExtraVerifierSpec;
  /** Baseline verifier itself is expected to produce FAILED evidence (prior-failed-evidence
   * case) — that evidence must never be reused, fresh execution must occur. */
  expectBaselineFailure?: boolean;
  expectPrimaryReuse: boolean;
  diversityDimensions: Record<string, string>;
}

export interface TrialCaseResult {
  spec: TrialCaseSpec;
  receipt: TrialReceipt;
  passed: boolean;
  failureReasons: string[];
}

function verifierList(spec: TrialCaseSpec, command: string): Verifier[] {
  const list: Verifier[] = [{ id: spec.verifierId, kind: "lint", command, required: true, source: "configured" }];
  if (spec.extraRequiredVerifier) {
    list.push({ id: spec.extraRequiredVerifier.id, kind: "lint", command: nodeCheckCommand(spec.extraRequiredVerifier.relPath), required: true, source: "configured" });
  }
  return list;
}

/**
 * Runs one control/treatment pair on two INDEPENDENTLY materialized, byte-identical fixtures
 * (spec §11/§12). Control is plain `runVerification` (always fresh). Treatment is
 * `runVerificationWithControlledReuse` fed real prior evidence produced on the treatment
 * fixture's own earlier state.
 */
export async function runTrialCase(spec: TrialCaseSpec, mode: ReuseTrialMode = "CONTROLLED_ACTIVE_TRIAL"): Promise<TrialCaseResult> {
  const failureReasons: string[] = [];
  const controlFixture = await materializeFixture(spec.fixtureFileSet);
  const treatmentFixture = await materializeFixture(spec.fixtureFileSet);
  try {
    const baselineCommand = nodeCheckCommand(spec.verifierRelPath);
    const baselineReport = await runVerification(treatmentFixture.root, [{ id: spec.verifierId, kind: "lint", command: baselineCommand, required: true, source: "configured" }]);
    const baselineEvidence = baselineReport.forgeVerify?.evidence[0];
    if (!baselineEvidence) throw new Error(`${spec.id}: baseline evidence was not produced`);
    if (spec.expectBaselineFailure && baselineEvidence.status !== "failed") failureReasons.push(`expected baseline evidence status "failed", got "${baselineEvidence.status}"`);
    if (!spec.expectBaselineFailure && baselineEvidence.status !== "passed") failureReasons.push(`expected baseline evidence status "passed", got "${baselineEvidence.status}"`);

    if (spec.mutate) await spec.mutate(treatmentFixture);

    const treatmentCommand = spec.treatmentCommandOverride ?? baselineCommand;
    const verifiers = verifierList(spec, treatmentCommand);

    const controlStart = Date.now();
    const controlReport: VerificationReport = await runVerification(controlFixture.root, verifiers);
    const controlDurationMs = Date.now() - controlStart;

    const treatmentStart = Date.now();
    const outcome = await runVerificationWithControlledReuse(treatmentFixture.root, verifiers, {
      priorEvidence: [baselineEvidence as unknown as GenericVerificationEvidence],
      mode,
    });
    const treatmentDurationMs = Date.now() - treatmentStart;

    const primaryVerifierResult = outcome.report.verifiers.find((v) => v.id === spec.verifierId);
    const actuallyReusedPrimary = Boolean(primaryVerifierResult?.reusedEvidenceId);
    if (actuallyReusedPrimary !== spec.expectPrimaryReuse) {
      failureReasons.push(`expected primary reuse=${spec.expectPrimaryReuse}, got ${actuallyReusedPrimary}`);
    }
    if (actuallyReusedPrimary && primaryVerifierResult!.reusedEvidenceId !== baselineEvidence.evidenceId) {
      failureReasons.push("reused evidence id did not match baseline evidence id");
    }
    if (spec.extraRequiredVerifier) {
      const extraResult = outcome.report.verifiers.find((v) => v.id === spec.extraRequiredVerifier!.id);
      if (!extraResult || extraResult.reusedEvidenceId) failureReasons.push("expected the extra/new obligation verifier to execute fresh, not reuse");
    }

    // Coverage equivalence (amendment §2): control and treatment must plan the SAME verifier
    // ids/versions/definition digests, and treatment must reach full required coverage exactly
    // like control does (whether via reuse or fresh execution).
    const controlPlanned = controlReport.forgeVerify?.plan.verifiers.map((v) => `${v.verifierId}:${v.verifierVersion}:${v.definitionDigest}`).sort() ?? [];
    const treatmentPlanned = outcome.report.forgeVerify?.plan.verifiers.map((v) => `${v.verifierId}:${v.verifierVersion}:${v.definitionDigest}`).sort() ?? [];
    if (JSON.stringify(controlPlanned) !== JSON.stringify(treatmentPlanned)) {
      failureReasons.push("control/treatment planned verifier identity diverged");
    }
    if (controlReport.requiredPassed !== outcome.report.requiredPassed && !spec.expectBaselineFailure) {
      failureReasons.push(`control requiredPassed=${controlReport.requiredPassed} but treatment requiredPassed=${outcome.report.requiredPassed}`);
    }
    if (controlReport.forgeVerify?.summary.verificationComplete !== outcome.report.forgeVerify?.summary.verificationComplete && !spec.expectBaselineFailure) {
      failureReasons.push("control/treatment verificationComplete diverged");
    }

    const receipt = buildTrialReceipt({
      runId: `${spec.id}-${Date.now().toString(36)}`,
      caseId: spec.id,
      category: spec.category,
      invalidationReason: spec.invalidationReason,
      mode,
      priorEvidence: [baselineEvidence],
      reuseRequest: outcome.reuseRequest,
      fallbackReason: outcome.fallbackReason,
      treatmentReport: outcome.report,
      controlReport,
      controlDurationMs,
      treatmentDurationMs,
    });

    return { spec, receipt, passed: failureReasons.length === 0, failureReasons };
  } finally {
    await disposeFixture(controlFixture);
    await disposeFixture(treatmentFixture);
  }
}
