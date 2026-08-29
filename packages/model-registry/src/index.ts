export type RefreshResult = { added: number; updated: number };

export {
  FREE_CATALOG,
  PAID_CATALOG,
  ALL_CATALOG,
  PROVIDER_META,
  MUSE_SPARK_1_2,
  GENERIC_FREE_MODEL,
  MUSE_SPARK_PAID,
  MUSE_SPARK_CONTRIBUTOR_PAID,
  createMuseSparkRecord,
  createGenericFreeRecord,
  createMuseSparkPaidRecord,
  createMuseSparkContributorPaidRecord,
} from "@codeforge/forge-zero";

// --- Normalized model registry (Phase 1): upstream facts + CodeForge verification overlay ---
export * from "./normalized-types.js";
export * from "./provider-policy.js";
export * from "./models-dev.js";
export * from "./overlay.js";
export * from "./registry.js";
export * from "./discovery.js";
export { MODELS_DEV_SNAPSHOT, MODELS_DEV_SNAPSHOT_CAPTURED_AT } from "./snapshot.js";

/**
 * Packaged model knowledge for CodeForge.
 * Ships with provider adapters, model metadata, routing metadata,
 * free/paid classification, capabilities, benchmarks, and verification logic.
 * Users do not edit source to use supported models — they connect credentials
 * via EnvironmentCredentialStore (OPENCODE_API_KEY / OPENROUTER_API_KEY) and
 * CodeForge validates via ForgeZero.
 */
export const PACKAGED_PROVIDERS = ["opencode", "openrouter", "codeforge"] as const;

/**
 * FreshModelRegistry is currently a stub/fallback.
 * Production model discovery is static via FREE_CATALOG/PAID_CATALOG in @codeforge/forge-zero.
 * Live provider state is reflected only through health/status and verifier expiry,
 * not dynamic discovery. This is intentional fallback until live catalog sync is
 * implemented. Static catalog never overrides live provider ineligibility because
 * ForgeZero remains authoritative.
 *
 * Future dynamic discovery lifecycle must remain:
 * DISCOVERED -> CANDIDATE -> VERIFIED -> ELIGIBLE -> AUTHORIZED
 * Discovery never becomes authority.
 */
export class FreeModelRegistry {
  register(model: unknown): void {}
  all(): unknown[] { return []; }
}

export function createRegistry(): FreeModelRegistry {
  return new FreeModelRegistry();
}
