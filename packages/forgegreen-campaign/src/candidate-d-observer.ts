import {
  createVerificationPlan,
  executeVerificationPlan,
  isEvidenceCurrentlyValid,
  VerificationEvidenceStore,
  type VerificationEvidence,
  type VerificationPolicy,
  type VerificationPolicyInput,
  type VerifierRegistry,
} from "@codeforge/workflow";
import { detectReusableVerificationEvidence, fingerprint, type VerificationEvidenceReuseCandidate } from "@codeforge/forge-green";
import type { ObservationInput } from "./observation-store.js";
import { CANDIDATE_D_POLICY_VERSION, OBSERVATION_SCHEMA_VERSION } from "./policy.js";

export interface CandidateDParams {
  runId: string;
  taskId: string;
  certifiedSourceStateId: string;
  campaignHarnessId: string;
  registry: VerifierRegistry;
  policy: VerificationPolicy;
  workspacePath: string;
  scope: VerificationPolicyInput["scope"];
  /** Applied between the baseline run and the fresh rerun — e.g. a real source edit, a
   * dependency change, or nothing at all (the "identical state" control). */
  mutate?: () => void | Promise<void>;
  /** Real registry/policy used for the FRESH rerun only, when it differs from the baseline —
   * e.g. a changed verifier command/config or a changed policy revision between runs (the
   * `changed_verification_command`/`changed_verification_policy` controls). Defaults to the
   * same registry/policy as the baseline when omitted. */
  freshRegistry?: VerifierRegistry;
  freshPolicy?: VerificationPolicy;
  controlCase?: string;
  diversityDimensions?: Record<string, string>;
}

/**
 * Real Candidate D observation: runs ForgeVerify's actual `executeVerificationPlan` twice
 * (baseline, then always-fresh rerun — never short-circuited via `existingEvidence`), and
 * classifies whether the baseline evidence would still have been valid using the single
 * canonical `isEvidenceCurrentlyValid` helper from `@codeforge/workflow` (FG-11 hardening
 * amendment §4) — never an independently maintained copy of that rule.
 */
export async function observeCandidateD(params: CandidateDParams): Promise<{ observations: ObservationInput[]; overheadMs: number }> {
  const overheadStart = Date.now();

  const baselinePlan = createVerificationPlan(params.registry, params.policy, { runId: `${params.runId}-baseline`, workspacePath: params.workspacePath, scope: params.scope });
  const baselineStore = new VerificationEvidenceStore();
  const baselineResult = await executeVerificationPlan(params.registry, baselinePlan, baselineStore);

  if (params.mutate) await params.mutate();

  const freshRegistry = params.freshRegistry ?? params.registry;
  const freshPolicy = params.freshPolicy ?? params.policy;
  const freshPlan = createVerificationPlan(freshRegistry, freshPolicy, { runId: `${params.runId}-fresh`, workspacePath: params.workspacePath, scope: params.scope });
  const freshStore = new VerificationEvidenceStore();
  // Fresh verification always executes — `existingEvidence` is deliberately never supplied here,
  // so ForgeVerify's own built-in reuse path can never substitute for the real rerun (spec §14).
  const freshResult = await executeVerificationPlan(freshRegistry, freshPlan, freshStore);

  const observerOverheadEnd = Date.now();
  const overheadPerObservation = Math.max(1, Math.round((observerOverheadEnd - overheadStart) * 0.02));

  const observations: ObservationInput[] = [];
  for (const priorEvidence of baselineResult.evidence) {
    const freshPlanned = freshPlan.verifiers.find((v) => v.verifierId === priorEvidence.verifierId);
    const freshEvidence = freshResult.evidence.find((e) => e.verifierId === priorEvidence.verifierId);
    if (!freshPlanned || !freshEvidence) continue;

    const forgeVerifyConfirmedValid = isEvidenceCurrentlyValid(priorEvidence as VerificationEvidence, {
      workspacePath: freshPlan.workspacePath,
      inputStateHash: freshPlan.inputStateHash,
      definitionDigest: freshPlanned.definitionDigest,
    });

    const candidate: VerificationEvidenceReuseCandidate = {
      evidenceId: priorEvidence.evidenceId,
      workspaceContentHash: priorEvidence.inputStateHash,
      policyRevision: baselinePlan.policyVersion,
      command: priorEvidence.commandDigest,
      dependencyStateHash: priorEvidence.definitionDigest,
      forgeVerifyConfirmedValid,
    };
    const decision = detectReusableVerificationEvidence({
      runId: params.runId,
      sessionId: params.runId,
      sustainabilityReceiptId: undefined,
      candidates: [candidate],
    });
    const validated = decision.status === "PROPOSED" && decision.sourceEvidenceIds.length > 0;
    // The canonical helper already forces inputStateHash/definitionDigest/workspacePath equality
    // to the CURRENT (fresh) state before declaring valid — so a validated reuse must reproduce
    // the same real "passed" outcome the fresh rerun actually measured. If it doesn't, that is
    // exactly the unsafe reuse false positive §16 warns against, not a lucky matching PASS.
    const unsafeFalsePositive = validated && freshEvidence.status !== "passed";

    observations.push({
      candidateKind: "D",
      certifiedSourceStateId: params.certifiedSourceStateId,
      campaignHarnessId: params.campaignHarnessId,
      observationSchemaVersion: OBSERVATION_SCHEMA_VERSION,
      candidatePolicyVersion: CANDIDATE_D_POLICY_VERSION,
      runId: params.runId,
      taskId: params.taskId,
      productionOccurrenceId: `${priorEvidence.attemptId}:${freshEvidence.attemptId}`,
      evidenceFingerprint: fingerprint({ verifierId: priorEvidence.verifierId, priorHash: priorEvidence.evidenceHash, freshHash: freshEvidence.evidenceHash }),
      classification: validated ? "VALIDATED" : "INVALIDATED",
      controlCase: params.controlCase,
      diversityDimensions: {
        ...params.diversityDimensions,
        verifierId: priorEvidence.verifierId,
        priorStatus: priorEvidence.status,
        freshStatus: freshEvidence.status,
        ...(!validated ? { invalidationReason: !forgeVerifyConfirmedValid ? "STALE_OR_CHANGED_STATE" : "UNKNOWN" } : {}),
      },
      unsafeFalsePositive,
      falsePositiveReason: unsafeFalsePositive ? "Declared reusable while the fresh rerun did not pass" : undefined,
      projected: validated ? { verificationReruns: 1, verificationDurationMs: freshEvidence.elapsedMs } : undefined,
      observerOverheadMs: overheadPerObservation,
    });
  }
  return { observations, overheadMs: observerOverheadEnd - overheadStart };
}
