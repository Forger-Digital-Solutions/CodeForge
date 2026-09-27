import { PAID_AUTO_MODELS, type PaidAutoCanonicalModelId, type PaidAutoModel } from "./registry.js";

/**
 * R37 Missions Y/AA/AB — 16-Bit expected-completion-cost ranking.
 *
 * 16-Bit chooses *which* cheap-paid model to send work to; Paid Auto executes the choice.
 * The ranker is a pure function over the frozen four-model roster plus measured evidence —
 * it never executes, never authorizes spend, and never substitutes an unregistered model.
 * A cheap model that fails and retries three times is *more* expensive than a slightly
 * pricier model that verifies on the first attempt, so raw token price is a component of
 * the expected cost, not the decision.
 */

/** Measured evidence for one canonical model in one role. All fields optional — absent
 *  evidence yields conservative defaults, never fabricated precision. */
/**
 * R48: the route's measured qualification verdict for the task's role — the admission floor.
 * `QUALIFIED`/`PROBATION` are admissible evidence; `NOT_QUALIFIED`/`HARD_FAILURE` are measured
 * exclusions; `NOT_TESTED`/`STALE` are *absent* evidence (admissible only below measured tiers —
 * price must never let an unmeasured route outrank a measured-qualified one). Undefined means
 * the caller supplied no qualification evidence at all — legacy callers keep the old behavior.
 */
export type SixteenBitRoleQualification =
  | "QUALIFIED"
  | "PROBATION"
  | "NOT_QUALIFIED"
  | "HARD_FAILURE"
  | "NOT_TESTED"
  | "STALE";

export interface SixteenBitModelEvidence {
  /** Measured probability the model completes the role correctly on the first attempt (0-1). */
  successRate?: number;
  /** Measured mean failed attempts before success. Overrides successRate-derived retries. */
  expectedRetries?: number;
  /** Measured USD cost of a failed attempt (tokens spent before failure was detected). */
  failedAttemptCostUsd?: number;
  /** Measured USD to verify the attempt (deterministic checks are ~free; model review is not). */
  verificationCostUsd?: number;
  /** Measured probability this model's work needs escalation to a stronger tier (0-1). */
  escalationProbability?: number;
  /** Measured USD cost of the escalation when it occurs. */
  escalationCostUsd?: number;
  /** Measured role fit 0-1 (qualification/benchmark evidence). Breaks cost ties honestly. */
  roleFit?: number;
  /** Measured tool-call reliability 0-1 when the task requires tools. */
  toolReliability?: number;
  /** R48: the measured qualification verdict for THIS role on this route. */
  roleStatus?: SixteenBitRoleQualification;
}

export interface SixteenBitTaskProfile {
  role: string;
  /** Serialized input estimate in provider tokens (tokenizer-corrected where learned). */
  inputTokens: number;
  /** Expected bounded output tokens. */
  outputTokens: number;
  requiresTools?: boolean;
  requiredContextTokens?: number;
}

export interface SixteenBitCandidate {
  canonicalModelId: PaidAutoCanonicalModelId;
  /** Tokens × current price card for one attempt. */
  attemptCostUsd: number;
  /** Expected number of attempts including the first (1/successRate, or measured retries). */
  expectedAttempts: number;
  /** Full expected spend to a verified completion, including verification + escalation. */
  expectedCostUsd: number;
  successRate: number;
  /** True when every number above is measured rather than defaulted. */
  fullyMeasured: boolean;
  /** Structured explanation for the decision receipt. */
  reasonCodes: string[];
  /** Hard exclusion when the model physically cannot serve the task. */
  excluded?: string;
}

/**
 * R48: the ranking's admission verdict. `SELECTED` — an admissible candidate exists under the
 * role floor. `NO_QUALIFIED_ROLE_ROUTE` — every physically-admissible roster model is
 * measured-failed for this role: the caller must surface the gap honestly, never silently pick
 * a price winner. `NO_ADMISSIBLE_ROUTE` — the binding constraint is physical (context, tools,
 * price), not qualification. `UNQUALIFIED_EVIDENCE_ABSENT` — a selection was made but no role
 * verdicts were supplied at all, so price ranked without a floor (legacy callers only).
 */
export type SixteenBitSelectionStatus = "SELECTED" | "NO_QUALIFIED_ROLE_ROUTE" | "NO_ADMISSIBLE_ROUTE" | "UNQUALIFIED_EVIDENCE_ABSENT";

export interface SixteenBitRanking {
  generatedAt: string;
  task: SixteenBitTaskProfile;
  candidates: SixteenBitCandidate[];
  /** Lowest expected-cost admissible candidate; undefined when the roster cannot serve. */
  selected?: PaidAutoCanonicalModelId;
  /** Why `selected` is what it is — the typed production verdict. */
  selectionStatus: SixteenBitSelectionStatus;
}

