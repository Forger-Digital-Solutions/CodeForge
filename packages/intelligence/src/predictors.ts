import { performance } from "node:perf_hooks";
import type { IntelligenceDatasetSplit } from "./splits.js";
import {
  INTELLIGENCE_FEATURE_SCHEMA_VERSION,
  type Confidence,
  type IntelligenceDomain,
  type IntelligenceRecord,
  type RiskBand,
  type ShadowRecommendation,
} from "./schema.js";
import { eightBitDeterministicBaseline, forgeGreenDeterministicBaseline, sixteenBitDeterministicBaseline } from "./baselines.js";

export type ShadowArtifactKind = "8bit-shadow-r1" | "16bit-shadow-r1" | "forgegreen-shadow-r1";
export interface ShadowModelArtifact {
  artifactId: ShadowArtifactKind;
  modelType: "CALIBRATED_LINEAR";
  inputFeatureSchemaVersion: typeof INTELLIGENCE_FEATURE_SCHEMA_VERSION;
  trainingDatasetHash: string;
  splitVersion: string;
  randomSeed: number;
  createdAt: string;
  trainingRecordCount: number;
  observedSuccesses: number;
  /** Laplace-smoothed intercept learned from TRAINING rows only. */
  intercept: number;
  coefficients: Readonly<Record<"rateLimitRisk" | "quotaRisk" | "contextPressure" | "noProgress", number>>;
  metrics: { validationRows: number; calibrationStatus: "INSUFFICIENT_EVIDENCE" | "NOT_EVALUATED" };
}

export interface ShadowPredictionResult {
  recommendation: ShadowRecommendation;
  artifactStatus: "LOADED" | "DISABLED" | "MISSING" | "SCHEMA_MISMATCH" | "CORRUPT";
  latencyMs: number;
}

const MINIMUM_TRAINING_ROWS = 20;

function sigmoid(value: number): number { return 1 / (1 + Math.exp(-Math.max(-20, Math.min(20, value)))); }
function riskNumber(value: RiskBand): number {
  return value === "EXHAUSTED" ? 1 : value === "HIGH" ? 0.75 : value === "MEDIUM" ? 0.45 : value === "LOW" ? 0.2 : value === "NONE" ? 0 : 0.5;
}
function logit(probability: number): number { return Math.log(probability / (1 - probability)); }

function artifactFor(domain: IntelligenceDomain): ShadowArtifactKind {
  return domain === "8BIT" ? "8bit-shadow-r1" : domain === "16BIT" ? "16bit-shadow-r1" : "forgegreen-shadow-r1";
}

function baselineFor(record: IntelligenceRecord, samples: number): ShadowRecommendation {
  return record.domain === "8BIT" ? eightBitDeterministicBaseline(record, samples)
    : record.domain === "16BIT" ? sixteenBitDeterministicBaseline(record, samples)
    : forgeGreenDeterministicBaseline(record, samples);
}

/** Fits only a small calibrated intercept. Feature slopes are reviewed monotonic safety priors. */
export function trainShadowArtifact(
  domain: IntelligenceDomain,
  records: IntelligenceRecord[],
  split: IntelligenceDatasetSplit,
  now = new Date().toISOString(),
): ShadowModelArtifact | undefined {
  const training = records.filter((record) => split.assignments.some((assignment) => assignment.recordId === record.recordId && assignment.partition === "TRAINING"));
  if (training.length < MINIMUM_TRAINING_ROWS) return undefined;
  const labels = training.map((record) => record.actualOutcome).filter((outcome): outcome is NonNullable<typeof outcome> => outcome !== undefined);
  if (labels.length < MINIMUM_TRAINING_ROWS) return undefined;
  const successes = labels.filter((outcome) => outcome.startsWith("VERIFIED_SUCCESS")).length;
  const probability = (successes + 1) / (labels.length + 2);
  return {
    artifactId: artifactFor(domain),
    modelType: "CALIBRATED_LINEAR",
    inputFeatureSchemaVersion: INTELLIGENCE_FEATURE_SCHEMA_VERSION,
    trainingDatasetHash: split.datasetHash,
    splitVersion: split.splitVersion,
    randomSeed: split.randomSeed,
    createdAt: now,
    trainingRecordCount: labels.length,
    observedSuccesses: successes,
    intercept: logit(probability),
    coefficients: { rateLimitRisk: -1.2, quotaRisk: -1.4, contextPressure: -0.35, noProgress: -0.45 },
    metrics: { validationRows: split.counts.VALIDATION, calibrationStatus: "INSUFFICIENT_EVIDENCE" },
  };
}

