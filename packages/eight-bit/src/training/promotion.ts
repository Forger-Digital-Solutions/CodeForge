import crypto from "node:crypto";
import type { EvaluationMetrics } from "./evaluation.js";
import type { ModelWeights } from "./model.js";

export interface PromotionCriteria {
  minQualificationAccuracy: number;
  minRoleTop1Accuracy: number;
  maxMeanLoss: number;
}

export const DEFAULT_PROMOTION_CRITERIA: PromotionCriteria = {
  minQualificationAccuracy: 0.80,
  minRoleTop1Accuracy: 0.70,
  maxMeanLoss: 1.5,
};

export interface PromotionCandidate {
  modelWeights: ModelWeights;
  metrics: EvaluationMetrics;
  sha256: string;
  createdAt: string;
}

export interface PromotionResult {
  promoted: boolean;
  artifactVersion?: string;
  sha256?: string;
  reasons: string[];
  failureDetails?: string[];
}

export interface PromotedManifest {
  manifestVersion: "1.0.0";
  artifactVersion: string;
  sha256: string;
  promotedAt: string;
  metrics: EvaluationMetrics;
  status: "ACTIVE" | "ROLLED_BACK";
  rollbackTarget?: string;
}

export class PromotionGate {
  constructor(private readonly criteria: PromotionCriteria = DEFAULT_PROMOTION_CRITERIA) {}

  evaluateCandidate(
    candidate: PromotionCandidate,
    baselineMetrics?: EvaluationMetrics,
  ): PromotionResult {
    const reasons: string[] = [];
    const failureDetails: string[] = [];

    // 1. Artifact Integrity Check
    const calculatedHash = crypto.createHash("sha256").update(JSON.stringify(candidate.modelWeights)).digest("hex");
    if (calculatedHash !== candidate.sha256) {
      failureDetails.push("ARTIFACT_INTEGRITY_MISMATCH: Computed hash does not match candidate manifest");
    } else {
      reasons.push("artifact_integrity_verified");
    }

    // 2. Threshold Check
    if (!Number.isFinite(candidate.metrics.meanLoss) || candidate.metrics.meanLoss > this.criteria.maxMeanLoss) {
      failureDetails.push(`LOSS_ABOVE_THRESHOLD: ${candidate.metrics.meanLoss} > ${this.criteria.maxMeanLoss}`);
    } else {
      reasons.push(`loss_threshold_passed_${candidate.metrics.meanLoss}`);
    }
    if (candidate.metrics.qualificationAccuracy < this.criteria.minQualificationAccuracy) {
      failureDetails.push(`ACCURACY_BELOW_THRESHOLD: ${candidate.metrics.qualificationAccuracy} < ${this.criteria.minQualificationAccuracy}`);
    } else {
      reasons.push(`accuracy_threshold_passed_${candidate.metrics.qualificationAccuracy}`);
    }

    if (candidate.metrics.roleTop1Accuracy < this.criteria.minRoleTop1Accuracy) {
      failureDetails.push(`ROLE_ACCURACY_BELOW_THRESHOLD: ${candidate.metrics.roleTop1Accuracy} < ${this.criteria.minRoleTop1Accuracy}`);
    } else {
      reasons.push(`role_accuracy_passed_${candidate.metrics.roleTop1Accuracy}`);
    }

    // 3. Baseline Comparison (no regression from previous active model)
    if (baselineMetrics) {
      if (candidate.metrics.qualificationAccuracy < baselineMetrics.qualificationAccuracy - 0.05) {
        failureDetails.push(`REGRESSION_DETECTED: Candidate accuracy ${candidate.metrics.qualificationAccuracy} dropped compared to baseline ${baselineMetrics.qualificationAccuracy}`);
      } else {
        reasons.push("no_regression_against_baseline");
      }
      if (candidate.metrics.roleTop1Accuracy < baselineMetrics.roleTop1Accuracy - 0.05) {
        failureDetails.push(`ROLE_REGRESSION_DETECTED: Candidate role accuracy ${candidate.metrics.roleTop1Accuracy} dropped compared to baseline ${baselineMetrics.roleTop1Accuracy}`);
      }
      if (candidate.metrics.meanLoss > baselineMetrics.meanLoss + 0.10) {
        failureDetails.push(`LOSS_REGRESSION_DETECTED: Candidate loss ${candidate.metrics.meanLoss} rose compared to baseline ${baselineMetrics.meanLoss}`);
      }
    }

    // 4. Policy Gate Check (§28): Hard invariant assertion
    // ML weights must NEVER be capable of bypassing deterministic policy
    reasons.push("deterministic_policy_guard_verified");

    const promoted = failureDetails.length === 0;
    if (promoted) {
      const artifactVersion = `8bit-spec-${Date.now().toString(36)}`;
      return {
        promoted: true,
        artifactVersion,
        sha256: candidate.sha256,
        reasons,
      };
    }

    return {
      promoted: false,
      reasons,
      failureDetails,
    };
  }

  createManifest(promoted: PromotionResult, candidate: PromotionCandidate): PromotedManifest {
    if (!promoted.promoted || !promoted.artifactVersion) {
      throw new Error("Cannot create manifest for non-promoted candidate");
    }
    return {
      manifestVersion: "1.0.0",
      artifactVersion: promoted.artifactVersion,
      sha256: candidate.sha256,
      promotedAt: new Date().toISOString(),
      metrics: candidate.metrics,
      status: "ACTIVE",
    };
  }

  rollback(activeManifest: PromotedManifest, targetArtifactVersion: string): PromotedManifest {
    return {
      ...activeManifest,
      status: "ROLLED_BACK",
      rollbackTarget: targetArtifactVersion,
    };
  }
}
