/**
 * FG-3E model-aware context budget resolution.
 *
 * Responsibility boundary (FG-3 §24): 8-Bit decides WHICH route/model serves a role; this
 * module decides how to size the context delivered to that route. It never selects, swaps, or
 * pins a model — it only consumes a model's already-routed, catalog-declared `contextWindow`
 * (e.g. `FreeModelRecord.contextWindow`) when the caller supplies one.
 */

export type ContextCapacitySource = "model_catalog" | "role_default";

export interface ContextCapacity {
  maxContextTokens: number;
  /** Where `maxContextTokens` came from — never claim `model_catalog` when the model's real
   * capacity was unknown and a role default was used instead. */
  source: ContextCapacitySource;
  /** True when a known model capacity was smaller than the requested/default budget and this
   * capacity was clamped down to fit it. Exact-pin safety: FG-3 never asks 8-Bit to replace the
   * model when this is true — it only compacts what it sends. */
  clampedToModel: boolean;
}

export interface ResolveContextCapacityInput {
  /** The role/default budget that would apply with no model-specific information (e.g.
   * `AgentExecutionBudget.maxContextTokens`). This is the FG-3 §25 "safe existing default". */
  requestedTokens: number;
  /** The routed model's catalog-declared context window. Pass `undefined` — never a guess —
   * when the real value is not known; FG-3 must never fabricate model capacity (§25). */
  declaredModelContextWindow?: number;
}

/**
 * Resolves how many tokens of context may safely be built for the currently-routed model.
 * Deliberately conservative and deterministic:
 *   - Unknown model capacity -> the existing safe role default, unchanged (§25).
 *   - Known capacity smaller than requested -> clamp down to it (§27 exact-pin safety: compact,
 *     never silently swap models).
 *   - Known capacity larger than requested -> keep the requested size; more room is never by
 *     itself a reason to use more (§59/§61 — model size is not task complexity).
 */
export function resolveContextCapacity(input: ResolveContextCapacityInput): ContextCapacity {
  const declared = input.declaredModelContextWindow;
  if (typeof declared === "number" && Number.isFinite(declared) && declared > 0) {
    if (declared < input.requestedTokens) {
      return { maxContextTokens: Math.max(0, Math.floor(declared)), source: "model_catalog", clampedToModel: true };
    }
    return { maxContextTokens: input.requestedTokens, source: "model_catalog", clampedToModel: false };
  }
  return { maxContextTokens: input.requestedTokens, source: "role_default", clampedToModel: false };
}

export const CONTEXT_CAPACITY_UNKNOWN = "CONTEXT_CAPACITY_UNKNOWN" as const;

/**
 * Thrown when even the authoritative Context Kernel cannot be fit into the resolved capacity.
 * FG-3 §10/§11: a budget may never silently truncate the kernel itself (a pending approval, an
 * unconsumed steer, an already-executed side effect must always be representable) — it must
 * fail closed with an explicit, inspectable capacity problem instead.
 */
export class ContextCapacityError extends Error {
  readonly code = CONTEXT_CAPACITY_UNKNOWN;
  readonly minimumEstimatedTokens: number;
  readonly availableTokens: number;

  constructor(input: { minimumEstimatedTokens: number; availableTokens: number }) {
    super(
      `${CONTEXT_CAPACITY_UNKNOWN}: the authoritative context kernel needs an estimated ${input.minimumEstimatedTokens} tokens but only ${input.availableTokens} are available in this route's resolved budget. The kernel was not truncated.`,
    );
    this.name = "ContextCapacityError";
    this.minimumEstimatedTokens = input.minimumEstimatedTokens;
    this.availableTokens = input.availableTokens;
  }
}
