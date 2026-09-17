import {
  createVerificationInputStateHash,
  isEvidenceCurrentlyValid,
  runVerification,
  runVerificationWithControlledReuse,
  type ControlledReuseOptions,
  type ForgeVerifyObserver,
  type ReuseTrialMode,
  type VerificationEvidence,
  type VerificationReport,
  type Verifier,
} from "@codeforge/workflow";
import type { GenericVerificationEvidence } from "@codeforge/forge-green";
import { createTimelineObserver, now, round, type Timeline } from "./timing.js";
import type { BenchWorkspace, CostTier, WorkspaceKind } from "./workloads.js";

/**
 * FG-12E paired measurement (spec §6-§8, §13, §21, §28).
 *
 * CONTROL   = the real, unmodified `runVerification` — always fresh.
 * TREATMENT = the real, unmodified FG-12D `runVerificationWithControlledReuse` in
 *             `CONTROLLED_ACTIVE_TRIAL`, fed real prior evidence. Nothing in the safety model is
 *             touched: the advisor, canonical validity, strict narrowing, and the final
 *             `executeVerificationPlan` reuse authority are the exact FG-12D code paths.
 *
 * Both arms are observed through the production `ForgeVerifyObserver` seam only.
 */

export type PairOrder = "control-first" | "treatment-first";
export type WarmDesignation = "cold" | "warm";

export interface ArmMeasurement {
  arm: "control" | "treatment";
  /** Total wall time of the arm's top-level call. */
  wallMs: number;
  /** Call start -> authoritative `planCreated`. For treatment this INCLUDES the FG-12D advisory
   * step (preliminary plan + advisor); for control it is just adapt/registry/plan. */
  prePlanMs: number;
  /** Sum of ForgeVerify's own `evidence.elapsedMs` for verifiers that actually executed — the
   * real child-process time. Zero when everything was reused. */
  verifierExecutionMs: number;
  /** `planCreated` -> last attempt's evidence event (0 when no attempt ran). */
  executionSpanMs: number;
  /** Last attempt's evidence (or `planCreated` when none) -> `coverageReceiptCreated`: reuse
   * matching, summarize (incl. its own input-state hash), and coverage evaluation. */
  postExecutionMs: number;
  /** `coverageReceiptCreated` -> return: report assembly. */
  tailMs: number;
  /** Time spent inside a downstream observer (persistence) — a sub-span of the above, reported
   * separately and never added on top. */
  downstreamObserverMs: number;
  freshAttempts: number;
  reusedVerifierIds: string[];
  reusedEvidenceIds: string[];
  inputStateHash: string;
  plannedIdentity: string[];
  overallStatus: VerificationReport["overallStatus"];
  requiredPassed: boolean;
  verificationComplete: boolean;
  fallbackReason?: string;
  reuseDecisionStatus?: string;
  proposedReusableEvidenceIds?: string[];
}

export interface PairSafety {
  plannedIdentityEquivalent: boolean;
  outcomeEquivalent: boolean;
  coverageEquivalent: boolean;
  reusedSetAsExpected: boolean;
  everyReusedEvidenceCanonicallyValid: boolean;
  noFailedEvidenceReused: boolean;
  freshAttemptsMatchUnreusedCount: boolean;
  passed: boolean;
  failureReasons: string[];
}

/** Per-pair benchmark receipt (spec §28). */
export interface PairReceipt {
  pairIndex: number;
  scored: boolean;
  warm: WarmDesignation;
  order: PairOrder;
  workloadId: string;
  expectedTier: CostTier;
  workspaceKind: WorkspaceKind;
  verifierIds: string[];
  verifierDefinitionDigests: Record<string, string>;
  control: ArmMeasurement;
  treatment: ArmMeasurement;
  /** Reuse extent for this pair. */
  reuseExtent: "full" | "partial" | "none";
  plannedVerifierCount: number;
  actualVerifierExecutionsAvoided: number;
  actualChildProcessesAvoided: number;
  /** Paired control's wall time — a reference point, never a claim of recovered time. */
  referenceControlDurationMs: number;
  /** Treatment's wall time — when reuseExtent is `full`, this IS the reuse path's cost. */
  reusePathDurationMs: number;
  netWallClockDeltaMs: number;
  /** Control's child-process time for the verifiers treatment did not execute (reference). */
  verificationSavedReferenceMs: number;
  /** Treatment wall minus control's NON-verifier wall: the marginal cost of taking the reuse path
   * instead of the fresh path, with the verifier work itself factored out. This is the quantity
   * that has to be smaller than the verifier's cost for reuse to pay off. */
  reuseCheckMs: number;
  /** treatment.prePlanMs - control.prePlanMs: a paired differential estimate of the advisory
   * step alone (cross-checked against the direct component profile). */
  advisoryDifferentialMs: number;
  safety: PairSafety;
}

