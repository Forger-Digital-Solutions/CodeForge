import type { ISessionPersistence, WorkItem } from "@codeforge/sessions";
import { PAID_AUTO_MODELS, type PaidAutoModel } from "./registry.js";

export type PaidFamilyLifecycle = "DISCOVERED" | "PROBATION" | "QUALIFIED" | "ACTIVE" | "ACTIVE_ECONOMY" | "SUPERSEDED" | "RETIRED";

export interface PaidFamilyVersion {
  model: PaidAutoModel;
  version: string;
  lifecycle: PaidFamilyLifecycle;
  /**
   * R55 wave 2: provider-side availability, observed independently of lifecycle — a
   * provider-delisted model stays ACTIVE in lifecycle terms but must never be selected.
   * Persisted records written before this field existed hydrate as `true`.
   */
  providerAvailable: boolean;
  predecessorId?: string;
  identitySource: string;
  /** Latest successful qualification evidence id (bounded string, never a payload). */
  qualificationEvidenceId?: string;
  /** Latest successful promotion (or demotion-restore) evidence id. */
  promotionEvidenceId?: string;
  updatedAt: string;
}

export interface PaidPromotionEvidence {
  role: string;
  roleQualification: "QUALIFIED" | "PROBATION" | "NOT_QUALIFIED";
  benchmarkEvidenceId: string;
  liveEvidenceId?: string;
  verifiedCompletionRate: number;
  reliability: number;
  latencyMs: number;
  inputPricePerMillion: number;
  outputPricePerMillion: number;
  shPerVerifiedTask: number | null;
  incumbentCostPerVerifiedTaskUsd: number | null;
  candidateCostPerVerifiedTaskUsd: number;
  priceSource: string;
  observedAt: string;
}

const BOOTSTRAP_VERSIONS: readonly PaidFamilyVersion[] = PAID_AUTO_MODELS.map((model) => ({
  model, version: model.canonicalModelId, lifecycle: "ACTIVE", providerAvailable: true, identitySource: model.verification.sources[0] ?? "registry-bootstrap",
  // Bootstrap versions are the registry-verified approved baseline — the stamped id names
  // that provenance explicitly so a demotion can roll back to them. It is not benchmark
  // evidence and the registry identity source stays separately retained.
  qualificationEvidenceId: `bootstrap-registry:${model.canonicalModelId}`,
  promotionEvidenceId: `bootstrap-registry:${model.canonicalModelId}`,
  updatedAt: model.verification.verifiedAt,
}));

const FAMILY_LIFECYCLES = new Set<PaidFamilyLifecycle>(["DISCOVERED", "PROBATION", "QUALIFIED", "ACTIVE", "ACTIVE_ECONOMY", "SUPERSEDED", "RETIRED"]);
const MAX_FIELD_LENGTH = 512;

function evidenceId(evidence: PaidPromotionEvidence): string {
  return evidence.liveEvidenceId ?? evidence.benchmarkEvidenceId;
}

export interface ApprovedPaidSuccessor {
  canonicalModelId: string;
  familyId: string;
  predecessorId: string;
  directProviderId: string;
  directProviderModelId: string;
  identitySource: string;
}

export class PaidFamilyCatalog {
  private versions = new Map<string, PaidFamilyVersion>();

  constructor(seed: readonly PaidFamilyVersion[] = BOOTSTRAP_VERSIONS, private readonly approvedSuccessors: readonly ApprovedPaidSuccessor[] = []) {
    this.versions = this.loadVersions(seed);
  }

  all(): PaidFamilyVersion[] { return [...this.versions.values()]; }
  /**
   * All-or-nothing reload: validation completes before the catalog changes, so a corrupt
   * durable snapshot leaves the previously valid catalog untouched.
   */
  hydrate(records: readonly PaidFamilyVersion[]): void {
    this.versions = this.loadVersions(records);
  }

