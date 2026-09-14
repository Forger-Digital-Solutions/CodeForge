import type { FreeModelRecord } from "@codeforge/forge-zero";
import { classifyTask, type ForgeAutoSeat, type TaskClassification, type TaskSignals } from "./classification.js";
import { scoreForSeat } from "./role-scores.js";

/**
 * Top-Four complementary team selection (R1 spec §17–§22).
 *
 * Forge Auto/Free is NOT a model and NOT a provider: given the 8-Bit-qualified free roster it
 * assembles the strongest COMPLEMENTARY 1–4 specialist team a task actually needs. Seats are
 * roles, not brands. Selection is deterministic, quota/health-aware, and fail-closed: with no
 * eligible free route the outcome is NO_ELIGIBLE_FREE_MODEL — never a silent fallback across
 * the billing/trust boundary (§23–§24).
 */

export const NO_ELIGIBLE_FREE_MODEL = "NO_ELIGIBLE_FREE_MODEL" as const;

/** A distinct-model alternative is preferred over reusing an already-seated model when it
 * scores within this margin — diversity beats a marginal score edge (§22). */
const DIVERSITY_MARGIN = 8;

export interface RouteFilters {
  /** Provider has a registered execution adapter — an eligible route with no backend cannot run. */
  hasAdapter?: (providerId: string) => boolean;
  /** 8-Bit health/cooldown exclusion. */
  isCoolingDown?: (providerId: string, modelId: string) => boolean;
  /** Full admission-pipeline filter (qualification, terms, connected). */
  isAdmitted?: (providerId: string, modelId: string) => boolean;
  /** Live per-route quota: a quota-exhausted route is skipped for NEW seat assignments. */
  isQuotaExhausted?: (providerId: string, modelId: string) => boolean;
}

export interface TeamSelectionInput {
  /** ForgeZero-eligible verified-free roster snapshot (already policy-screened upstream). */
  roster: FreeModelRecord[];
  classification: TaskClassification;
  filters?: RouteFilters;
  /** Current 8-Bit roster revision this selection was made against (§38). */
  rosterRevision?: number;
}

export interface SpecialistAssignment {
  seat: ForgeAutoSeat;
  providerId: string;
  modelId: string;
  displayName: string;
  score: number;
  /** Reason codes only (§81). */
  reasons: string[];
}

export type TeamSelection =
  | {
      outcome: "SELECTED";
      specialists: SpecialistAssignment[];
      classification: TaskClassification;
      rosterRevision?: number;
      createdAt: string;
    }
  | {
      outcome: typeof NO_ELIGIBLE_FREE_MODEL;
      reasonCodes: string[];
      classification: TaskClassification;
      createdAt: string;
    };

function seatReasons(seat: ForgeAutoSeat, model: FreeModelRecord): string[] {
  const reasons: string[] = [`selected_for_${seat.toLowerCase()}_role`];
  if (model.capabilities.toolCalling && (seat === "SWE" || seat === "VERIFIER")) reasons.push("selected_for_tool_reliability");
  if ((model.contextWindow ?? 0) >= 128_000) reasons.push("selected_for_large_context");
  if (seat === "REVIEWER") reasons.push("selected_for_independent_review");
  if (model.codingScore !== undefined && seat === "SWE") reasons.push(`selected_for_swe_score_${Math.round(model.codingScore)}`);
  if (model.health?.status === "degraded") reasons.push("route_degraded_best_available");
  return reasons;
}