function validateArtifact(artifact: ShadowModelArtifact | undefined, domain: IntelligenceDomain): "LOADED" | "MISSING" | "SCHEMA_MISMATCH" | "CORRUPT" {
  if (!artifact) return "MISSING";
  if (artifact.inputFeatureSchemaVersion !== INTELLIGENCE_FEATURE_SCHEMA_VERSION) return "SCHEMA_MISMATCH";
  if (artifact.artifactId !== artifactFor(domain) || !Number.isFinite(artifact.intercept) || artifact.trainingRecordCount < MINIMUM_TRAINING_ROWS) return "CORRUPT";
  return "LOADED";
}

function predictWithArtifact(record: IntelligenceRecord, artifact: ShadowModelArtifact): ShadowRecommendation {
  const rate = riskNumber(record.route.rateLimitRisk);
  const quota = riskNumber(record.route.quotaRemainingBand);
  const contextPressure = record.context.initialContextTokens !== undefined && record.context.finalContextTokens !== undefined && record.context.initialContextTokens > 0
    ? Math.min(1, record.context.finalContextTokens / record.context.initialContextTokens)
    : 0;
  const noProgress = Math.min(1, (record.tools.noProgressSignals ?? 0) / 4);
  const success = sigmoid(artifact.intercept + artifact.coefficients.rateLimitRisk * rate + artifact.coefficients.quotaRisk * quota + artifact.coefficients.contextPressure * contextPressure + artifact.coefficients.noProgress * noProgress);
  const confidence: Confidence = artifact.trainingRecordCount >= 200 ? "MEDIUM" : "LOW";
  const baseline = baselineFor(record, artifact.trainingRecordCount);
  return {
    ...baseline,
    predictedSuccess: Math.round(success * 100) / 100,
    confidence,
    modelArtifactId: artifact.artifactId,
    limitations: [...baseline.limitations, "Calibrated-linear shadow output; no policy, money, or completion authority."],
  };
}

export class ShadowPredictor {
  constructor(private readonly domain: IntelligenceDomain, private readonly artifact?: ShadowModelArtifact, private readonly enabled = false) {}

  predict(record: IntelligenceRecord): ShadowPredictionResult {
    const started = performance.now();
    if (!this.enabled) return { recommendation: baselineFor(record, 0), artifactStatus: "DISABLED", latencyMs: performance.now() - started };
    const status = validateArtifact(this.artifact, this.domain);
    if (status !== "LOADED") {
      return {
        recommendation: { ...baselineFor(record, 0), confidence: "INSUFFICIENT_DATA", limitations: [...baselineFor(record, 0).limitations, `Shadow artifact unavailable: ${status}.`] },
        artifactStatus: status,
        latencyMs: performance.now() - started,
      };
    }
    try {
      return { recommendation: predictWithArtifact(record, this.artifact!), artifactStatus: "LOADED", latencyMs: performance.now() - started };
    } catch {
      return { recommendation: baselineFor(record, 0), artifactStatus: "CORRUPT", latencyMs: performance.now() - started };
    }
  }
}

export function createEightBitShadowPredictor(artifact?: ShadowModelArtifact, enabled = false): ShadowPredictor { return new ShadowPredictor("8BIT", artifact, enabled); }
export function createSixteenBitShadowPredictor(artifact?: ShadowModelArtifact, enabled = false): ShadowPredictor { return new ShadowPredictor("16BIT", artifact, enabled); }
export function createForgeGreenShadowPredictor(artifact?: ShadowModelArtifact, enabled = false): ShadowPredictor { return new ShadowPredictor("FORGEGREEN", artifact, enabled); }
