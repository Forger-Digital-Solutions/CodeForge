import crypto from "node:crypto";
import type { FreeModelRecord } from "@codeforge/forge-zero";
import type { EightBitRole } from "../types.js";

/**
 * 8-Bit Specialization Dataset (R1 spec §29–§32).
 *
 * Normalizes provider metadata, benchmark profiles, capability flags, and
 * empirical qualification receipts into structured feature vectors for
 * roster intelligence classification and role ranking.
 */

export const FEATURE_NAMES = [
  "bench_coding",
  "bench_reasoning",
  "bench_speed",
  "bench_tool_calling",
  "context_tokens_norm",
  "max_output_norm",
  "has_tools",
  "has_structured_output",
  "has_long_context",
  "empirical_coding_score",
  "empirical_tool_reliability",
  "failure_rate_norm",
  "is_healthy",
] as const;

export type FeatureName = (typeof FEATURE_NAMES)[number];

export interface TrainingSample {
  id: string;
  features: number[];
  /** Target binary qualification label: 1 = qualified, 0 = disqualified/rejected */
  qualifiedLabel: number;
  /** Target role preference scores (0–1) */
  roleLabels: Record<EightBitRole, number>;
  metadata: {
    providerId: string;
    modelId: string;
    provenance: string;
  };
}

export interface DatasetSplit {
  train: TrainingSample[];
  dev: TrainingSample[];
  eval: TrainingSample[];
}

export function extractFeatures(model: FreeModelRecord): number[] {
  const bp = model.benchmarkProfile ?? {};
  const c = model.capabilities ?? { text: true, coding: false, toolCalling: false, vision: false, structuredOutput: false, longContext: false };

  const benchCoding = (bp.coding ?? 50) / 100;
  const benchReasoning = (bp.reasoning ?? 50) / 100;
  const benchSpeed = (bp.speed ?? 50) / 100;
  const benchTool = (bp.toolCalling ?? 50) / 100;

  const contextNorm = Math.min(1, (model.contextWindow ?? 8192) / 200_000);
  const outputNorm = Math.min(1, (model.maxOutput ?? 4096) / 16_384);

  const hasTools = c.toolCalling ? 1 : 0;
  const hasStructured = c.structuredOutput ? 1 : 0;
  const hasLongContext = c.longContext ? 1 : 0;

  const empiricalCoding = (model.codingScore ?? (c.coding ? 75 : 30)) / 100;
  const empiricalTool = model.toolReliability ?? (c.toolCalling ? 0.8 : 0.2);

  const failures = model.health?.recentFailureCount ?? 0;
  const failureRateNorm = Math.min(1, failures / 10);
  const status = model.health?.status;
  const isHealthy = status === "available" || status === "verified" ? 1 : status === "degraded" ? 0.5 : 0;

  return [
    benchCoding,
    benchReasoning,
    benchSpeed,
    benchTool,
    contextNorm,
    outputNorm,
    hasTools,
    hasStructured,
    hasLongContext,
    empiricalCoding,
    empiricalTool,
    failureRateNorm,
    isHealthy,
  ];
}

export function createSampleFromModel(
  model: FreeModelRecord,
  isQualified: boolean,
  roleSuitability: Partial<Record<EightBitRole, number>> = {},
): TrainingSample {
  const features = extractFeatures(model);
  const defaultRoles: Record<EightBitRole, number> = {
    CODER: (features[0]! * 0.6 + features[9]! * 0.4),
    REASONER: features[1]!,
    PLANNER: (features[1]! * 0.6 + features[4]! * 0.4),
    REVIEWER: (features[1]! * 0.5 + features[0]! * 0.5),
    FAST_WORKER: (features[2]! * 0.7 + features[0]! * 0.3),
    LONG_CONTEXT: features[4]!,
    VISION: 0,
    TOOL_AGENT: (features[3]! * 0.6 + features[10]! * 0.4),
    ANALYST: (features[1]! * 0.6 + features[0]! * 0.4),
  };

  const roleLabels: Record<EightBitRole, number> = { ...defaultRoles, ...roleSuitability };

  return {
    id: `${model.providerId}::${model.modelId}`,
    features,
    qualifiedLabel: isQualified ? 1 : 0,
    roleLabels,
    metadata: {
      providerId: model.providerId,
      modelId: model.modelId,
      provenance: "synthetic_benchmarks_and_empirical_logs",
    },
  };
}

export function splitDataset(samples: TrainingSample[], trainRatio = 0.7, devRatio = 0.15): DatasetSplit {
  // Deterministic split based on sample ID hash
  const sorted = [...samples].sort((a, b) => {
    const ha = crypto.createHash("sha256").update(a.id).digest("hex");
    const hb = crypto.createHash("sha256").update(b.id).digest("hex");
    return ha.localeCompare(hb);
  });

  const n = sorted.length;
  const trainCount = Math.max(1, Math.floor(n * trainRatio));
  const devCount = Math.max(1, Math.floor(n * devRatio));

  const train = sorted.slice(0, trainCount);
  const dev = sorted.slice(trainCount, trainCount + devCount);
  const evalSet = sorted.slice(trainCount + devCount);

  return { train, dev, eval: evalSet.length > 0 ? evalSet : dev };
}