  /**
   * Corrupt durable state must never silently load: duplicate version ids, malformed
   * lifecycle values, predecessor/family mismatches, and more than one ACTIVE per family
   * are rejected. Pre-R55 records missing `providerAvailable` hydrate as available.
   *
   * Two passes keep validation order-independent: pass one normalizes each record and
   * collects it; pass two validates predecessor existence/family against the *complete*
   * set, so a child persisted before its predecessor still loads.
   */
  private loadVersions(records: readonly PaidFamilyVersion[]): Map<string, PaidFamilyVersion> {
    const loaded = new Map<string, PaidFamilyVersion>();
    const activeByFamily = new Map<string, string>();
    for (const record of records) {
      if (!record || typeof record !== "object" || !record.model || typeof record.model.canonicalModelId !== "string" || record.model.canonicalModelId.length === 0) throw new Error("PAID_FAMILY_HYDRATE_INVALID");
      if (loaded.has(record.model.canonicalModelId)) throw new Error("PAID_VERSION_DUPLICATE");
      if (!FAMILY_LIFECYCLES.has(record.lifecycle)) throw new Error("PAID_LIFECYCLE_INVALID");
      if (typeof record.model.family !== "string" || record.model.family.length === 0 || record.model.family.length > MAX_FIELD_LENGTH) throw new Error("PAID_FAMILY_HYDRATE_INVALID");
      if (record.qualificationEvidenceId !== undefined && (typeof record.qualificationEvidenceId !== "string" || record.qualificationEvidenceId.length === 0 || record.qualificationEvidenceId.length > MAX_FIELD_LENGTH)) throw new Error("PAID_FAMILY_HYDRATE_INVALID");
      if (record.promotionEvidenceId !== undefined && (typeof record.promotionEvidenceId !== "string" || record.promotionEvidenceId.length === 0 || record.promotionEvidenceId.length > MAX_FIELD_LENGTH)) throw new Error("PAID_FAMILY_HYDRATE_INVALID");
      const normalized: PaidFamilyVersion = { ...record, providerAvailable: record.providerAvailable !== false };
      loaded.set(normalized.model.canonicalModelId, normalized);
      if (normalized.lifecycle === "ACTIVE") {
        if (activeByFamily.has(normalized.model.family)) throw new Error("PAID_FAMILY_ACTIVE_CONFLICT");
        activeByFamily.set(normalized.model.family, normalized.model.canonicalModelId);
      }
    }
    for (const record of loaded.values()) {
      if (record.predecessorId !== undefined) {
        const predecessor = loaded.get(record.predecessorId);
        if (!predecessor || predecessor.model.family !== record.model.family) throw new Error("PAID_FAMILY_MISMATCH");
      }
    }
    return loaded;
  }

  version(modelId: string): PaidFamilyVersion | undefined { return this.versions.get(modelId); }
  model(modelId: string): PaidAutoModel | undefined { return this.versions.get(modelId)?.model; }
  activeModels(): PaidAutoModel[] { return this.all().filter((record) => record.providerAvailable && (record.lifecycle === "ACTIVE" || record.lifecycle === "ACTIVE_ECONOMY")).map((record) => record.model); }

  discoverSuccessor(input: { model: PaidAutoModel; version: string; predecessorId: string; identitySource: string; trustedCatalogProviderId: string; observedAt: string }): PaidFamilyVersion {
    const predecessor = this.version(input.predecessorId);
    if (!predecessor || predecessor.model.family !== input.model.family) throw new Error("PAID_FAMILY_MISMATCH");
    if (this.versions.has(input.model.canonicalModelId)) throw new Error("PAID_VERSION_DUPLICATE");
    const approval = this.approvedSuccessors.find((item) => item.canonicalModelId === input.model.canonicalModelId);
    if (!approval || approval.familyId !== input.model.family || approval.predecessorId !== input.predecessorId || approval.directProviderId !== input.model.direct.providerId || approval.directProviderModelId !== input.model.direct.providerModelId || approval.identitySource !== input.identitySource || input.trustedCatalogProviderId !== input.model.direct.providerId) throw new Error("PAID_SUCCESSOR_IDENTITY_UNVERIFIED");
    if (input.model.direct.canonicalModelId !== input.model.canonicalModelId || input.model.fallback.canonicalModelId !== input.model.canonicalModelId || input.model.direct.routeId !== `${input.model.canonicalModelId}:direct` || input.model.fallback.routeId !== `${input.model.canonicalModelId}:openrouter`) throw new Error("PAID_SUCCESSOR_IDENTITY_UNVERIFIED");
    if (!input.model.direct.source || !input.model.verification.sources.includes(input.identitySource)) throw new Error("PAID_SUCCESSOR_IDENTITY_UNVERIFIED");
    const record: PaidFamilyVersion = { model: input.model, version: input.version, lifecycle: "DISCOVERED", providerAvailable: true, predecessorId: input.predecessorId, identitySource: input.identitySource, updatedAt: input.observedAt };
    this.versions.set(input.model.canonicalModelId, record);
    return record;
  }