/** Evidence is keyed by canonicalModelId and optionally per-role. */
export type SixteenBitEvidenceMap = Partial<Record<PaidAutoCanonicalModelId, SixteenBitModelEvidence>>;

/** Floor: a model with no success evidence is not assumed competent — it is assumed barely
 *  better than coin-flip so real measurements can never be worse than the default. */
const DEFAULT_SUCCESS_RATE = 0.5;
const MIN_SUCCESS_RATE = 0.05;
/** A failed attempt still spends the request's tokens until failure is detected. */
const DEFAULT_FAILED_ATTEMPT_FRACTION = 1.0;
/** Escalation is charged the *selected cheaper* model's attempt cost difference? No — it is
 *  charged the full attempt cost of whatever stronger tier the caller escalates to. When
 *  unmeasured we model it as one extra attempt at the same model's price (honest lower bound:
 *  the real escalation is at least that expensive). */
const DEFAULT_ESCALATION_PROBABILITY = 0.15;

/** Route-scoped price override for one canonical model. When the executing route is not the
 *  registry's direct route (e.g. an OpenRouter fallback with its own current price card), the
 *  ranker must price the route that would actually be dispatched, not a route it cannot use. */
export interface SixteenBitPriceOverride {
  inputCostPerMillion: number;
  outputCostPerMillion: number;
  /** Audited provenance for the override, e.g. a live catalog PriceCard source. */
  source: string;
}

export interface SixteenBitRankOptions {
  priceOverrides?: Partial<Record<PaidAutoCanonicalModelId, SixteenBitPriceOverride>>;
}

