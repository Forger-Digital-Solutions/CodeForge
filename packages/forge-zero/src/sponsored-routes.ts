import type { CapacityRoute, CapacityWindow, FreeAdmissionReceipt, FreeRoutePrivacyClass, TrainingUse } from "./capacity-types.js";
import type { SignedSponsorManifest } from "./sponsor-manifests.js";

export type SponsorLifecycle = "PROPOSAL" | "TERMS_REVIEW" | "QUALIFICATION" | "CANARY" | "PROMOTED" | "EXPIRED" | "DEMOTED" | "REVOKED" | "QUARANTINED";

export interface SponsoredRouteOffer {
  sponsorId: string;
  providerId: string;
  physicalModel: string;
  logicalModel: string;
  startAt: string;
  expiresAt: string;
  maxConcurrency: number;
  quota: readonly CapacityWindow[];
  privacyClass: FreeRoutePrivacyClass;
  trainingUse: TrainingUse;
  allowedUse: string;
  commercialUse: boolean;
  retentionPolicy: string;
  admissionReceipt: FreeAdmissionReceipt;
  status: SponsorLifecycle;
  roles: readonly string[];
  qualificationReceiptId: string;
  canaryReceiptId?: string;
  zeroUserCost: boolean;
  zeroCodeForgeMarginalCost: boolean;
  zeroCostReceiptId: string;
}

export function sponsorManifestProposal(manifest: SignedSponsorManifest): SponsoredRouteOffer {
  return {
    sponsorId: manifest.sponsorId,
    providerId: manifest.providerId,
    physicalModel: manifest.physicalModel,
    logicalModel: manifest.logicalRouteId,
    startAt: manifest.startsAt,
    expiresAt: manifest.expiresAt,
    maxConcurrency: manifest.concurrency,
    quota: manifest.quota.map((window) => ({
      unit: window.unit, limit: window.limit, remaining: window.limit, resetAt: manifest.expiresAt,
      scope: "SPONSORED" as const, observedAt: manifest.issuedAt, authoritative: false, period: window.period,
      expiresAt: manifest.expiresAt,
    })),
    privacyClass: manifest.privacyClass,
    trainingUse: manifest.trainingUse,
    allowedUse: "",
    commercialUse: manifest.commercialUse,
    retentionPolicy: manifest.retentionPolicy,
    admissionReceipt: {
      sourceDocumentation: manifest.providerEvidence[0] ?? "",
      termsEvidence: "",
      priceEvidence: "",
      privacyEvidence: "",
      verifiedAt: "",
      recheckAt: "",
      qualificationAt: "",
    },
    status: "PROPOSAL",
    roles: [],
    qualificationReceiptId: "",
    zeroUserCost: manifest.zeroUserCost,
    zeroCodeForgeMarginalCost: manifest.zeroCodeForgeMarginalCost,
    zeroCostReceiptId: "",
  };
}

export function transitionSponsoredOffer(offer: SponsoredRouteOffer, next: SponsorLifecycle, now = Date.now()): SponsoredRouteOffer {
  const transitions: Record<SponsorLifecycle, readonly SponsorLifecycle[]> = {
    PROPOSAL: ["TERMS_REVIEW", "QUARANTINED"],
    TERMS_REVIEW: ["QUALIFICATION", "QUARANTINED"],
    QUALIFICATION: ["CANARY", "QUARANTINED"],
    CANARY: ["PROMOTED", "QUARANTINED"],
    PROMOTED: ["EXPIRED", "DEMOTED", "REVOKED", "QUARANTINED"],
    EXPIRED: ["TERMS_REVIEW"],
    DEMOTED: ["TERMS_REVIEW", "REVOKED", "EXPIRED"],
    REVOKED: [],
    QUARANTINED: ["TERMS_REVIEW", "EXPIRED"],
  };
  if (!transitions[offer.status].includes(next)) throw new Error("SPONSOR_LIFECYCLE_TRANSITION_DENIED");
  if (next === "QUALIFICATION" && (!offer.commercialUse || !offer.allowedUse || !offer.retentionPolicy
    || !offer.zeroUserCost || !offer.zeroCodeForgeMarginalCost || !offer.zeroCostReceiptId
    || offer.privacyClass === "UNKNOWN" || offer.trainingUse === "UNKNOWN"
    || !offer.admissionReceipt.termsEvidence || !offer.admissionReceipt.priceEvidence || !offer.admissionReceipt.privacyEvidence)) throw new Error("SPONSOR_TERMS_EVIDENCE_REQUIRED");
  if (next === "CANARY" && (!offer.qualificationReceiptId || !Number.isFinite(Date.parse(offer.admissionReceipt.qualificationAt)))) throw new Error("SPONSOR_QUALIFICATION_REQUIRED");
  if (next === "EXPIRED" && (!Number.isFinite(Date.parse(offer.expiresAt)) || Date.parse(offer.expiresAt) > now)) throw new Error("SPONSOR_NOT_EXPIRED");
  const updated = { ...offer, status: next };
  if (next === "PROMOTED" && !materializeSponsoredRoute(updated, now)) throw new Error("SPONSOR_PROMOTION_EVIDENCE_REQUIRED");
  return updated;
}