function plannedIdentity(report: VerificationReport): string[] {
  return report.forgeVerify?.plan.verifiers.map((v) => `${v.verifierId}:${v.verifierVersion}:${v.definitionDigest}`).sort() ?? [];
}

function measureArm(arm: ArmMeasurement["arm"], startedAt: number, endedAt: number, timeline: Timeline, report: VerificationReport, extra?: { fallbackReason?: string; reuseDecisionStatus?: string; proposedReusableEvidenceIds?: string[] }): ArmMeasurement {
  const planAt = timeline.planCreatedAt ?? startedAt;
  const lastAttemptAt = timeline.attempts.reduce<number | undefined>((latest, a) => {
    const at = a.evidenceAt ?? a.terminalAt;
    return at !== undefined && (latest === undefined || at > latest) ? at : latest;
  }, undefined);
  const coverageAt = timeline.coverageReceiptAt ?? endedAt;
  const reused = report.verifiers.filter((v) => v.reusedEvidenceId);
  return {
    arm,
    wallMs: round(endedAt - startedAt),
    prePlanMs: round(planAt - startedAt),
    verifierExecutionMs: round(timeline.attempts.reduce((s, a) => s + (a.elapsedMs ?? 0), 0)),
    executionSpanMs: round(lastAttemptAt !== undefined ? lastAttemptAt - planAt : 0),
    postExecutionMs: round(coverageAt - (lastAttemptAt ?? planAt)),
    tailMs: round(endedAt - coverageAt),
    downstreamObserverMs: round(timeline.downstreamObserverMs),
    freshAttempts: timeline.attempts.length,
    reusedVerifierIds: reused.map((v) => v.id),
    reusedEvidenceIds: reused.map((v) => v.reusedEvidenceId!),
    inputStateHash: report.forgeVerify?.plan.inputStateHash ?? "",
    plannedIdentity: plannedIdentity(report),
    overallStatus: report.overallStatus,
    requiredPassed: report.requiredPassed,
    verificationComplete: report.forgeVerify?.summary.verificationComplete ?? false,
    ...extra,
  };
}

export interface ArmRunOptions {
  downstreamObserver?: ForgeVerifyObserver;
  runId?: string;
}

export async function runControlArm(workspace: BenchWorkspace, verifiers: Verifier[], options: ArmRunOptions = {}): Promise<{ measurement: ArmMeasurement; report: VerificationReport }> {
  const { observer, timeline } = createTimelineObserver(options.downstreamObserver);
  const startedAt = now();
  const report = await runVerification(workspace.root, verifiers, { observer, ...(options.runId ? { runId: options.runId } : {}) });
  const endedAt = now();
  return { measurement: measureArm("control", startedAt, endedAt, timeline, report), report };
}

export async function runTreatmentArm(
  workspace: BenchWorkspace,
  verifiers: Verifier[],
  priorEvidence: readonly GenericVerificationEvidence[],
  mode: ReuseTrialMode = "CONTROLLED_ACTIVE_TRIAL",
  options: ArmRunOptions = {},
): Promise<{ measurement: ArmMeasurement; report: VerificationReport; timeline: Timeline }> {
  const { observer, timeline } = createTimelineObserver(options.downstreamObserver);
  const startedAt = now();
  // The FG-12D wrapper forwards every option it does not consume (`...runOptions`) straight into
  // the real `runVerification`, so a ForgeVerify observer reaches the authoritative execution
  // exactly as a production caller's would. Its declared option type simply omits `observer`
  // (an FG-12D typing gap, not a runtime one) — hence the cast. Production code is untouched.
  const passthrough = { observer, ...(options.runId ? { runId: options.runId } : {}) } as unknown as Partial<ControlledReuseOptions>;
  const outcome = await runVerificationWithControlledReuse(workspace.root, verifiers, { priorEvidence, mode, ...passthrough });
  const endedAt = now();
  const measurement = measureArm("treatment", startedAt, endedAt, timeline, outcome.report, {
    fallbackReason: outcome.fallbackReason,
    reuseDecisionStatus: outcome.reuseRequest?.decision.status,
    proposedReusableEvidenceIds: outcome.reuseRequest?.proposedReusableEvidence.map((e) => e.evidenceId),
  });
  return { measurement, report: outcome.report, timeline };
}

