import type { CodeForgeOverlay, ModelRecord } from "./normalized-types.js";
import { canonicalId } from "./normalized-types.js";
import { ZERO_UNIT_ACCESS } from "@codeforge/forge-zero";

/**
 * In-memory store of CodeForge verification overlays, keyed by canonical id.
 * Kept INDEPENDENT of upstream facts: the registry never lets Models.dev metadata write here.
 */
export class OverlayStore {
  private readonly overlays = new Map<string, CodeForgeOverlay>();

  get(providerId: string, modelId: string): CodeForgeOverlay | undefined {
    return this.overlays.get(canonicalId(providerId, modelId));
  }

  getById(id: string): CodeForgeOverlay | undefined {
    return this.overlays.get(id);
  }

  /** Shallow-merge new evidence into any existing overlay for the model. */
  merge(overlay: CodeForgeOverlay): void {
    const key = canonicalId(overlay.providerId, overlay.modelId);
    const existing = this.overlays.get(key);
    this.overlays.set(key, existing ? { ...existing, ...overlay } : overlay);
  }

  set(overlay: CodeForgeOverlay): void {
    this.overlays.set(canonicalId(overlay.providerId, overlay.modelId), overlay);
  }

  clear(providerId: string, modelId: string): boolean {
    return this.overlays.delete(canonicalId(providerId, modelId));
  }

  all(): CodeForgeOverlay[] {
    return [...this.overlays.values()];
  }
}

export interface VerifyFreeOptions {
  now?: () => Date;
  /**
   * Evidence that a live, connected provider actually lists this model at $0
   * (cross-check of live provider catalog against Models.dev). Required for zero-unit
   * verification so Models.dev metadata alone can NEVER produce VERIFIED FREE.
   */
  confirmedByLiveCatalog: boolean;
  method?: string;
}

/**
 * Build overlay evidence marking a ZERO-UNIT (FREE_NATIVE / FREE_ROUTED) model as verified-free.
 * Returns null when the model is not zero-unit or live confirmation is missing — the caller must
 * then leave the model unverified (candidate only), keeping it out of Auto routing.
 */
export function verifyZeroUnitFree(
  record: ModelRecord,
  opts: VerifyFreeOptions,
): CodeForgeOverlay | null {
  if (!ZERO_UNIT_ACCESS.includes(record.accessClass)) return null;
  if (record.pricing.inputPerMillion !== 0 || record.pricing.outputPerMillion !== 0) return null;
  if (!opts.confirmedByLiveCatalog) return null;
  const nowIso = (opts.now ?? (() => new Date()))().toISOString();
  return {
    providerId: record.providerId,
    modelId: record.modelId,
    verifiedFree: true,
    freeVerification: {
      verifiedAt: nowIso,
      method: opts.method ?? "pricing+live-catalog",
      source: record.upstreamSource,
    },
    lastVerified: nowIso,
    verificationSource: "pricing+live-catalog",
    providerHealth: { status: "healthy", lastSuccess: nowIso },
  };
}

/**
 * Build overlay evidence marking an ALLOWANCE/PROMO free model as verified via a live probe.
 * Requires an actual successful probe result — never awarded from pricing alone.
 */
export function verifyAllowanceFree(
  record: ModelRecord,
  opts: { now?: () => Date; probeSucceeded: boolean; method?: string },
): CodeForgeOverlay | null {
  if (record.accessClass !== "FREE_ALLOWANCE" && record.accessClass !== "FREE_PROMO") return null;
  if (!opts.probeSucceeded) return null;
  const nowIso = (opts.now ?? (() => new Date()))().toISOString();
  return {
    providerId: record.providerId,
    modelId: record.modelId,
    verifiedFree: true,
    freeVerification: {
      verifiedAt: nowIso,
      method: opts.method ?? "live-probe",
      source: record.upstreamSource,
    },
    lastVerified: nowIso,
    verificationSource: "live-probe",
    providerHealth: { status: "healthy", lastSuccess: nowIso },
  };
}
