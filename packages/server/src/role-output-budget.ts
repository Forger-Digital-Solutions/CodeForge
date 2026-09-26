import type { AgentRoleType } from "@codeforge/agent";

/**
 * R34 Mission K: bounded output allowance reserved per dispatch by role. A writer must be
 * able to emit a large edit; structured reasoning roles (verdicts, findings, plans) measurably
 * produce far less. Reserving writer-sized output on a reviewer turn is what kept Groq's
 * 8k-TPM pools unreachable for the light roles the fabric could otherwise serve.
 */
export function outputDemandForRole(role: AgentRoleType | string): number {
  switch (role) {
    case "coder":
      return 2_048;
    case "planner":
    case "mission-planner":
    case "replanner":
      return 1_536;
    default:
      return 1_024;
  }
}

/** R41: a provider request never asks for more than this many completion tokens. */
export const ROLE_OUTPUT_HARD_CAP_TOKENS = 4_096;

/**
 * R41: headroom reserved on top of a role's answer demand when the serving route is measured
 * to reason in-band, or while the route is still undecided and any eligible candidate could
 * be a reasoning model. Sized from R40's role-qualification measurements: gpt-oss-120b starved
 * at a 120-token cap and passed at 1500; north-mini-code burned 457 reasoning tokens before
 * emitting a single answer token.
 */
export const DEFAULT_REASONING_RESERVE_TOKENS = 1_024;

/**
 * Measured evidence that one specific provider route spends completion tokens on hidden
 * reasoning before emitting answer text. Entries are time-boxed: free-tier model behavior
 * drifts, so once `expiresAtMs` passes the measurement is stale and the reserve lapses — a
 * route is re-measured rather than permanently classified.
 */
export interface ReasoningRouteProfile {
  /** Extra output tokens reserved on top of the role's answer demand. */
  reasoningReserveTokens: number;
  /** Epoch ms after which this measurement no longer applies. */
  expiresAtMs: number;
  /** Provenance of the measurement (which evaluation observed what). Audit only. */
  evidence: string;
}

/**
 * Routes with measured in-band reasoning overhead, keyed `${providerId}/${modelId}` — the
 * profile binds to a serving route, not a model family: the same canonical model behind
 * another gateway may reason differently, so there is deliberately no name-pattern matching.
 * R40 role-qualification measurements (2026-09):
 * - openrouter/cohere/north-mini-code:free — reasoningTokens=457 consumed an entire 500-token
 *   budget and the content came back empty.
 * - groq/openai/gpt-oss-120b — coder/reviewer/planner starved at a 120-token cap (the output
 *   was all reasoning); every role passed at 1500.
 */
export const DEFAULT_REASONING_ROUTE_PROFILES: Readonly<Record<string, ReasoningRouteProfile>> = {
  "openrouter/cohere/north-mini-code:free": {
    reasoningReserveTokens: DEFAULT_REASONING_RESERVE_TOKENS,
    expiresAtMs: Date.parse("2026-11-25T00:00:00.000Z"),
    evidence: "R40 role qualification: reasoningTokens=457 of a 500-token budget, empty content",
  },
  "groq/openai/gpt-oss-120b": {
    reasoningReserveTokens: DEFAULT_REASONING_RESERVE_TOKENS,
    expiresAtMs: Date.parse("2026-11-25T00:00:00.000Z"),
    evidence: "R40 role qualification: 120-token cap starved output; 1500 passed all roles",
  },
};

export interface RoleOutputBudgetInput {
  role: AgentRoleType | string;
  /**
   * The route about to serve this dispatch, when known (a pinned or already-selected route).
   * Absent at admission time — the route is the thing being decided — so the demand then
   * covers the bounded worst case any eligible candidate could end up requesting.
   */
  providerId?: string;
  modelId?: string;
  /**
   * Context room left for the completion, when known (the route's context limit minus the
   * measured prompt size). A non-positive remainder means no completion can ever fit —
   * `contextFits` reports false and the caller must decline the dispatch rather than send
   * a degenerate near-zero request.
   */
  contextTokensRemaining?: number;
  /** The run's configured per-turn output ceiling; defaults to the hard cap. */
  maxOutputTokens?: number;
  /** Injectable measured profiles; defaults to {@link DEFAULT_REASONING_ROUTE_PROFILES}. */
  profiles?: Readonly<Record<string, ReasoningRouteProfile>>;
  /** Injectable clock for profile-expiry checks. */
  now?: number;
}

export interface RoleOutputBudget {
  /**
   * Output tokens to reserve with admission. This is the dispatch's honest demand and never
   * goes below `maxTokens`, so a hold always covers what the request may emit.
   */
  outputTokenDemand: number;
  /**
   * `maxTokens` sent on the provider request for this dispatch. Zero when `contextFits`
   * is false — a value that must never reach the wire, not a request to send.
   */
  maxTokens: number;
  /**
   * Whether a provider request may be sent at all. False only when a known context
   * remainder leaves no room for a single completion token; the caller fails the
   * dispatch closed instead of masking the overflow with a 1-token request.
   */
  contextFits: boolean;
  /**
   * True only when a live measured profile for this exact route contributed reserve. An
   * unprofiled or stale route — or an undecided one — is never reported as reasoning-class.
   */
  reasoningProfileApplied: boolean;
}

/**
 * R41: bounded model-aware output budgeting for orchestrated role runs.
 *
 * The baseline answer demand comes from {@link outputDemandForRole}; a live measured
 * reasoning profile adds `reasoningReserveTokens` of headroom so hidden reasoning cannot
 * starve the final answer (the R40 failure mode). An unprofiled or stale route gets no
 * reserve — the role baseline is already generous for its real output — and is never claimed
 * to be reasoning-class. A coder keeps the full 4k it effectively had before: shrinking it
 * would truncate the patches the role exists to emit. The request is additionally bounded by
 * the run's configured output ceiling and the context room actually left.
 */
export function roleOutputBudget(input: RoleOutputBudgetInput): RoleOutputBudget {
  const profiles = input.profiles ?? DEFAULT_REASONING_ROUTE_PROFILES;
  const now = input.now ?? Date.now();
  const routeKnown = input.providerId !== undefined && input.modelId !== undefined;
  const profile = routeKnown ? profiles[`${input.providerId}/${input.modelId}`] : undefined;
  const reasoningProfileApplied = profile !== undefined && now < profile.expiresAtMs;
  const reserve = !routeKnown
    ? DEFAULT_REASONING_RESERVE_TOKENS
    : reasoningProfileApplied
      ? Math.min(profile.reasoningReserveTokens, ROLE_OUTPUT_HARD_CAP_TOKENS)
      : 0;
  const roleDemand = input.role === "coder"
    ? ROLE_OUTPUT_HARD_CAP_TOKENS
    : outputDemandForRole(input.role);
  const outputTokenDemand = Math.max(1, Math.min(
    ROLE_OUTPUT_HARD_CAP_TOKENS,
    input.maxOutputTokens ?? ROLE_OUTPUT_HARD_CAP_TOKENS,
    roleDemand + reserve,
  ));
  const contextFit = input.contextTokensRemaining === undefined
    ? undefined
    : Math.max(0, Math.floor(input.contextTokensRemaining));
  return {
    outputTokenDemand,
    maxTokens: contextFit === undefined ? outputTokenDemand : Math.min(outputTokenDemand, contextFit),
    contextFits: contextFit === undefined || contextFit > 0,
    reasoningProfileApplied,
  };
}