export function evaluatePairSafety(params: {
  control: ArmMeasurement;
  controlReport: VerificationReport;
  treatment: ArmMeasurement;
  treatmentReport: VerificationReport;
  priorEvidence: readonly GenericVerificationEvidence[];
  expectedReusedVerifierIds: readonly string[];
  /** When the prior evidence is EXPECTED to be failed (prior-failed-evidence invalidation), the
   * control/treatment outcome may legitimately be "failed" on both sides. */
  allowFailedOutcome?: boolean;
}): PairSafety {
  const failureReasons: string[] = [];
  const plannedIdentityEquivalent = JSON.stringify(params.control.plannedIdentity) === JSON.stringify(params.treatment.plannedIdentity);
  if (!plannedIdentityEquivalent) failureReasons.push("control/treatment planned verifier identity diverged");

  const outcomeEquivalent = params.control.overallStatus === params.treatment.overallStatus && params.control.requiredPassed === params.treatment.requiredPassed;
  if (!outcomeEquivalent) failureReasons.push(`outcome diverged: control=${params.control.overallStatus}/${params.control.requiredPassed} treatment=${params.treatment.overallStatus}/${params.treatment.requiredPassed}`);

  const coverageEquivalent = params.control.verificationComplete === params.treatment.verificationComplete;
  if (!coverageEquivalent) failureReasons.push("verificationComplete diverged");
  if (!params.allowFailedOutcome && !params.treatment.verificationComplete) failureReasons.push("treatment did not reach complete required coverage");

  const expected = [...params.expectedReusedVerifierIds].sort();
  const actual = [...params.treatment.reusedVerifierIds].sort();
  const reusedSetAsExpected = JSON.stringify(expected) === JSON.stringify(actual);
  if (!reusedSetAsExpected) failureReasons.push(`expected reuse of [${expected.join(",")}], got [${actual.join(",")}]`);

  const plan = params.treatmentReport.forgeVerify?.plan;
  let everyReusedEvidenceCanonicallyValid = true;
  let noFailedEvidenceReused = true;
  for (const verifier of params.treatmentReport.verifiers) {
    if (!verifier.reusedEvidenceId) continue;
    const evidence = params.treatmentReport.forgeVerify?.evidence.find((e) => e.evidenceId === verifier.reusedEvidenceId);
    const prior = params.priorEvidence.find((e) => e.evidenceId === verifier.reusedEvidenceId);
    if (!evidence || !prior) {
      everyReusedEvidenceCanonicallyValid = false;
      failureReasons.push(`reused evidence ${verifier.reusedEvidenceId} is not one of the supplied prior records`);
      continue;
    }
    if (evidence.status !== "passed") noFailedEvidenceReused = false;
    const planned = plan?.verifiers.find((p) => p.verifierId === evidence.verifierId);
    const valid = Boolean(plan && planned) && isEvidenceCurrentlyValid(evidence as VerificationEvidence, { workspacePath: plan!.workspacePath, inputStateHash: plan!.inputStateHash, definitionDigest: planned!.definitionDigest });
    if (!valid) {
      everyReusedEvidenceCanonicallyValid = false;
      failureReasons.push(`reused evidence ${evidence.evidenceId} is not canonically valid against the authoritative plan (stale/definition/path)`);
    }
  }
  if (!noFailedEvidenceReused) failureReasons.push("failed evidence was reused");

  const planned = params.treatmentReport.forgeVerify?.plan.verifiers.length ?? 0;
  const freshAttemptsMatchUnreusedCount = params.treatment.freshAttempts === planned - params.treatment.reusedVerifierIds.length;
  if (!freshAttemptsMatchUnreusedCount) failureReasons.push(`treatment spawned ${params.treatment.freshAttempts} attempts for ${planned - params.treatment.reusedVerifierIds.length} un-reused verifiers`);

  return {
    plannedIdentityEquivalent,
    outcomeEquivalent,
    coverageEquivalent,
    reusedSetAsExpected,
    everyReusedEvidenceCanonicallyValid,
    noFailedEvidenceReused,
    freshAttemptsMatchUnreusedCount,
    passed: failureReasons.length === 0,
    failureReasons,
  };
}

export interface PairRunParams {
  pairIndex: number;
  scored: boolean;
  warm: WarmDesignation;
  order: PairOrder;
  workloadId: string;
  expectedTier: CostTier;
  controlWorkspace: BenchWorkspace;
  treatmentWorkspace: BenchWorkspace;
  /** Verifier list BOTH arms plan against (may differ from the one that produced the evidence). */
  planVerifiers: Verifier[];
  priorEvidence: readonly GenericVerificationEvidence[];
  expectedReusedVerifierIds: readonly string[];
  mode?: ReuseTrialMode;
  allowFailedOutcome?: boolean;
  controlObserver?: ForgeVerifyObserver;
  treatmentObserver?: ForgeVerifyObserver;
}