function attemptCostUsd(model: PaidAutoModel, task: SixteenBitTaskProfile, override?: SixteenBitPriceOverride): number | undefined {
  const pricing = override ?? model.direct.pricing;
  const { inputCostPerMillion, outputCostPerMillion } = pricing;
  if (inputCostPerMillion === null || outputCostPerMillion === null) return undefined;
  return (task.inputTokens / 1_000_000) * inputCostPerMillion + (task.outputTokens / 1_000_000) * outputCostPerMillion;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

export function rank16Bit(
  task: SixteenBitTaskProfile,
  evidence: SixteenBitEvidenceMap = {},
  now: () => number = () => Date.now(),
  options: SixteenBitRankOptions = {},
): SixteenBitRanking {
  const candidates: SixteenBitCandidate[] = PAID_AUTO_MODELS.map((model) => {
    const ev = evidence[model.canonicalModelId];
    const priceOverride = options.priceOverrides?.[model.canonicalModelId];
    const reasonCodes: string[] = [];

    if (task.requiredContextTokens !== undefined && model.contextWindow < task.requiredContextTokens) {
      return { canonicalModelId: model.canonicalModelId, attemptCostUsd: 0, expectedAttempts: 0, expectedCostUsd: Infinity, successRate: 0, fullyMeasured: false, reasonCodes: [], excluded: "CONTEXT_TOO_SMALL" };
    }
    if (task.requiresTools && !model.capabilities.toolCalling) {
      return { canonicalModelId: model.canonicalModelId, attemptCostUsd: 0, expectedAttempts: 0, expectedCostUsd: Infinity, successRate: 0, fullyMeasured: false, reasonCodes: [], excluded: "TOOL_UNSUPPORTED" };
    }
    // R48 qualification floor: a measured failure for this role is a hard exclusion — price
    // can never resurrect it. A stale verdict is not current evidence: it reverts to
    // unmeasured (the NOT_TESTED tier) rather than keeping its old verdict.
    if (ev?.roleStatus === "HARD_FAILURE") {
      return { canonicalModelId: model.canonicalModelId, attemptCostUsd: 0, expectedAttempts: 0, expectedCostUsd: Infinity, successRate: 0, fullyMeasured: false, reasonCodes: [], excluded: "ROLE_HARD_FAILURE" };
    }
    if (ev?.roleStatus === "NOT_QUALIFIED") {
      return { canonicalModelId: model.canonicalModelId, attemptCostUsd: 0, expectedAttempts: 0, expectedCostUsd: Infinity, successRate: 0, fullyMeasured: false, reasonCodes: [], excluded: "ROLE_NOT_QUALIFIED" };
    }

    const attempt = attemptCostUsd(model, task, priceOverride);
    if (attempt === undefined) {
      // UNKNOWN pricing is not $0 — exclude rather than fabricate a price the bill could beat.
      return { canonicalModelId: model.canonicalModelId, attemptCostUsd: 0, expectedAttempts: 0, expectedCostUsd: Infinity, successRate: 0, fullyMeasured: false, reasonCodes: [], excluded: "PRICE_UNKNOWN" };
    }
    if (priceOverride) reasonCodes.push("ROUTE_PRICED:" + priceOverride.source);

    const fullyMeasured = ev?.successRate !== undefined || ev?.expectedRetries !== undefined;
    const successRate = Math.max(
      MIN_SUCCESS_RATE,
      ev?.successRate !== undefined ? clamp01(ev.successRate) : DEFAULT_SUCCESS_RATE,
    );
    let expectedAttempts = ev?.expectedRetries !== undefined
      ? Math.max(1, ev.expectedRetries + 1)
      : 1 / successRate;
    if (task.requiresTools && ev?.toolReliability !== undefined && ev.toolReliability < 1) {
      // Tool-unreliable models burn extra failed attempts before a tool turn lands.
      expectedAttempts /= Math.max(MIN_SUCCESS_RATE, ev.toolReliability);
      reasonCodes.push("TOOL_RELIABILITY_ADJUSTED");
    }
    const failedAttempts = Math.max(0, expectedAttempts - 1);
    const failedAttemptCost = ev?.failedAttemptCostUsd ?? attempt * DEFAULT_FAILED_ATTEMPT_FRACTION;
    const verificationCost = ev?.verificationCostUsd ?? 0;
    const escalationProbability = clamp01(ev?.escalationProbability ?? DEFAULT_ESCALATION_PROBABILITY);
    // Unmeasured escalation costs at least one attempt at this model — a lower bound, since
    // escalation by definition moves to a *more* capable (more expensive) tier.
    const escalationCost = ev?.escalationCostUsd ?? attempt;

    const expectedCost = attempt + failedAttempts * failedAttemptCost + verificationCost + escalationProbability * escalationCost;
    if (!fullyMeasured) reasonCodes.push("UNMEASURED_EVIDENCE");
    if (ev?.roleFit !== undefined) reasonCodes.push("ROLE_FIT_MEASURED");
    if (ev?.roleStatus === "NOT_TESTED" || ev?.roleStatus === "STALE") reasonCodes.push("ROLE_UNMEASURED");
    if (ev?.roleStatus === "PROBATION") reasonCodes.push("ROLE_PROBATION");
    return { canonicalModelId: model.canonicalModelId, attemptCostUsd: attempt, expectedAttempts, expectedCostUsd: expectedCost, successRate, fullyMeasured, reasonCodes };
  });

  /** R48 admission tier: QUALIFIED/PROBATION are measured-admissible; NOT_TESTED/STALE/absent
   *  evidence is admissible only below them — an unmeasured route must never price-outrank a
   *  measured-qualified one. Legacy callers (no roleStatus anywhere) keep flat cost ranking. */
  const anyRoleEvidence = PAID_AUTO_MODELS.some((m) => evidence[m.canonicalModelId]?.roleStatus !== undefined);
  const admissibilityTier = (c: SixteenBitCandidate): number => {
    const status = evidence[c.canonicalModelId]?.roleStatus;
    if (!anyRoleEvidence || status === undefined) return 0;
    if (status === "QUALIFIED") return 0;
    if (status === "PROBATION") return 1;
    return 2; // NOT_TESTED / STALE — unmeasured evidence
  };

  const runnable = candidates.filter((c) => c.excluded === undefined);
  runnable.sort((a, b) => {
    const tierOrder = admissibilityTier(a) - admissibilityTier(b);
    if (tierOrder !== 0) return tierOrder;
    const costOrder = a.expectedCostUsd - b.expectedCostUsd;
    if (costOrder !== 0) return costOrder;
    // Cost tie: measured evidence beats defaults, then role fit, then a stable id order.
    const aFit = evidence[a.canonicalModelId]?.roleFit ?? 0;
    const bFit = evidence[b.canonicalModelId]?.roleFit ?? 0;
    return Number(b.fullyMeasured) - Number(a.fullyMeasured) || bFit - aFit || a.canonicalModelId.localeCompare(b.canonicalModelId);
  });
  runnable[0]?.reasonCodes.push("CHEAPER_EXPECTED_COMPLETION");
  const ranked = [...runnable, ...candidates.filter((c) => c.excluded !== undefined)];
  const selected = runnable[0]?.canonicalModelId;
  // The verdict names the binding constraint honestly: when role evidence exists and every
  // candidate that survived the physical checks was rejected by the qualification floor, the
  // failure is qualification — not capacity or price.
  const physicallyAdmissible = candidates.filter((c) => c.excluded === undefined || c.excluded.startsWith("ROLE_"));
  const selectionStatus: SixteenBitSelectionStatus = selected !== undefined
    ? (anyRoleEvidence ? "SELECTED" : "UNQUALIFIED_EVIDENCE_ABSENT")
    : anyRoleEvidence && physicallyAdmissible.length > 0 && physicallyAdmissible.every((c) => c.excluded !== undefined)
      ? "NO_QUALIFIED_ROLE_ROUTE"
      : "NO_ADMISSIBLE_ROUTE";
  return { generatedAt: new Date(now()).toISOString(), task, candidates: ranked, selected, selectionStatus };
}
