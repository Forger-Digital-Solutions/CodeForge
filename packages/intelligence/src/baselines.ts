import type {
  Confidence,
  IntelligenceRecord,
  LatencyBand,
  RiskBand,
  ShadowRecommendation,
} from "./schema.js";

function riskNumber(value: RiskBand | undefined): number {
  if (value === "EXHAUSTED") return 1;
  if (value === "HIGH") return 0.75;
  if (value === "MEDIUM") return 0.45;
  if (value === "LOW") return 0.2;
  if (value === "NONE") return 0;
  return 0.5;
}

function confidence(samples: number | undefined): Confidence {
  if (samples === undefined || samples < 20) return "INSUFFICIENT_DATA";
  if (samples < 50) return "LOW";
  if (samples < 200) return "MEDIUM";
  return "HIGH";
}

function latencyOf(record: IntelligenceRecord): LatencyBand {
  return record.route.providerLatencyBand;
}

/** Deterministic historical-health baseline for 8-Bit; no policy decision consumes it. */
export function eightBitDeterministicBaseline(record: IntelligenceRecord, samples?: number): ShadowRecommendation {
  const outageRisk = Math.max(
    riskNumber(record.route.rateLimitRisk),
    riskNumber(record.route.quotaRemainingBand),
    riskNumber(record.route.recent429RateBand),
    riskNumber(record.route.recentErrorRateBand),
  );
  const predictedRisk: RiskBand = outageRisk >= 0.75 ? "HIGH" : outageRisk >= 0.4 ? "MEDIUM" : outageRisk > 0 ? "LOW" : "NONE";
  return {
    recommendationKind: "ROUTE_RANK",
    recommendedRouteIdHash: record.productionDecision.routeIdHash,
    predictedSuccess: Math.round((1 - outageRisk) * 100) / 100,
    predictedRisk,
    predictedLatency: latencyOf(record),
    confidence: confidence(samples),
    limitations: ["Deterministic health/capacity baseline only; does not judge model capability."],
  };
}

/** 16-Bit's initial baseline keeps monetary authority in the existing budget ledger. */
export function sixteenBitDeterministicBaseline(record: IntelligenceRecord, samples?: number): ShadowRecommendation {
  return {
    recommendationKind: "ECONOMIC_VALUE",
    recommendedRouteIdHash: record.productionDecision.routeIdHash,
    predictedSuccess: eightBitDeterministicBaseline(record, samples).predictedSuccess,
    predictedRisk: record.route.rateLimitRisk,
    ...(record.economics.expectedTotalTaskCostUsd === undefined ? {} : { predictedCostUsd: record.economics.expectedTotalTaskCostUsd }),
    predictedLatency: latencyOf(record),
    confidence: confidence(samples),
    limitations: ["Recommendation cannot reserve, release, or spend campaign money."],
  };
}

/** ForgeGreen's initial topology baseline mirrors observed static resource signals only. */
export function forgeGreenDeterministicBaseline(record: IntelligenceRecord, samples?: number): ShadowRecommendation {
  const requested = record.topology.topologyRequested ?? 1;
  const recommended = record.topology.topologyRecommended ?? requested;
  const noProgress = record.tools.noProgressSignals ?? 0;
  return {
    recommendationKind: "TOPOLOGY",
    recommendedParallelAgents: recommended,
    predictedSuccess: noProgress > 0 ? 0.5 : 0.7,
    predictedRisk: noProgress > 2 ? "HIGH" : noProgress > 0 ? "MEDIUM" : "LOW",
    predictedLatency: latencyOf(record),
    confidence: confidence(samples),
    limitations: ["Topology recommendation is advisory and cannot mutate execution."],
  };
}