  beginProbation(modelId: string, observedAt: string): void {
    const record = this.require(modelId);
    if (record.lifecycle !== "DISCOVERED") throw new Error("PAID_LIFECYCLE_INVALID");
    this.versions.set(modelId, { ...record, lifecycle: "PROBATION", updatedAt: observedAt });
  }

  qualify(modelId: string, evidence: PaidPromotionEvidence): void {
    const record = this.require(modelId);
    if (record.lifecycle !== "PROBATION") throw new Error("PAID_LIFECYCLE_INVALID");
    this.assertEvidence(record, evidence);
    this.versions.set(modelId, { ...record, lifecycle: "QUALIFIED", qualificationEvidenceId: evidenceId(evidence), updatedAt: evidence.observedAt });
  }

  promote(modelId: string, evidence: PaidPromotionEvidence, predecessorDisposition: "SUPERSEDED" | "ACTIVE_ECONOMY"): void {
    const record = this.require(modelId);
    if (record.lifecycle !== "QUALIFIED" || !record.predecessorId) throw new Error("PAID_LIFECYCLE_INVALID");
    this.assertEvidence(record, evidence);
    const predecessor = this.require(record.predecessorId);
    if (predecessor.model.family !== record.model.family || predecessor.lifecycle !== "ACTIVE") throw new Error("PAID_FAMILY_MISMATCH");
    if (evidence.incumbentCostPerVerifiedTaskUsd !== null && evidence.candidateCostPerVerifiedTaskUsd > evidence.incumbentCostPerVerifiedTaskUsd && evidence.verifiedCompletionRate <= 0.5) throw new Error("PAID_PROMOTION_VALUE_NOT_PROVEN");
    this.versions.set(predecessor.model.canonicalModelId, { ...predecessor, lifecycle: predecessorDisposition, updatedAt: evidence.observedAt });
    this.versions.set(modelId, { ...record, lifecycle: "ACTIVE", promotionEvidenceId: evidenceId(evidence), updatedAt: evidence.observedAt });
  }

  /**
   * R55 wave 2: demote an ACTIVE model and restore a previously qualified same-family
   * fallback. The fallback must currently sit at ACTIVE_ECONOMY or SUPERSEDED and carry
   * retained qualification/promotion evidence — a never-qualified version can never be
   * reactivated. Cross-family fallbacks are rejected by identity, never by name.
   */
  demote(activeModelId: string, fallbackModelId: string, evidence: PaidPromotionEvidence, activeDisposition: "QUALIFIED" | "RETIRED"): void {
    const active = this.require(activeModelId);
    const fallback = this.require(fallbackModelId);
    if (active.lifecycle !== "ACTIVE") throw new Error("PAID_LIFECYCLE_INVALID");
    if (active.model.family !== fallback.model.family) throw new Error("PAID_FAMILY_MISMATCH");
    if (!fallback.providerAvailable) throw new Error("PAID_FALLBACK_UNAVAILABLE");
    if (fallback.lifecycle !== "ACTIVE_ECONOMY" && fallback.lifecycle !== "SUPERSEDED") throw new Error("PAID_LIFECYCLE_INVALID");
    if (!fallback.qualificationEvidenceId && !fallback.promotionEvidenceId) throw new Error("PAID_DEMOTION_EVIDENCE_MISSING");
    this.assertEvidence(fallback, evidence);
    this.versions.set(fallbackModelId, { ...fallback, lifecycle: "ACTIVE", promotionEvidenceId: evidenceId(evidence), updatedAt: evidence.observedAt });
    this.versions.set(activeModelId, { ...active, lifecycle: activeDisposition, updatedAt: evidence.observedAt });
  }

