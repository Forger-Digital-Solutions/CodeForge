import { describe, expect, it } from "vitest";
import {
  buildDuplicateToolReuseDecision,
  detectDuplicateContextPageTransmission,
  detectOptionalPrefetchSuppression,
  detectReusableVerificationEvidence,
} from "../src/index.js";

describe("FG-9 candidate detection (§30 items 1-4)", () => {
  it("[1] duplicate context candidate: identical pageId+contentHash+workspaceRevision across turns is flagged", () => {
    const decision = detectDuplicateContextPageTransmission({
      runId: "r1", sessionId: "s1", sustainabilityReceiptId: undefined,
      events: [
        { pageId: "p1", contentHash: "h1", workspaceRevision: 3, turnIndex: 0 },
        { pageId: "p1", contentHash: "h1", workspaceRevision: 3, turnIndex: 2 },
      ],
    });
    expect(decision.status).toBe("PROPOSED"); // SHADOW kind, never APPLIED
    expect(decision.sourceEvidenceIds).toHaveLength(1);
    expect(decision.safetyGuards.reasonCodes).toContain("IDENTICAL_CONTENT_HASH_SAME_REVISION");
  });

  it("[2] duplicate read-only tool candidate: Candidate A builder produces a real APPLIED decision from live-shaped suppression evidence", () => {
    const result = buildDuplicateToolReuseDecision({
      runId: "r1", sessionId: "s1", sustainabilityReceiptId: "recv-1",
      events: [{ tool: "read_file", identityKeyHash: "hash1", priorExecutionId: "exec-1", avoidedBytes: 500 }],
    });
    expect(result).toBeDefined();
    expect(result!.decision.status).toBe("APPLIED");
    expect(result!.decision.mode).toBe("ACTIVE_SAFE");
    expect(result!.decision.expectedEffect.avoidedToolExecutions).toBe(1);
    expect(result!.receipt.resourceDelta.bytesAvoided).toBe(500);
  });

  it("[3] optional prefetch candidate: non-required + already-available pages are proposed for suppression", () => {
    const decision = detectOptionalPrefetchSuppression({
      runId: "r1", sessionId: "s1", sustainabilityReceiptId: undefined,
      candidates: [
        { pageId: "opt-1", required: false, alreadyValidlyAvailable: true },
        { pageId: "opt-2", required: true, alreadyValidlyAvailable: true }, // required -> never a candidate
        { pageId: "opt-3", required: false, alreadyValidlyAvailable: false }, // not available -> never a candidate
      ],
    });
    expect(decision.status).toBe("PROPOSED");
    expect(decision.sourceEvidenceIds).toEqual(["opt-1"]);
  });

  it("[4] reusable verification evidence candidate: only evidence ForgeVerify explicitly confirmed valid is proposed", () => {
    const decision = detectReusableVerificationEvidence({
      runId: "r1", sessionId: "s1", sustainabilityReceiptId: undefined,
      candidates: [
        { evidenceId: "ev-1", workspaceContentHash: "h1", policyRevision: "p1", command: "npm test", dependencyStateHash: "d1", forgeVerifyConfirmedValid: true },
        { evidenceId: "ev-2", workspaceContentHash: "h2", policyRevision: "p1", command: "npm test", dependencyStateHash: "d1", forgeVerifyConfirmedValid: false },
      ],
    });
    expect(decision.status).toBe("PROPOSED");
    expect(decision.sourceEvidenceIds).toEqual(["ev-1"]);
    expect(decision.safetyGuards.reasonCodes).toContain("FORGEVERIFY_REJECTED_SOME_CANDIDATES");
  });

  it("empty evidence never fabricates a candidate", () => {
    expect(buildDuplicateToolReuseDecision({ runId: "r1", sessionId: "s1", sustainabilityReceiptId: undefined, events: [] })).toBeUndefined();
    expect(detectDuplicateContextPageTransmission({ runId: "r1", sessionId: "s1", sustainabilityReceiptId: undefined, events: [] }).status).toBe("SKIPPED_INSUFFICIENT_EVIDENCE");
    expect(detectOptionalPrefetchSuppression({ runId: "r1", sessionId: "s1", sustainabilityReceiptId: undefined, candidates: [] }).status).toBe("SKIPPED_INSUFFICIENT_EVIDENCE");
    expect(detectReusableVerificationEvidence({ runId: "r1", sessionId: "s1", sustainabilityReceiptId: undefined, candidates: [] }).status).toBe("SKIPPED_INSUFFICIENT_EVIDENCE");
  });
});

