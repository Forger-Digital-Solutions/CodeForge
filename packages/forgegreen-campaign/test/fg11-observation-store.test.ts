import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createObservationStore, type ObservationInput } from "../src/observation-store.js";

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function baseInput(overrides: Partial<ObservationInput> = {}): ObservationInput {
  return {
    candidateKind: "B",
    certifiedSourceStateId: "state-1",
    campaignHarnessId: "harness-1",
    observationSchemaVersion: "v1",
    candidatePolicyVersion: "policy-1",
    runId: "run-1",
    taskId: "task-1",
    productionOccurrenceId: "page-x:2",
    evidenceFingerprint: "fp-abc",
    classification: "VALIDATED",
    diversityDimensions: {},
    unsafeFalsePositive: false,
    projected: { pageTransmissions: 1 },
    observerOverheadMs: 0,
    ...overrides,
  };
}

describe("FG-11 ObservationStore — idempotent, restart-safe, occurrence-distinguishing persistence", () => {
  it("replaying the identical occurrence does not inflate the aggregate count (§24)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fg11-obs-store-"));
    cleanupDirs.push(dir);
    const store = createObservationStore(dir);
    const input = baseInput();
    const first = store.ingest(input);
    const second = store.ingest(input);
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(store.all("B").length).toBe(1);
  });

  it("occurrence X, replay of X, then identical evidence under a different runId Y: count is 1 then 2 (amendment §2)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fg11-obs-store-runid-"));
    cleanupDirs.push(dir);
    const store = createObservationStore(dir);
    const occurrenceX = baseInput({ runId: "run-X" });
    store.ingest(occurrenceX);
    store.ingest(occurrenceX); // replay
    expect(store.all("B").length).toBe(1);

    const occurrenceYSameEvidence = baseInput({ runId: "run-Y" });
    store.ingest(occurrenceYSameEvidence);
    expect(store.all("B").length).toBe(2);
  });

  it("a new ObservationStore instance over the same directory reconstructs identical aggregates (restart survival)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fg11-obs-store-restart-"));
    cleanupDirs.push(dir);
    const store1 = createObservationStore(dir);
    store1.ingest(baseInput({ runId: "run-1" }));
    store1.ingest(baseInput({ runId: "run-2" }));

    const store2 = createObservationStore(dir);
    expect(store2.all("B").length).toBe(2);
    // Replaying through the recreated instance still does not inflate the count.
    store2.ingest(baseInput({ runId: "run-1" }));
    expect(store2.all("B").length).toBe(2);
  });

  it("materially different evidence in the same run produces a distinct observation", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fg11-obs-store-diff-evidence-"));
    cleanupDirs.push(dir);
    const store = createObservationStore(dir);
    store.ingest(baseInput({ productionOccurrenceId: "page-x:2", evidenceFingerprint: "fp-1" }));
    store.ingest(baseInput({ productionOccurrenceId: "page-x:3", evidenceFingerprint: "fp-2" }));
    expect(store.all("B").length).toBe(2);
  });

  it("does not corrupt on a malformed trailing line (killed-process-mid-write safety)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fg11-obs-store-corrupt-"));
    cleanupDirs.push(dir);
    const store = createObservationStore(dir);
    store.ingest(baseInput({ runId: "run-1" }));
    fs.appendFileSync(path.join(dir, "candidate-b.jsonl"), "{not valid json\n");
    const store2 = createObservationStore(dir);
    expect(store2.all("B").length).toBe(1);
  });
});