  /**
   * Provider-side availability signal — never mutates lifecycle, qualification, or
   * retained evidence. A provider-unavailable ACTIVE model stops serving immediately.
   */
  setProviderAvailability(modelId: string, available: boolean, observedAt: string): void {
    const record = this.require(modelId);
    if (Number.isNaN(Date.parse(observedAt))) throw new Error("PAID_FAMILY_TIMESTAMP_INVALID");
    this.versions.set(modelId, { ...record, providerAvailable: available, updatedAt: observedAt });
  }

  retire(modelId: string, observedAt: string): void {
    const record = this.require(modelId);
    this.versions.set(modelId, { ...record, lifecycle: "RETIRED", updatedAt: observedAt });
  }

  updateDirectPricing(modelId: string, pricing: PaidAutoModel["direct"]["pricing"]): void {
    const record = this.require(modelId);
    if (pricing.status !== "CURRENT" || !pricing.source || !pricing.lastVerified || pricing.inputCostPerMillion === null || pricing.outputCostPerMillion === null || pricing.inputCostPerMillion < 0 || pricing.outputCostPerMillion < 0) throw new Error("PAID_PRICE_UNVERIFIED");
    this.versions.set(modelId, { ...record, model: { ...record.model, direct: { ...record.model.direct, pricing } }, updatedAt: pricing.lastVerified });
  }

  resolveFamily(familyId: string): PaidFamilyVersion | undefined {
    return this.all().find((record) => record.model.family === familyId && record.lifecycle === "ACTIVE" && record.providerAvailable);
  }

  private require(modelId: string): PaidFamilyVersion {
    const record = this.versions.get(modelId);
    if (!record) throw new Error("PAID_MODEL_UNKNOWN");
    return record;
  }

  private assertEvidence(record: PaidFamilyVersion, evidence: PaidPromotionEvidence): void {
    if (evidence.roleQualification !== "QUALIFIED" || !evidence.benchmarkEvidenceId || !evidence.liveEvidenceId || !evidence.priceSource || evidence.inputPricePerMillion < 0 || evidence.outputPricePerMillion < 0 || !Number.isFinite(evidence.candidateCostPerVerifiedTaskUsd) || evidence.verifiedCompletionRate < 0 || evidence.verifiedCompletionRate > 1 || evidence.reliability < 0 || evidence.reliability > 1 || evidence.latencyMs < 0 || !record.model.capabilities.toolCalling || record.model.contextWindow <= 0) throw new Error("PAID_PROMOTION_EVIDENCE_INSUFFICIENT");
    // Retained evidence is bounded identity only — never a benchmark payload.
    if (evidence.benchmarkEvidenceId.length > MAX_FIELD_LENGTH || evidence.liveEvidenceId.length > MAX_FIELD_LENGTH || evidence.priceSource.length > MAX_FIELD_LENGTH) throw new Error("PAID_PROMOTION_EVIDENCE_INSUFFICIENT");
  }
}

export class PaidFamilyCatalogStore {
  private readonly id = "paid-family-catalog-v1";
  constructor(private readonly persistence: ISessionPersistence, private readonly approvedSuccessors: readonly ApprovedPaidSuccessor[] = []) {}
  async save(catalog: PaidFamilyCatalog): Promise<void> {
    await this.persistence.upsertWorkItem({ id: this.id, kind: "paid_family_catalog", versions: catalog.all() } as unknown as WorkItem);
  }
  async load(): Promise<PaidFamilyCatalog> {
    const item = await this.persistence.getWorkItem(this.id) as unknown as { versions?: PaidFamilyVersion[] } | undefined;
    return item?.versions ? new PaidFamilyCatalog(item.versions, this.approvedSuccessors) : new PaidFamilyCatalog(undefined, this.approvedSuccessors);
  }
}
