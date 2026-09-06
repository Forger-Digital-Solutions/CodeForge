import { describe, expect, it } from "vitest";
import { createForgeGreenLedgerCollector, type ForgeGreenLedgerRecord } from "../src/index.js";

describe("FG-2 repository intelligence ledger metrics", () => {
  it("accumulates repository metrics into the existing ForgeGreen ledger without a second telemetry system", () => {
    const ledger = createForgeGreenLedgerCollector({ runId: "fg2-ledger", operation: "agent_run", namespace: "ws-fg2" });

    ledger.recordRepositoryRefresh({ filesParsed: 12, filesReused: 88, parseCacheHits: 7, invalidations: 2 });
    // Exactly-once per refresh: a second no-work refresh contributes nothing.
    ledger.recordRepositoryRefresh({ filesParsed: 0, filesReused: 0, parseCacheHits: 0, invalidations: 0 });

    const record: ForgeGreenLedgerRecord = ledger.snapshot();
    expect(record.totals.repositoryFilesReparsed).toBe(12);
    expect(record.totals.repositoryFilesReused).toBe(88);
    expect(record.totals.repositoryParseCacheHits).toBe(7);
    expect(record.totals.repositoryInvalidations).toBe(2);
    const repositoryEvents = record.events.filter((event) => event.mechanism === "repository_intelligence");
    expect(repositoryEvents).toHaveLength(4);
    expect(repositoryEvents.every((event) => event.measurement === "measured")).toBe(true);
  });

  it("never lets repository savings become authority: totals stay observational", () => {
    const ledger = createForgeGreenLedgerCollector({ runId: "fg2-ledger-authority", operation: "agent_run", namespace: "ws" });
    ledger.recordRepositoryRefresh({ filesParsed: 0, filesReused: 500, parseCacheHits: 500, invalidations: 0 });
    const record = ledger.snapshot();
    expect(record.totals.repositoryFilesReused).toBe(500);
    // The ledger record carries no decision fields of any kind.
    const decisionKeys = Object.keys(record).filter((key) => /decision|permission|approval|verdict|accept/i.test(key));
    expect(decisionKeys).toEqual([]);
  });
});
