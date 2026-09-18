import type { IntelligenceDatasetSplit } from "./splits.js";
import type { EvidenceProvenance, IntelligenceRecord, IntelligenceOutcome } from "./schema.js";

export interface DatasetQualityReport {
  featureSchemaVersion: string;
  totalRows: number;
  rowsByProvenance: Record<EvidenceProvenance, number>;
  rowsByTaskClass: Record<string, number>;
  rowsByModel: Record<string, number>;
  rowsByProvider: Record<string, number>;
  rowsByOutcome: Partial<Record<IntelligenceOutcome, number>>;
  missingFeatureRates: Record<string, number>;
  classImbalance: { outcome: string; count: number; share: number }[];
  uniqueTasks: number;
  uniqueRepositories: number;
  uniqueModels: number;
  uniqueProviders: number;
  protectedHoldoutCount: number;
  duplicateOrFamilyLeakage: { leakedGroups: string[]; status: "PASS" | "FAIL" };
  qualification: "INSUFFICIENT_DATA" | "DESCRIPTIVE_ONLY";
}

function countBy<T extends string>(values: readonly T[]): Record<T, number> {
  return values.reduce((counts, value) => ({ ...counts, [value]: (counts[value] ?? 0) + 1 }), {} as Record<T, number>);
}

function missingRate(records: IntelligenceRecord[], selector: (record: IntelligenceRecord) => unknown): number {
  if (records.length === 0) return 1;
  return records.filter((record) => selector(record) === undefined).length / records.length;
}

function latencyRank(value: IntelligenceRecord["route"]["providerLatencyBand"]): number {
  return value === "FAST" ? 0 : value === "MODERATE" ? 1 : value === "SLOW" ? 2 : value === "VERY_SLOW" ? 3 : 4;
}

export function datasetQualityReport(records: IntelligenceRecord[], split: IntelligenceDatasetSplit): DatasetQualityReport {
  const outcomes = records.map((record) => record.actualOutcome).filter((outcome): outcome is IntelligenceOutcome => outcome !== undefined);
  const outcomeCounts = countBy(outcomes);
  return {
    featureSchemaVersion: records[0]?.lineage.featureSchemaVersion ?? "codeforge-intelligence-features-v1",
    totalRows: records.length,
    rowsByProvenance: {
      OBSERVED_PRODUCTION: records.filter((record) => record.lineage.provenance === "OBSERVED_PRODUCTION").length,
      OBSERVED_BENCHMARK: records.filter((record) => record.lineage.provenance === "OBSERVED_BENCHMARK").length,
      SIMULATED: records.filter((record) => record.lineage.provenance === "SIMULATED").length,
      MOCK: records.filter((record) => record.lineage.provenance === "MOCK").length,
      SYNTHETIC_CHAOS: records.filter((record) => record.lineage.provenance === "SYNTHETIC_CHAOS").length,
    },
    rowsByTaskClass: countBy(records.map((record) => record.task.taskClass ?? "UNKNOWN")),
    rowsByModel: countBy(records.map((record) => record.route.canonicalModelId ?? "UNKNOWN")),
    rowsByProvider: countBy(records.map((record) => record.route.providerId ?? "UNKNOWN")),
    rowsByOutcome: outcomeCounts,
    missingFeatureRates: {
      taskClass: missingRate(records, (record) => record.task.taskClass),
      canonicalModelId: missingRate(records, (record) => record.route.canonicalModelId),
      providerId: missingRate(records, (record) => record.route.providerId),
      initialContextTokens: missingRate(records, (record) => record.context.initialContextTokens),
      actualCostUsd: missingRate(records, (record) => record.economics.actualCostUsd),
      actualOutcome: missingRate(records, (record) => record.actualOutcome),
    },
    classImbalance: Object.entries(outcomeCounts).map(([outcome, count]) => ({ outcome, count, share: outcomes.length === 0 ? 0 : count / outcomes.length })).sort((a, b) => b.count - a.count),
    uniqueTasks: new Set(records.map((record) => record.lineage.taskIdHash)).size,
    uniqueRepositories: new Set(records.map((record) => record.lineage.repositoryHash).filter((value): value is string => value !== undefined)).size,
    uniqueModels: new Set(records.map((record) => record.route.canonicalModelId).filter((value): value is string => value !== undefined)).size,
    uniqueProviders: new Set(records.map((record) => record.route.providerId).filter((value): value is string => value !== undefined)).size,
    protectedHoldoutCount: split.counts.PROTECTED_HOLDOUT,
    duplicateOrFamilyLeakage: { leakedGroups: split.leakedGroups, status: split.leakedGroups.length === 0 ? "PASS" : "FAIL" },
    qualification: records.length < 20 || outcomes.length < 20 ? "INSUFFICIENT_DATA" : "DESCRIPTIVE_ONLY",
  };
}

export interface RouteRegretRecord {
  taskIdHash: string;
  deterministicRouteIdHash: string;
  shadowRouteIdHash?: string;
  cheapestVerifiedSuccessRouteIdHash?: string;
  fastestVerifiedSuccessRouteIdHash?: string;
  routeRegretKnown: boolean;
}

/**
 * Counterfactuals are prohibited: a winner is returned only from actually observed eligible
 * routes for the same task hash. One observed route yields an honest "unknown" regret record.
 */
export function routeRegret(records: IntelligenceRecord[]): RouteRegretRecord[] {
  const byTask = new Map<string, IntelligenceRecord[]>();
  for (const record of records) {
    const rows = byTask.get(record.lineage.taskIdHash) ?? [];
    rows.push(record);
    byTask.set(record.lineage.taskIdHash, rows);
  }
  return [...byTask.entries()].map(([taskIdHash, rows]) => {
    const deterministic = rows[0]!;
    const observedSuccesses = rows.filter((row) => row.actualOutcome?.startsWith("VERIFIED_SUCCESS"));
    if (observedSuccesses.length === 0) return { taskIdHash, deterministicRouteIdHash: deterministic.productionDecision.routeIdHash, routeRegretKnown: false };
    const byCost = [...observedSuccesses].filter((row) => row.economics.actualCostUsd !== undefined).sort((left, right) => (left.economics.actualCostUsd ?? "").localeCompare(right.economics.actualCostUsd ?? ""));
    const byLatency = [...observedSuccesses]
      .filter((row) => row.route.providerLatencyBand !== "UNKNOWN")
      .sort((left, right) => latencyRank(left.route.providerLatencyBand) - latencyRank(right.route.providerLatencyBand));
    return {
      taskIdHash,
      deterministicRouteIdHash: deterministic.productionDecision.routeIdHash,
      ...(deterministic.shadowRecommendation?.recommendedRouteIdHash === undefined ? {} : { shadowRouteIdHash: deterministic.shadowRecommendation.recommendedRouteIdHash }),
      ...(byCost[0] === undefined ? {} : { cheapestVerifiedSuccessRouteIdHash: byCost[0].productionDecision.routeIdHash }),
      ...(byLatency[0] === undefined ? {} : { fastestVerifiedSuccessRouteIdHash: byLatency[0].productionDecision.routeIdHash }),
      routeRegretKnown: observedSuccesses.length > 1,
    };
  });
}
