import { describe, expect, it } from "vitest";
import { DEFAULT_RETENTION_POLICY, classesPurgedOnErasure, classesRetainedOnErasure } from "../src/retention.js";
import { blockingClaimHits, scanTextForClaims } from "../src/claims-scanner.js";

describe("retention policy (R1 spec §26-27)", () => {
  it("never hardcodes a retention duration for security-audit or billing records", () => {
    expect(DEFAULT_RETENTION_POLICY.SECURITY_AUDIT.retentionDays).toBeNull();
    expect(DEFAULT_RETENTION_POLICY.SECURITY_AUDIT.status).toBe("BUSINESS_DECISION_REQUIRED");
    expect(DEFAULT_RETENTION_POLICY.BILLING_RECORD.retentionDays).toBeNull();
    expect(DEFAULT_RETENTION_POLICY.BILLING_RECORD.status).toBe("BUSINESS_DECISION_REQUIRED");
  });

  it("does not purge every record on erasure — security audit and billing are explicitly retained", () => {
    const purged = classesPurgedOnErasure();
    const retained = classesRetainedOnErasure();
    expect(purged).toContain("USER_CONTENT");
    expect(purged).toContain("AUTH_DATA");
    expect(purged).not.toContain("SECURITY_AUDIT");
    expect(purged).not.toContain("BILLING_RECORD");
    expect(retained).toContain("SECURITY_AUDIT");
    expect(retained).toContain("BILLING_RECORD");
    expect(retained).toContain("LEGAL_HOLD");
  });
});

describe("claims scanner (R1 spec §41, §79)", () => {
  it("flags unsupported financial/environmental/correctness/security phrases", () => {
    const hits = scanTextForClaims("README.md", "CodeForge is guaranteed free forever and has zero emissions.", "PUBLIC_MARKETING");
    const ids = hits.map((h) => h.patternId);
    expect(ids).toContain("free-forever");
    expect(ids).toContain("zero-emissions");
  });

  it("does not flag substantiated replacement phrasing", () => {
    const hits = scanTextForClaims(
      "README.md",
      "CodeForge routes exclusively through verified zero-cost allowances and is efficiency-aware.",
      "PUBLIC_MARKETING",
    );
    expect(hits).toHaveLength(0);
  });

  it("only USER_UI and PUBLIC_MARKETING hits block a release gate — historical evidence never does", () => {
    const historical = scanTextForClaims("docs/legal/pass1-legal-readiness-report.md", "the draft claimed 'zero emissions' at the time", "HISTORICAL_EVIDENCE");
    expect(blockingClaimHits(historical)).toHaveLength(0);
    const live = scanTextForClaims("README.md", "zero emissions", "PUBLIC_MARKETING");
    expect(blockingClaimHits(live)).toHaveLength(1);
  });

  it("reports accurate line numbers for multi-line input", () => {
    const hits = scanTextForClaims("x.md", "line one\nline two is bug-free\nline three", "USER_UI");
    expect(hits[0]?.line).toBe(2);
  });
});
