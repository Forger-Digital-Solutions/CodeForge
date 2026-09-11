import { FORGE_GREEN_OPTIMIZATION_POLICY_VERSION, type OptimizationKind, type OptimizationPolicyMode } from "./optimization-types.js";

/**
 * FG-9 graduation registry. Explicit, versioned, per-kind — NOT a single global on/off switch.
 * "Do not force all four [candidate classes] to ACTIVE. If only one is defensible, activate
 * one." Only `DUPLICATE_READ_ONLY_TOOL_REUSE` graduates this phase: it composes the ALREADY
 * ACTIVE, already-certified FG-1C `DuplicateActionSupervisor` (this receipt framework adds
 * provenance/accounting around behavior that already happens — it introduces no new execution
 * risk). The other three kinds remain `SHADOW`: their detection logic is implemented and tested
 * against deterministic/adversarial fixtures, but is not yet wired to alter live execution.
 */
const GRADUATION_REGISTRY: Record<OptimizationKind, OptimizationPolicyMode> = {
  DUPLICATE_READ_ONLY_TOOL_REUSE: "ACTIVE_SAFE",
  DUPLICATE_CONTEXT_PAGE_TRANSMISSION: "SHADOW",
  OPTIONAL_PREFETCH_SUPPRESSION: "SHADOW",
  VERIFICATION_EVIDENCE_REUSE: "SHADOW",
};

/** Env override: forces every kind down to at most this mode (e.g. `SHADOW` to disable all live
 * effect without a code change, or `OFF` to disable ForgeGreen optimization entirely) — it can
 * only ever REDUCE a kind's effective mode, never raise a `SHADOW` kind to `ACTIVE_SAFE`. */
function modeCeiling(): OptimizationPolicyMode | undefined {
  const raw = typeof process !== "undefined" ? process.env?.CODEFORGE_FORGEGREEN_OPTIMIZATION : undefined;
  if (raw === "OFF" || raw === "SHADOW" || raw === "ACTIVE_SAFE") return raw;
  return undefined;
}

const MODE_RANK: Record<OptimizationPolicyMode, number> = { OFF: 0, SHADOW: 1, ACTIVE_SAFE: 2 };

export function resolveOptimizationMode(kind: OptimizationKind): OptimizationPolicyMode {
  const registered = GRADUATION_REGISTRY[kind] ?? "OFF";
  const ceiling = modeCeiling();
  if (ceiling === undefined) return registered;
  return MODE_RANK[ceiling] < MODE_RANK[registered] ? ceiling : registered;
}

export function isActiveSafe(kind: OptimizationKind): boolean {
  return resolveOptimizationMode(kind) === "ACTIVE_SAFE";
}

export function isAtLeastShadow(kind: OptimizationKind): boolean {
  return resolveOptimizationMode(kind) !== "OFF";
}

export function getGraduationRegistry(): Readonly<Record<OptimizationKind, OptimizationPolicyMode>> {
  return { ...GRADUATION_REGISTRY };
}

export { FORGE_GREEN_OPTIMIZATION_POLICY_VERSION };
