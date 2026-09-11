import type { CampaignCandidateKind, ObservationRecord } from "./observation-store.js";

export interface CandidateAggregate {
  candidateKind: CampaignCandidateKind;
  certifiedSourceStateId: string;
  campaignHarnessId: string;
  total: number;
  eligible: number;
  validated: number;
  invalidated: number;
  incomplete: number;
  insufficientEvidence: number;
  uniqueRuns: number;
  uniqueFingerprints: number;
  controlCases: number;
  unsafeFalsePositives: number;
  unsafeFalsePositiveDetails: Array<{ occurrenceId: string; controlCase?: string; falsePositiveReason?: string }>;
  diversityDimensions: Record<string, string[]>;
  invalidationReasonDistribution: Record<string, number>;
  projectedTotals: Record<string, number>;
  actualTotals: Record<string, number>;
  observerOverhead: { totalMs: number; meanMs: number; medianMs: number; maxMs: number; callCount: number };
}

export interface BucketKey {
  certifiedSourceStateId: string;
  campaignHarnessId: string;
}

function bucketKeyOf(record: ObservationRecord): string {
  return `${record.certifiedSourceStateId}::${record.campaignHarnessId}`;
}

/** Groups raw observations strictly by `(certifiedSourceStateId, campaignHarnessId)` — never
 * silently combined across a drifted identity pair (FG-11 amendment §1). */
export function groupByBucket(records: readonly ObservationRecord[]): Map<string, ObservationRecord[]> {
  const groups = new Map<string, ObservationRecord[]>();
  for (const record of records) {
    const key = bucketKeyOf(record);
    const list = groups.get(key) ?? [];
    list.push(record);
    groups.set(key, list);
  }
  return groups;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function sumInto(target: Record<string, number>, source: Record<string, number> | undefined): void {
  if (!source) return;
  for (const [key, value] of Object.entries(source)) {
    target[key] = (target[key] ?? 0) + value;
  }
}

export function aggregateCandidate(candidateKind: CampaignCandidateKind, records: readonly ObservationRecord[]): CandidateAggregate {
  const scoped = records.filter((r) => r.candidateKind === candidateKind);
  const first = scoped[0];
  const validated = scoped.filter((r) => r.classification === "VALIDATED");
  const invalidated = scoped.filter((r) => r.classification === "INVALIDATED");
  const incomplete = scoped.filter((r) => r.classification === "INCOMPLETE");
  const insufficient = scoped.filter((r) => r.classification === "INSUFFICIENT_EVIDENCE");
  const unsafe = scoped.filter((r) => r.unsafeFalsePositive);
  const diversityDimensions: Record<string, Set<string>> = {};
  for (const record of scoped) {
    for (const [dimension, value] of Object.entries(record.diversityDimensions)) {
      if (!diversityDimensions[dimension]) diversityDimensions[dimension] = new Set();
      diversityDimensions[dimension]!.add(value);
    }
  }
  const invalidationReasonDistribution: Record<string, number> = {};
  for (const record of invalidated) {
    const reason = record.diversityDimensions.invalidationReason ?? "UNSPECIFIED";
    invalidationReasonDistribution[reason] = (invalidationReasonDistribution[reason] ?? 0) + 1;
  }
  const projectedTotals: Record<string, number> = {};
  const actualTotals: Record<string, number> = {};
  for (const record of validated) {
    sumInto(projectedTotals, record.projected);
    sumInto(actualTotals, record.actual);
  }
  const overheads = scoped.map((r) => r.observerOverheadMs);
  const overheadTotal = overheads.reduce((sum, ms) => sum + ms, 0);

  return {
    candidateKind,
    certifiedSourceStateId: first?.certifiedSourceStateId ?? "",
    campaignHarnessId: first?.campaignHarnessId ?? "",
    total: scoped.length,
    eligible: validated.length + invalidated.length,
    validated: validated.length,
    invalidated: invalidated.length,
    incomplete: incomplete.length,
    insufficientEvidence: insufficient.length,
    uniqueRuns: new Set(scoped.map((r) => r.runId)).size,
    uniqueFingerprints: new Set(scoped.map((r) => r.evidenceFingerprint)).size,
    controlCases: scoped.filter((r) => r.controlCase !== undefined).length,
    unsafeFalsePositives: unsafe.length,
    unsafeFalsePositiveDetails: unsafe.map((r) => ({ occurrenceId: r.occurrenceId, controlCase: r.controlCase, falsePositiveReason: r.falsePositiveReason })),
    diversityDimensions: Object.fromEntries(Object.entries(diversityDimensions).map(([k, v]) => [k, [...v].sort()])),
    invalidationReasonDistribution,
    projectedTotals,
    actualTotals,
    observerOverhead: {
      totalMs: overheadTotal,
      meanMs: overheads.length > 0 ? overheadTotal / overheads.length : 0,
      medianMs: median(overheads),
      maxMs: overheads.length > 0 ? Math.max(...overheads) : 0,
      callCount: overheads.length,
    },
  };
}

export interface CampaignAggregateReport {
  generatedAt: string;
  authoritativeBucket: BucketKey;
  excludedBuckets: Array<BucketKey & { observationCount: number }>;
  candidates: Record<CampaignCandidateKind, CandidateAggregate>;
}

/**
 * Aggregates the full observation corpus, restricted to the authoritative `(sourceState,
 * harness)` bucket — any other bucket present (e.g. leftover observations from a prior harness
 * version) is reported by name/count only, never merged into the authoritative numbers.
 */
export function buildCampaignAggregateReport(
  allObservations: readonly ObservationRecord[],
  authoritative: BucketKey,
): CampaignAggregateReport {
  const groups = groupByBucket(allObservations);
  const authoritativeKey = `${authoritative.certifiedSourceStateId}::${authoritative.campaignHarnessId}`;
  const authoritativeRecords = groups.get(authoritativeKey) ?? [];
  const excludedBuckets: CampaignAggregateReport["excludedBuckets"] = [];
  for (const [key, records] of groups) {
    if (key === authoritativeKey) continue;
    const [certifiedSourceStateId, campaignHarnessId] = key.split("::");
    excludedBuckets.push({ certifiedSourceStateId: certifiedSourceStateId!, campaignHarnessId: campaignHarnessId!, observationCount: records.length });
  }
  const kinds: CampaignCandidateKind[] = ["A", "B", "C", "D"];
  const candidates = Object.fromEntries(kinds.map((kind) => [kind, aggregateCandidate(kind, authoritativeRecords)])) as Record<
    CampaignCandidateKind,
    CandidateAggregate
  >;
  return { generatedAt: new Date().toISOString(), authoritativeBucket: authoritative, excludedBuckets, candidates };
}
