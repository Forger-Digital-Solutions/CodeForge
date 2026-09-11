import { describe, expect, it } from "vitest";
import {
  buildDuplicateToolReuseDecision,
  detectDuplicateContextPageTransmission,
  detectOptionalPrefetchSuppression,
  detectReusableVerificationEvidence,
} from "../src/index.js";

describe("FG-9 privacy (§30 items 31-33)", () => {
  it("[31] no prompt content anywhere in a decision/receipt built from evidence carrying a prompt-shaped extra field", () => {
    const secretPrompt = "please implement the login form using hunter2 as a test password";
    const result = buildDuplicateToolReuseDecision({
      runId: "r1", sessionId: "s1", sustainabilityReceiptId: undefined,
      events: [{ tool: "read_file", identityKeyHash: "h1", priorExecutionId: "e1", avoidedBytes: 10, promptText: secretPrompt } as unknown as { tool: string; identityKeyHash: string; priorExecutionId: string; avoidedBytes: number }],
    })!;
    expect(JSON.stringify(result.decision)).not.toContain(secretPrompt);
    expect(JSON.stringify(result.receipt)).not.toContain(secretPrompt);
  });

  it("[32] no source content anywhere — only ids/hashes/counts, confirmed by scanning a decision built from content-shaped evidence", () => {
    const decision = detectDuplicateContextPageTransmission({
      runId: "r1", sessionId: "s1", sustainabilityReceiptId: undefined,
      events: [
        { pageId: "src/secret-module.ts", contentHash: "h1", workspaceRevision: 1, turnIndex: 0 },
        { pageId: "src/secret-module.ts", contentHash: "h1", workspaceRevision: 1, turnIndex: 1 },
      ],
    });
    // Only the page identity (a path-as-id, already used identically across the existing FG-3
    // context-page architecture) and hash appear — never file body content.
    expect(decision.sourceEvidenceIds[0]).toContain("src/secret-module.ts"); // an id, not content
    expect(JSON.stringify(decision)).not.toMatch(/export |function |const |import /); // no code syntax leaked
  });

  it("[33] no secrets: an evidence object carrying a secret-shaped extra field never appears in a shadow decision's JSON", () => {
    const secret = "sk-live-should-never-appear";
    const decision = detectReusableVerificationEvidence({
      runId: "r1", sessionId: "s1", sustainabilityReceiptId: undefined,
      candidates: [{ evidenceId: "ev-1", workspaceContentHash: "h1", policyRevision: "p1", command: "npm test", dependencyStateHash: "d1", forgeVerifyConfirmedValid: true, apiKey: secret } as unknown as { evidenceId: string; workspaceContentHash: string; policyRevision: string; command: string; dependencyStateHash: string; forgeVerifyConfirmedValid: boolean }],
    });
    expect(JSON.stringify(decision)).not.toContain(secret);

    const prefetchDecision = detectOptionalPrefetchSuppression({
      runId: "r1", sessionId: "s1", sustainabilityReceiptId: undefined,
      candidates: [{ pageId: "p1", required: false, alreadyValidlyAvailable: true, envVar: secret } as unknown as { pageId: string; required: boolean; alreadyValidlyAvailable: boolean }],
    });
    expect(JSON.stringify(prefetchDecision)).not.toContain(secret);
  });
});

describe("FG-9 authority regression (§30 items 34-37) — no model-selection, approval, verification-verdict, or completion authority", () => {
  it("[34] no field on a decision or receipt represents a model-selection choice", () => {
    const result = buildDuplicateToolReuseDecision({
      runId: "r1", sessionId: "s1", sustainabilityReceiptId: undefined,
      events: [{ tool: "read_file", identityKeyHash: "h1", priorExecutionId: "e1", avoidedBytes: 10 }],
    })!;
    const forbidden = /^(selectedmodel|selectedprovider|chosenmodel|routedmodel)$/i;
    expect(Object.keys(result.decision).some((k) => forbidden.test(k))).toBe(false);
    expect(Object.keys(result.receipt).some((k) => forbidden.test(k))).toBe(false);
  });

  it("[35] no field represents an approval decision — a decision's own status is a resource-governance state, not a permission grant", () => {
    const result = buildDuplicateToolReuseDecision({
      runId: "r1", sessionId: "s1", sustainabilityReceiptId: undefined,
      events: [{ tool: "read_file", identityKeyHash: "h1", priorExecutionId: "e1", avoidedBytes: 10 }],
    })!;
    const forbidden = /^(approval|approved|permissiongranted|authorized)$/i;
    expect(Object.keys(result.decision).some((k) => forbidden.test(k))).toBe(false);
  });

  it("[36] Candidate D's own construction proves FG-9 never independently judges verification validity — reuse is proposed ONLY when the caller supplies an explicit ForgeVerify confirmation, never computed by FG-9 from the evidence shape alone", () => {
    const withoutForgeVerifyConfirmation = detectReusableVerificationEvidence({
      runId: "r1", sessionId: "s1", sustainabilityReceiptId: undefined,
      // Evidence LOOKS perfectly valid/matching — but forgeVerifyConfirmedValid is false.
      candidates: [{ evidenceId: "ev-1", workspaceContentHash: "h1", policyRevision: "p1", command: "npm test", dependencyStateHash: "d1", forgeVerifyConfirmedValid: false }],
    });
    expect(withoutForgeVerifyConfirmation.sourceEvidenceIds).toEqual([]);
    expect(withoutForgeVerifyConfirmation.status).toBe("SKIPPED_INSUFFICIENT_EVIDENCE");
  });

  it("[37] no field represents a task/completion verdict on any decision or receipt", () => {
    const result = buildDuplicateToolReuseDecision({
      runId: "r1", sessionId: "s1", sustainabilityReceiptId: undefined,
      events: [{ tool: "read_file", identityKeyHash: "h1", priorExecutionId: "e1", avoidedBytes: 10 }],
    })!;
    const forbidden = /^(taskcomplete|completionstatus|verificationverdict|verificationpassed)$/i;
    expect(Object.keys(result.decision).some((k) => forbidden.test(k))).toBe(false);
    expect(Object.keys(result.receipt).some((k) => forbidden.test(k))).toBe(false);
    // qualityResult is an FG-9-internal equivalence classification, never fed to Completion Gate.
    expect(result.receipt.qualityResult).toBe("EQUIVALENT");
  });
});
