import { describe, expect, it } from "vitest";
import { aggregateCandidate, buildCampaignAggregateReport } from "../src/aggregator.js";
import type { ObservationRecord } from "../src/observation-store.js";

function record(overrides: Partial<ObservationRecord>): ObservationRecord {
  return {
    occurrenceId: Math.random().toString(36),
    evidenceFingerprint: "fp",
    candidateKind: "B",
    certifiedSourceStateId: "state-1",
    campaignHarnessId: "harness-1",
    observationSchemaVersion: "v1",
    candidatePolicyVersion: "policy-1",
    runId: "run-1",
    taskId: "task-1",
    productionOccurrenceId: "occ-1",
    classification: "VALIDATED",
    diversityDimensions: {},
    unsafeFalsePositive: false,
    observerOverheadMs: 5,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("FG-11 campaign aggregator", () => {
  it("counts total/eligible/validated/invalidated/incomplete/insufficient correctly", () => {
    const records = [
      record({ classification: "VALIDATED", projected: { pageTransmissions: 1 } }),
      record({ classification: "VALIDATED", projected: { pageTransmissions: 1 } }),
      record({ classification: "INVALIDATED" }),
      record({ classification: "INCOMPLETE" }),
      record({ classification: "INSUFFICIENT_EVIDENCE" }),
    ];
    const aggregate = aggregateCandidate("B", records);
    expect(aggregate.total).toBe(5);
    expect(aggregate.validated).toBe(2);
    expect(aggregate.invalidated).toBe(1);
    expect(aggregate.incomplete).toBe(1);
    expect(aggregate.insufficientEvidence).toBe(1);
    expect(aggregate.eligible).toBe(3); // validated + invalidated
    expect(aggregate.projectedTotals.pageTransmissions).toBe(2);
  });

  it("never coerces INCOMPLETE/INSUFFICIENT_EVIDENCE into a forced classification", () => {
    const records = [record({ classification: "INCOMPLETE" }), record({ classification: "INSUFFICIENT_EVIDENCE" })];
    const aggregate = aggregateCandidate("B", records);
    expect(aggregate.validated).toBe(0);
    expect(aggregate.invalidated).toBe(0);
    expect(aggregate.eligible).toBe(0);
  });

  it("surfaces unsafe false positives with their control case and reason", () => {
    const records = [record({ classification: "VALIDATED", unsafeFalsePositive: true, controlCase: "changed_content", falsePositiveReason: "content differed" })];
    const aggregate = aggregateCandidate("B", records);
    expect(aggregate.unsafeFalsePositives).toBe(1);
    expect(aggregate.unsafeFalsePositiveDetails[0]?.controlCase).toBe("changed_content");
  });

  it("tracks diversity dimensions and unique runs/fingerprints", () => {
    const records = [
      record({ runId: "run-1", evidenceFingerprint: "fp-1", diversityDimensions: { repositoryState: "s1" } }),
      record({ runId: "run-2", evidenceFingerprint: "fp-2", diversityDimensions: { repositoryState: "s2" } }),
      record({ runId: "run-2", evidenceFingerprint: "fp-2", diversityDimensions: { repositoryState: "s2" } }),
    ];
    const aggregate = aggregateCandidate("B", records);
    expect(aggregate.uniqueRuns).toBe(2);
    expect(aggregate.uniqueFingerprints).toBe(2);
    expect(aggregate.diversityDimensions.repositoryState?.sort()).toEqual(["s1", "s2"]);
  });

  it("computes observer overhead totals/mean/median/max", () => {
    const records = [record({ observerOverheadMs: 10 }), record({ observerOverheadMs: 20 }), record({ observerOverheadMs: 30 })];
    const aggregate = aggregateCandidate("B", records);
    expect(aggregate.observerOverhead.totalMs).toBe(60);
    expect(aggregate.observerOverhead.meanMs).toBe(20);
    expect(aggregate.observerOverhead.medianMs).toBe(20);
    expect(aggregate.observerOverhead.maxMs).toBe(30);
  });

  it("never silently combines a different (sourceState, harness) bucket into the authoritative report (amendment §1)", () => {
    const authoritative = { certifiedSourceStateId: "state-2", campaignHarnessId: "harness-2" };
    const records = [
      record({ certifiedSourceStateId: "state-1", campaignHarnessId: "harness-1", classification: "VALIDATED" }), // stale bucket
      record({ certifiedSourceStateId: "state-2", campaignHarnessId: "harness-2", classification: "VALIDATED" }), // current bucket
    ];
    const report = buildCampaignAggregateReport(records, authoritative);
    expect(report.candidates.B.total).toBe(1);
    expect(report.excludedBuckets).toEqual([{ certifiedSourceStateId: "state-1", campaignHarnessId: "harness-1", observationCount: 1 }]);
  });
});
