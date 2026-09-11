import type { NormalizedMeasurementInput, WasteBreakdownEntry } from "./sustainability-types.js";

/**
 * FG-8 waste taxonomy. Conservative by construction: an entry is emitted only when a source
 * quantity is actually present (defined) in the normalized input — never a guessed or zero-
 * filled value for something unknown. `prevented_waste` entries are emitted ONLY from counters
 * that are themselves mechanism-proven counterfactuals already tracked by earlier FG phases
 * (FG-1C duplicate suppression, FG-5/FG-6 verification reuse/avoidance, FG-3D context page
 * reuse) — never from a speculative baseline simulation. Baseline-engine comparisons (Baseline
 * A/B/C/D) are a separate mechanism (`baseline.ts`) and are never folded into this taxonomy as
 * if they were the same kind of proof.
 */
export function classifyWaste(input: NormalizedMeasurementInput): WasteBreakdownEntry[] {
  const entries: WasteBreakdownEntry[] = [];

  const { tokens, tools, verification, routing, context } = input;

  if (tools.toolCallCount !== undefined && tools.toolFailureCount !== undefined) {
    entries.push({
      category: "useful_work",
      quantity: Math.max(0, tools.toolCallCount - tools.toolFailureCount),
      unit: "count",
      coverage: "directly_measured",
      reasonCodes: ["successful_tool_calls"],
      requiresBaseline: false,
      baselineRef: undefined,
    });
  }

  if (routing.fallbackEvents !== undefined) {
    entries.push({
      category: "retry_overhead",
      quantity: routing.fallbackEvents,
      unit: "count",
      coverage: routing.coverage,
      reasonCodes: ["fallback_events"],
      requiresBaseline: false,
      baselineRef: undefined,
    });
  }

  if (routing.modelFailoverBlockedDispatches !== undefined) {
    entries.push({
      category: "routing_overhead",
      quantity: routing.modelFailoverBlockedDispatches,
      unit: "count",
      coverage: routing.coverage,
      reasonCodes: ["no_eligible_route_evaluations"],
      requiresBaseline: false,
      baselineRef: undefined,
    });
  }

  if (tools.toolFailureCount !== undefined) {
    entries.push({
      category: "failed_attempt_waste",
      quantity: tools.toolFailureCount,
      unit: "count",
      coverage: "directly_measured",
      reasonCodes: ["failed_tool_calls"],
      requiresBaseline: false,
      baselineRef: undefined,
    });
  }

  if (verification.obligationsGenerated !== undefined) {
    entries.push({
      category: "verification_overhead",
      quantity: verification.obligationsGenerated,
      unit: "count",
      coverage: verification.coverage,
      reasonCodes: ["verification_is_not_waste_tracked_separately"],
      requiresBaseline: false,
      baselineRef: undefined,
    });
  }

  // prevented_waste: mechanism-proven counterfactuals only.
  if (tools.duplicateActionsSuppressed !== undefined && tools.duplicateActionsSuppressed > 0) {
    entries.push({
      category: "prevented_waste",
      quantity: tools.duplicateActionsSuppressed,
      unit: "count",
      coverage: "derived_from_authoritative_telemetry",
      reasonCodes: ["fg1c_duplicate_action_supervisor_suppressed"],
      requiresBaseline: true,
      baselineRef: undefined,
    });
  }
  if (verification.rerunsAvoided !== undefined && verification.rerunsAvoided > 0) {
    entries.push({
      category: "prevented_waste",
      quantity: verification.rerunsAvoided,
      unit: "count",
      coverage: "derived_from_authoritative_telemetry",
      reasonCodes: ["fg5_verification_reruns_avoided_valid_evidence_reused"],
      requiresBaseline: true,
      baselineRef: undefined,
    });
  }
  if (verification.fullSuitesAvoided !== undefined && verification.fullSuitesAvoided > 0) {
    entries.push({
      category: "prevented_waste",
      quantity: verification.fullSuitesAvoided,
      unit: "count",
      coverage: "derived_from_authoritative_telemetry",
      reasonCodes: ["fg5_full_suite_safely_avoided_by_targeted_verification"],
      requiresBaseline: true,
      baselineRef: undefined,
    });
  }
  if (context.contextPagesReused !== undefined && context.contextPagesReused > 0) {
    entries.push({
      category: "prevented_waste",
      quantity: context.contextPagesReused,
      unit: "count",
      coverage: "derived_from_authoritative_telemetry",
      reasonCodes: ["fg3d_context_page_served_from_cache"],
      requiresBaseline: true,
      baselineRef: undefined,
    });
  }

  // context_waste: deliberately not emitted. No conservative, defensible per-run heuristic for
  // "context transmitted but not required" exists yet (would require FG-3/4 planner-level
  // necessity judgment) — omitting the entry is the honest choice, never a guessed value.
  void tokens;

  return entries;
}