/** Materialize only a currently funded, qualified sponsor offer; expired offers disappear on refresh. */
export function materializeSponsoredRoute(offer: SponsoredRouteOffer, now = Date.now()): CapacityRoute | undefined {
  if (offer.status !== "PROMOTED" || !offer.commercialUse || !offer.allowedUse || !offer.retentionPolicy
    || !offer.zeroUserCost || !offer.zeroCodeForgeMarginalCost || !offer.zeroCostReceiptId
    || !offer.qualificationReceiptId || !offer.canaryReceiptId || !offer.admissionReceipt.qualificationAt
    || !offer.admissionReceipt.sourceDocumentation || !offer.admissionReceipt.termsEvidence
    || !offer.admissionReceipt.priceEvidence || !offer.admissionReceipt.privacyEvidence
    || !Number.isFinite(Date.parse(offer.admissionReceipt.verifiedAt)) || Date.parse(offer.admissionReceipt.verifiedAt) > now
    || !Number.isFinite(Date.parse(offer.admissionReceipt.qualificationAt)) || Date.parse(offer.admissionReceipt.qualificationAt) > now
    || !Number.isFinite(Date.parse(offer.startAt)) || !Number.isFinite(Date.parse(offer.expiresAt))
    || Date.parse(offer.startAt) > now || Date.parse(offer.expiresAt) <= now
    || !Number.isFinite(Date.parse(offer.admissionReceipt.recheckAt)) || Date.parse(offer.admissionReceipt.recheckAt) <= now
    || offer.quota.length === 0 || offer.quota.some((window) => !window.authoritative)
    || !Number.isFinite(offer.maxConcurrency) || offer.maxConcurrency < 1
    || offer.privacyClass === "UNKNOWN" || offer.trainingUse === "UNKNOWN"
    || (offer.privacyClass === "PRIVATE_SAFE" && offer.trainingUse !== "NO")) return undefined;

  const poolId = `sponsor:${offer.sponsorId}:${offer.providerId}`;
  return {
    routeId: `${poolId}:${offer.physicalModel}`,
    providerId: offer.providerId,
    modelId: offer.physicalModel,
    canonicalModelId: offer.logicalModel,
    family: offer.logicalModel,
    gateway: offer.providerId,
    supplyClass: "PACKAGED_FREE_SPONSORED",
    quotaDomainType: "SPONSOR_POOL",
    quotaDomainId: poolId,
    egressMode: "SERVER_SPONSORED",
    marginalCostToCodeForge: 0,
    freePrivacyClass: offer.privacyClass,
    trainingUse: offer.trainingUse,
    admissionReceipt: offer.admissionReceipt,
    startsAt: offer.startAt,
    expiresAt: offer.expiresAt,
    capacityPoolId: poolId,
    capacityPoolScope: "SHARED_OWNER_POOL",
    capacityScope: "SPONSORED",
    dataPolicyProfile: offer.privacyClass === "PRIVATE_SAFE" ? "PRIVATE_CODE_ALLOWED" : offer.privacyClass === "PUBLIC_CODE_ONLY" ? "PUBLIC_CODE_ONLY" : "USER_CONSENT_REQUIRED",
    lifecycle: "APPROVED",
    explicitZeroPrice: true,
    paidFallbackDisabled: true,
    managedMultiUserAllowed: true,
    privacyClass: offer.privacyClass === "PRIVATE_SAFE" ? "strict" : "permissive",
    roles: offer.roles,
    qualityScore: 0,
    healthy: true,
    enabled: true,
    windows: [...offer.quota.filter((window) => window.unit !== "concurrency"), {
      unit: "concurrency", limit: Math.floor(offer.maxConcurrency), remaining: Math.floor(offer.maxConcurrency),
      resetAt: offer.expiresAt, scope: "SPONSORED", observedAt: new Date(now).toISOString(),
      authoritative: true, expiresAt: offer.expiresAt,
    }],
  };
}