export function selectForgeAutoTeam(input: TeamSelectionInput): TeamSelection {
  const createdAt = new Date().toISOString();
  const filters = input.filters ?? {};
  const usable = input.roster.filter((model) => {
    if (filters.hasAdapter && !filters.hasAdapter(model.providerId)) return false;
    if (filters.isCoolingDown?.(model.providerId, model.modelId)) return false;
    if (filters.isAdmitted && !filters.isAdmitted(model.providerId, model.modelId)) return false;
    if (filters.isQuotaExhausted?.(model.providerId, model.modelId)) return false;
    return true;
  });

  if (usable.length === 0) {
    return {
      outcome: NO_ELIGIBLE_FREE_MODEL,
      reasonCodes: [NO_ELIGIBLE_FREE_MODEL, "NO_QUALIFIED_FREE_ROUTE_AVAILABLE"],
      classification: input.classification,
      createdAt,
    };
  }

  const specialists: SpecialistAssignment[] = [];
  const taken = new Set<string>();

  for (const seat of input.classification.specialistPlan) {
    const ranked = usable
      .map((model) => ({ model, scored: scoreForSeat(model, seat) }))
      .sort((a, b) => b.scored.score - a.scored.score || (a.model.modelId < b.model.modelId ? -1 : a.model.modelId > b.model.modelId ? 1 : 0));

    // Complementarity pass: skip an already-seated model when a within-margin distinct model exists.
    const best = ranked[0];
    if (!best) continue;
    let chosen = best;
    if (taken.has(routeKey(best.model)) ) {
      const distinct = ranked.find(
        (candidate) => !taken.has(routeKey(candidate.model)) && best.scored.score - candidate.scored.score <= DIVERSITY_MARGIN,
      );
      if (distinct) chosen = distinct;
    }

    const routeK = routeKey(chosen.model);
    if (taken.has(routeK)) {
      // Roster is smaller than the seat plan: reuse is honest and better than dropping the seat.
      specialists.push({
        seat,
        providerId: chosen.model.providerId,
        modelId: chosen.model.modelId,
        displayName: chosen.model.displayName,
        score: chosen.scored.score,
        reasons: [...seatReasons(seat, chosen.model), "roster_smaller_than_plan_reused"],
      });
      continue;
    }
    taken.add(routeK);
    specialists.push({
      seat,
      providerId: chosen.model.providerId,
      modelId: chosen.model.modelId,
      displayName: chosen.model.displayName,
      score: chosen.scored.score,
      reasons: seatReasons(seat, chosen.model),
    });
  }

  if (specialists.length === 0) {
    return {
      outcome: NO_ELIGIBLE_FREE_MODEL,
      reasonCodes: [NO_ELIGIBLE_FREE_MODEL],
      classification: input.classification,
      createdAt,
    };
  }

  // The human-facing plan is planner-first, but SWE must still receive the strongest route. If
  // diversity caused another seat to reserve that route first, exchange the assignments and
  // recompute their seat-specific evidence. This keeps team presentation and primary execution
  // semantics independent.
  const sweIndex = specialists.findIndex((specialist) => specialist.seat === "SWE");
  const bestSwe = usable
    .map((model) => ({ model, score: scoreForSeat(model, "SWE") }))
    .sort((a, b) => b.score.score - a.score.score || (a.model.modelId < b.model.modelId ? -1 : a.model.modelId > b.model.modelId ? 1 : 0))[0];
  if (sweIndex >= 0 && bestSwe) {
    const holderIndex = specialists.findIndex((specialist) => routeKey(specialist) === routeKey(bestSwe.model));
    if (holderIndex >= 0 && holderIndex !== sweIndex) {
      const sweAssignment = specialists[sweIndex]!;
      const holderAssignment = specialists[holderIndex]!;
      const sweModel = usable.find((model) => routeKey(model) === routeKey(sweAssignment))!;
      const holderModel = bestSwe.model;
      specialists[sweIndex] = {
        seat: "SWE",
        providerId: holderModel.providerId,
        modelId: holderModel.modelId,
        displayName: holderModel.displayName,
        score: bestSwe.score.score,
        reasons: [...seatReasons("SWE", holderModel), ...(sweIndex > 0 ? ["roster_smaller_than_plan_reused"] : [])],
      };
      specialists[holderIndex] = {
        seat: holderAssignment.seat,
        providerId: sweModel.providerId,
        modelId: sweModel.modelId,
        displayName: sweModel.displayName,
        score: scoreForSeat(sweModel, holderAssignment.seat).score,
        reasons: [...seatReasons(holderAssignment.seat, sweModel), ...(holderIndex > sweIndex ? ["roster_smaller_than_plan_reused"] : [])],
      };
    }
  }
  return {
    outcome: "SELECTED",
    specialists,
    classification: input.classification,
    ...(input.rosterRevision !== undefined ? { rosterRevision: input.rosterRevision } : {}),
    createdAt,
  };
}

export function routeKey(model: Pick<FreeModelRecord, "providerId" | "modelId">): string {
  return `${model.providerId}::${model.modelId}`;
}

/** Convenience: classify + select in one call (what the server planning surface uses). */
export function planForgeAutoTeam(signals: TaskSignals, roster: FreeModelRecord[], filters?: RouteFilters, rosterRevision?: number): TeamSelection {
  return selectForgeAutoTeam({ roster, classification: classifyTask(signals), filters, rosterRevision });
}