describe("FG-9 invalidation (§30 items 5-10) — any invalidating signal degrades to no-candidate, never a fabricated reuse", () => {
  it("[5] file changed (content hash differs) invalidates a context-page duplicate candidate", () => {
    const decision = detectDuplicateContextPageTransmission({
      runId: "r1", sessionId: "s1", sustainabilityReceiptId: undefined,
      events: [
        { pageId: "p1", contentHash: "h1", workspaceRevision: 3, turnIndex: 0 },
        { pageId: "p1", contentHash: "h2-CHANGED", workspaceRevision: 3, turnIndex: 2 },
      ],
    });
    expect(decision.sourceEvidenceIds).toEqual([]);
    expect(decision.status).toBe("SKIPPED_INSUFFICIENT_EVIDENCE");
  });

  it("[6] workspace revision changed invalidates a context-page duplicate candidate even with an identical content hash", () => {
    const decision = detectDuplicateContextPageTransmission({
      runId: "r1", sessionId: "s1", sustainabilityReceiptId: undefined,
      events: [
        { pageId: "p1", contentHash: "h1", workspaceRevision: 3, turnIndex: 0 },
        { pageId: "p1", contentHash: "h1", workspaceRevision: 4, turnIndex: 2 },
      ],
    });
    expect(decision.sourceEvidenceIds).toEqual([]);
  });

  it("[7] tool arguments differing by one material field never match a duplicate-tool identity (proven at the FG-1C identity-key level: different canonical arguments produce a different fingerprint)", async () => {
    const { fingerprint } = await import("../src/index.js");
    const key1 = fingerprint({ tool: "read_file", canonicalArguments: { path: "a.ts", limit: 10 }, workstreamScope: "", policyVersion: "" });
    const key2 = fingerprint({ tool: "read_file", canonicalArguments: { path: "a.ts", limit: 20 }, workstreamScope: "", policyVersion: "" });
    expect(key1).not.toBe(key2);
  });

  it("[8] verification policy revision change invalidates a reusable-evidence candidate (represented as ForgeVerify no longer confirming validity)", () => {
    const decision = detectReusableVerificationEvidence({
      runId: "r1", sessionId: "s1", sustainabilityReceiptId: undefined,
      candidates: [{ evidenceId: "ev-1", workspaceContentHash: "h1", policyRevision: "p2-CHANGED", command: "npm test", dependencyStateHash: "d1", forgeVerifyConfirmedValid: false }],
    });
    expect(decision.sourceEvidenceIds).toEqual([]);
  });

  it("[9] dependency/config state change invalidates a reusable-evidence candidate", () => {
    const decision = detectReusableVerificationEvidence({
      runId: "r1", sessionId: "s1", sustainabilityReceiptId: undefined,
      candidates: [{ evidenceId: "ev-1", workspaceContentHash: "h1", policyRevision: "p1", command: "npm test", dependencyStateHash: "d2-CHANGED", forgeVerifyConfirmedValid: false }],
    });
    expect(decision.sourceEvidenceIds).toEqual([]);
  });

  it("[10] source content hash changed at the same path invalidates a duplicate-context candidate (distinct from a workspace revision change)", () => {
    const decision = detectDuplicateContextPageTransmission({
      runId: "r1", sessionId: "s1", sustainabilityReceiptId: undefined,
      events: [
        { pageId: "same/path.ts", contentHash: "original-hash", workspaceRevision: 1, turnIndex: 0 },
        { pageId: "same/path.ts", contentHash: "different-content-hash", workspaceRevision: 1, turnIndex: 1 },
      ],
    });
    expect(decision.sourceEvidenceIds).toEqual([]);
  });
});
