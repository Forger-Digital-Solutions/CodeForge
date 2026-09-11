import { describe, expect, it } from "vitest";
import { buildAcceptanceRecord, needsReacceptance } from "../src/acceptance.js";
import { DEFAULT_AGE_POLICY, approveAgePolicy, isAgeAcknowledgementSatisfied } from "../src/age-policy.js";
import type { LegalDocumentVersion } from "../src/legal-documents.js";

const ACTIVE_V1: LegalDocumentVersion = {
  documentId: "terms-of-service",
  version: "1.0.0",
  status: "ACTIVE",
  effectiveAt: "2026-01-01T00:00:00.000Z",
  retiredAt: null,
  sourcePath: "test",
  contentHash: "sha256:test",
};

describe("acceptance records", () => {
  it("records exact version and mechanism, no IP or device fingerprint fields exist on the type", () => {
    const record = buildAcceptanceRecord({
      accountId: "user-1",
      documentId: "terms-of-service",
      version: "1.0.0",
      mechanism: "FIRST_RUN_ACK",
      now: new Date("2026-01-02T00:00:00.000Z"),
    });
    expect(record).toEqual({
      accountId: "user-1",
      documentId: "terms-of-service",
      version: "1.0.0",
      acceptedAt: "2026-01-02T00:00:00.000Z",
      mechanism: "FIRST_RUN_ACK",
    });
  });

  it("needsReacceptance is false when there is no active version at all", () => {
    expect(needsReacceptance(null, null)).toBe(false);
  });

  it("needsReacceptance is true when there is no prior acceptance but a version is active", () => {
    expect(needsReacceptance(null, ACTIVE_V1)).toBe(true);
  });

  it("needsReacceptance is true when a new active version supersedes the accepted one", () => {
    const prior = buildAcceptanceRecord({ accountId: "u1", documentId: "terms-of-service", version: "0.9.0", mechanism: "FIRST_RUN_ACK" });
    expect(needsReacceptance(prior, ACTIVE_V1)).toBe(true);
  });

  it("needsReacceptance is false once the exact active version has been accepted", () => {
    const prior = buildAcceptanceRecord({ accountId: "u1", documentId: "terms-of-service", version: "1.0.0", mechanism: "FIRST_RUN_ACK" });
    expect(needsReacceptance(prior, ACTIVE_V1)).toBe(false);
  });
});

describe("age policy", () => {
  it("default policy is BUSINESS_DECISION_REQUIRED with no enforced minimum age", () => {
    expect(DEFAULT_AGE_POLICY.status).toBe("BUSINESS_DECISION_REQUIRED");
    expect(DEFAULT_AGE_POLICY.minimumAge).toBeNull();
    expect(DEFAULT_AGE_POLICY.collectsBirthdate).toBe(false);
  });

  it("acknowledgement is required by default and unsatisfied without a record", () => {
    expect(isAgeAcknowledgementSatisfied(null)).toBe(false);
    expect(isAgeAcknowledgementSatisfied({ acknowledged: false, acknowledgedAt: null })).toBe(false);
    expect(isAgeAcknowledgementSatisfied({ acknowledged: true, acknowledgedAt: "2026-01-01T00:00:00.000Z" })).toBe(true);
  });

  it("approveAgePolicy requires an explicit approver identity and stamps status APPROVED", () => {
    expect(() => approveAgePolicy(DEFAULT_AGE_POLICY, { minimumAge: 18, approvedBy: "" })).toThrow();
    const approved = approveAgePolicy(DEFAULT_AGE_POLICY, { minimumAge: 18, approvedBy: "test-owner", now: new Date("2026-01-01T00:00:00.000Z") });
    expect(approved.status).toBe("APPROVED");
    expect(approved.minimumAge).toBe(18);
    expect(approved.approvedBy).toBe("test-owner");
  });
});
