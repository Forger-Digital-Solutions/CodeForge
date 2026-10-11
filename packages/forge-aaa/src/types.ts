/**
 * ForgeAAA Auto — shared contracts.
 *
 * ForgeAAA is a game-development orchestration mode layered on CodeForge's existing
 * execution domains (managed free, managed paid via Paid Auto, user-owned API routes).
 * It never invents provider identities and never expands entitlements: every route it
 * emits must already be admissible inside its own domain's authority.
 */

export const FORGE_AAA_PROVIDER_ID = "forge-aaa";

/** User-facing lead selection policies (mission §3). */
export type ForgeAaaLeadPolicyId =
  | "auto"
  | "sol-lead"
  | "opus-lead"
  | "dual-lead"
  | "economy-lead";

/** Lifecycle truth for a discovered specialist/lead candidate (mission §4). */
export type ForgeAaaCandidateClass =
  | "VERIFIED_AVAILABLE"
  | "INTEGRATED"
  | "EXPERIMENTAL"
  | "INCOMPATIBLE"
  | "UNAVAILABLE"
  | "REJECTED";

/** Task-state vocabulary the workspace UI renders (mission §13). */
export type ForgeAaaTaskStatus =
  | "planned"
  | "generating"
  | "integrating"
  | "testing"
  | "verified"
  | "partial"
  | "blocked"
  | "failed";

/** Terminal run verdicts (mission §17). PARTIAL is never success. */
export type ForgeAaaFinalStatus =
  | "FORGEAAA_VERIFIED"
  | "FORGEAAA_PARTIAL"
  | "FORGEAAA_BLOCKED"
  | "FORGEAAA_FAILED";

export type ForgeAaaSpecialtyId =
  | "forge-architect"
  | "forge-modeler"
  | "forge-material"
  | "forge-world"
  | "forge-atmosphere"
  | "forge-character"
  | "forge-gameplay"
  | "forge-simulation"
  | "forge-audio"
  | "forge-cinematic"
  | "forge-optimizer"
  | "forge-verify";

/** Execution domain a route physically dispatches through. Mirrors the roster taxonomy
 *  without importing it — the server maps its catalog records onto these values. */
export type ForgeAaaDomain = "managed_free" | "managed_paid" | "user_api" | "local_tool" | "external_service";

export type ForgeAaaCandidateKind =
  | "lead_model"
  | "specialist_model"
  | "hosted_service"
  | "open_weight"
  | "engine_bridge"
  | "local_tool"
  | "mcp_server";

export type ForgeAaaEngineTarget = "blender-4.5" | "ue-4.27" | "ue-5" | "none" | "any";

/** Named-lead identity — set only when a route is bound to a named frontier lead via a
 *  verified provider model id. Unnamed routes are ordinary specialist/eligible supply. */
export type ForgeAaaLeadIdentity = "sol" | "opus";

export const FORGE_AAA_ERRORS = {
  LEAD_UNAVAILABLE: "FORGE_AAA_LEAD_UNAVAILABLE",
  NO_ELIGIBLE_ROUTE: "FORGE_AAA_NO_ELIGIBLE_ROUTE",
  POLICY_UNRESOLVED: "FORGE_AAA_POLICY_UNRESOLVED",
  ENGINE_NOT_FOUND: "FORGE_AAA_ENGINE_NOT_FOUND",
  ENGINE_VERSION_UNSUPPORTED: "FORGE_AAA_ENGINE_VERSION_UNSUPPORTED",
  OPERATION_DENIED: "FORGE_AAA_OPERATION_DENIED",
  OPERATION_TIMEOUT: "FORGE_AAA_OPERATION_TIMEOUT",
  MANIFEST_INVALID: "FORGE_AAA_MANIFEST_INVALID",
  ASSET_PROTECTED: "FORGE_AAA_ASSET_PROTECTED",
  ADAPTER_NOT_INTEGRATED: "FORGE_AAA_ADAPTER_NOT_INTEGRATED",
} as const;
export type ForgeAaaErrorCode = (typeof FORGE_AAA_ERRORS)[keyof typeof FORGE_AAA_ERRORS];

export class ForgeAaaError extends Error {
  constructor(readonly code: ForgeAaaErrorCode, message: string) {
    super(message);
    this.name = "ForgeAaaError";
  }
}
