import { describe, expect, it } from "vitest";
import { FailureCorpusStore, failureCorpusSeedFromAttempt, type CodeForgeBenchR2Attempt } from "../src/index.js";

const failedAttempt: CodeForgeBenchR2Attempt = {
  caseId: "CBR2-PF-01",
  status: "failed",
  verified: false,
  hiddenAcceptance: "failed",
  runId: "run-failure",
  attemptNumber: 1,
  recordedAt: "2026-09-17T12:00:00.000Z",
  repositoryCommit: "repo-commit",
  codeforgeCommit: "codeforge-commit",
  mode: "auto",
  configDigest: "config-digest",
  metrics: { fileReads: 2, searches: 3, repeatedSearches: 1, toolCalls: 5, contextTokens: 400 },
  failure: {
    failureMode: "empty_completion",
    lastCorrectState: "request dispatched",
    incorrectAction: "treated empty output as success",
    verifierFindings: ["no useful completion"],
    hypothesizedLayer: "provider",
  },
};

describe("R9 failure corpus", () => {
  it("records sanitized, bounded failure evidence without a transcript", () => {
    const store = new FailureCorpusStore(1);
    const record = store.record(failureCorpusSeedFromAttempt(failedAttempt, "provider", "Provider body and credentials were not retained."));
    expect(record.sanitized).toBe(true);
    expect(record.contextState).toEqual({ filesRetrieved: 2, contextTokens: 400, repeatedRetrievals: 1 });
    expect(record.tools).toEqual({ totalCalls: 5, searches: 3, reads: 2 });
    expect(record).not.toHaveProperty("transcript");
    expect(store.list()).toHaveLength(1);
  });

  it("requires explicit redaction notes", () => {
    const store = new FailureCorpusStore();
    expect(() => store.record({
      ...failureCorpusSeedFromAttempt(failedAttempt, "provider", ""),
    })).toThrow(/redactionNotes/);
  });
});