export async function runPair(params: PairRunParams): Promise<PairReceipt> {
  const controlRun = () => runControlArm(params.controlWorkspace, params.planVerifiers, { downstreamObserver: params.controlObserver });
  const treatmentRun = () => runTreatmentArm(params.treatmentWorkspace, params.planVerifiers, params.priorEvidence, params.mode ?? "CONTROLLED_ACTIVE_TRIAL", { downstreamObserver: params.treatmentObserver });

  let control: Awaited<ReturnType<typeof controlRun>>;
  let treatment: Awaited<ReturnType<typeof treatmentRun>>;
  if (params.order === "control-first") {
    control = await controlRun();
    treatment = await treatmentRun();
  } else {
    treatment = await treatmentRun();
    control = await controlRun();
  }

  const safety = evaluatePairSafety({
    control: control.measurement,
    controlReport: control.report,
    treatment: treatment.measurement,
    treatmentReport: treatment.report,
    priorEvidence: params.priorEvidence,
    expectedReusedVerifierIds: params.expectedReusedVerifierIds,
    allowFailedOutcome: params.allowFailedOutcome,
  });

  const plannedCount = treatment.report.forgeVerify?.plan.verifiers.length ?? params.planVerifiers.length;
  const reusedCount = treatment.measurement.reusedVerifierIds.length;
  const reuseExtent: PairReceipt["reuseExtent"] = reusedCount === 0 ? "none" : reusedCount === plannedCount ? "full" : "partial";

  // Control's child-process time for exactly the verifiers treatment skipped (reference only).
  const controlById = new Map(control.report.verifiers.map((v) => [v.id, v.durationMs]));
  const verificationSavedReferenceMs = round(treatment.measurement.reusedVerifierIds.reduce((s, id) => s + (controlById.get(id) ?? 0), 0));
  const controlNonVerifierMs = control.measurement.wallMs - control.measurement.verifierExecutionMs;
  const treatmentNonVerifierMs = treatment.measurement.wallMs - treatment.measurement.verifierExecutionMs;

  const digests: Record<string, string> = {};
  for (const planned of treatment.report.forgeVerify?.plan.verifiers ?? []) digests[planned.verifierId] = planned.definitionDigest;

  return {
    pairIndex: params.pairIndex,
    scored: params.scored,
    warm: params.warm,
    order: params.order,
    workloadId: params.workloadId,
    expectedTier: params.expectedTier,
    workspaceKind: params.treatmentWorkspace.kind,
    verifierIds: params.planVerifiers.map((v) => v.id),
    verifierDefinitionDigests: digests,
    control: control.measurement,
    treatment: treatment.measurement,
    reuseExtent,
    plannedVerifierCount: plannedCount,
    actualVerifierExecutionsAvoided: reusedCount,
    actualChildProcessesAvoided: reusedCount,
    referenceControlDurationMs: control.measurement.wallMs,
    reusePathDurationMs: treatment.measurement.wallMs,
    netWallClockDeltaMs: round(control.measurement.wallMs - treatment.measurement.wallMs),
    verificationSavedReferenceMs,
    reuseCheckMs: round(treatmentNonVerifierMs - controlNonVerifierMs),
    advisoryDifferentialMs: round(treatment.measurement.prePlanMs - control.measurement.prePlanMs),
    safety,
  };
}

/** Produces the "historical" evidence a treatment arm will be offered: a real, fresh
 * `runVerification` on the treatment workspace — the same production path that would have
 * produced it in a real session. Its cost is never scored (it is the run that already happened). */
export async function produceBaselineEvidence(workspace: BenchWorkspace, verifiers: Verifier[], runId?: string, observer?: ForgeVerifyObserver): Promise<{ evidence: VerificationEvidence[]; report: VerificationReport; wallMs: number }> {
  const startedAt = now();
  const report = await runVerification(workspace.root, verifiers, { ...(runId ? { runId } : {}), ...(observer ? { observer } : {}) });
  const wallMs = round(now() - startedAt);
  return { evidence: [...(report.forgeVerify?.evidence ?? [])], report, wallMs };
}

export function alternatingOrder(index: number): PairOrder {
  return index % 2 === 0 ? "control-first" : "treatment-first";
}

export function currentInputStateHash(workspace: BenchWorkspace): string {
  return createVerificationInputStateHash(workspace.root);
}

export function asGeneric(evidence: readonly VerificationEvidence[]): GenericVerificationEvidence[] {
  return evidence as unknown as GenericVerificationEvidence[];
}
