import { describe, expect, it } from "vitest";
import { freeRouteExclusionReason, materializeSponsoredRoute, transitionSponsoredOffer, type SponsoredRouteOffer } from "../src/index.js";

const now = Date.now();
const past = new Date(now - 86_400_000).toISOString();
const future = new Date(now + 86_400_000).toISOString();
const offer: SponsoredRouteOffer = {
  sponsorId: "lab-a", providerId: "sponsor-a", physicalModel: "coder-free", logicalModel: "coder",
  startAt: past, expiresAt: future, maxConcurrency: 8,
  quota: [{ unit: "requests", limit: 100, remaining: 100, resetAt: future, scope: "SPONSORED", observedAt: past, authoritative: true }],
  privacyClass: "PRIVATE_SAFE", trainingUse: "NO", allowedUse: "commercial coding agents", commercialUse: true, retentionPolicy: "none",
  admissionReceipt: { sourceDocumentation: "docs", termsEvidence: "terms", priceEvidence: "grant", privacyEvidence: "policy", verifiedAt: past, recheckAt: future, qualificationAt: past },
  status: "PROMOTED", roles: ["CODER"], qualificationReceiptId: "receipt-1", canaryReceiptId: "canary-1",
  zeroUserCost: true, zeroCodeForgeMarginalCost: true, zeroCostReceiptId: "zero-cost-1",
};

describe("sponsored Free lifecycle", () => {
  it("admits a qualified active sponsor pool with zero CodeForge marginal cost", () => {
    const route = materializeSponsoredRoute(offer, now);
    expect(route).toMatchObject({ supplyClass: "PACKAGED_FREE_SPONSORED", quotaDomainType: "SPONSOR_POOL", egressMode: "SERVER_SPONSORED", marginalCostToCodeForge: 0 });
    expect(route?.windows.find((window) => window.unit === "concurrency")?.limit).toBe(8);
    expect(freeRouteExclusionReason(route!, { paidInferenceAllowed: false, allowUserConnectedFree: true, allowDistributedUserFree: true, allowDepositUnlockedFree: false, allowSponsoredFree: true })).toBeUndefined();
  });

  it("demotes expired, unqualified, or commercially uncleared offers without a code release", () => {
    expect(materializeSponsoredRoute(offer, Date.parse(offer.expiresAt))).toBeUndefined();
    expect(materializeSponsoredRoute({ ...offer, status: "CANARY" }, now)).toBeUndefined();
    expect(materializeSponsoredRoute({ ...offer, qualificationReceiptId: "" }, now)).toBeUndefined();
    expect(materializeSponsoredRoute({ ...offer, commercialUse: false }, now)).toBeUndefined();
    expect(materializeSponsoredRoute({ ...offer, zeroCodeForgeMarginalCost: false }, now)).toBeUndefined();
    expect(materializeSponsoredRoute({ ...offer, zeroCostReceiptId: "" }, now)).toBeUndefined();
    expect(materializeSponsoredRoute({ ...offer, canaryReceiptId: undefined }, now)).toBeUndefined();
    expect(materializeSponsoredRoute({ ...offer, admissionReceipt: { ...offer.admissionReceipt, termsEvidence: "" } }, now)).toBeUndefined();
    expect(materializeSponsoredRoute({ ...offer, admissionReceipt: { ...offer.admissionReceipt, qualificationAt: future } }, now)).toBeUndefined();
    expect(materializeSponsoredRoute({ ...offer, admissionReceipt: { ...offer.admissionReceipt, verifiedAt: "invalid" } }, now)).toBeUndefined();
  });

  it("enforces terms review, qualification, and canary before promotion", () => {
    const proposal = { ...offer, status: "PROPOSAL" as const };
    expect(() => transitionSponsoredOffer(proposal, "PROMOTED", now)).toThrow("TRANSITION_DENIED");
    const review = transitionSponsoredOffer(proposal, "TERMS_REVIEW", now);
    expect(() => transitionSponsoredOffer({ ...review, commercialUse: false }, "QUALIFICATION", now)).toThrow("TERMS_EVIDENCE_REQUIRED");
    const qualification = transitionSponsoredOffer(review, "QUALIFICATION", now);
    const canary = transitionSponsoredOffer(qualification, "CANARY", now);
    expect(() => transitionSponsoredOffer({ ...canary, canaryReceiptId: undefined }, "PROMOTED", now)).toThrow("PROMOTION_EVIDENCE_REQUIRED");
    expect(transitionSponsoredOffer(canary, "PROMOTED", now).status).toBe("PROMOTED");
    expect(transitionSponsoredOffer(offer, "REVOKED", now).status).toBe("REVOKED");
    expect(materializeSponsoredRoute(transitionSponsoredOffer(offer, "REVOKED", now), now)).toBeUndefined();
    expect(() => transitionSponsoredOffer({ ...offer, expiresAt: "invalid" }, "EXPIRED", now)).toThrow("SPONSOR_NOT_EXPIRED");
  });
});
