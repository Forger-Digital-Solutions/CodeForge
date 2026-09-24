/**
 * A workflow run's inference-request budget, shared by every turn the run dispatches.
 *
 * The budget exists so implementation work can never starve the semantic tail of the run.
 * `primary` lanes (implementation and verification-driven repairs) may consume up to
 * `total - reserve` requests; `reserved` lanes (the independent goal-conformance review
 * and the repairs it drives) may draw on the reserve up to `total`. The lane cap bounds
 * spend; the reserve guarantees the review phase can always be *reached* — it cannot
 * guarantee the provider answers, which is why an unverdicted review is a completion
 * blocker rather than an advisory.
 */
export interface WorkflowInferenceBudget {
  readonly total: number;
  readonly reserve: number;
  used: number;
}

export type InferenceLane = "primary" | "reserved";

export function createWorkflowInferenceBudget(total: number, reserve: number): WorkflowInferenceBudget {
  if (!Number.isFinite(total) || !Number.isInteger(total) || total < 1) {
    throw new Error(`Invalid inference budget total: ${total}`);
  }
  if (!Number.isFinite(reserve) || !Number.isInteger(reserve) || reserve < 0 || reserve >= total) {
    throw new Error(`Invalid inference budget reserve: ${reserve} (total ${total})`);
  }
  return { total, reserve, used: 0 };
}

export function inferenceLaneLimit(budget: WorkflowInferenceBudget, lane: InferenceLane): number {
  return lane === "reserved" ? budget.total : budget.total - budget.reserve;
}

export function inferenceRequestsRemaining(budget: WorkflowInferenceBudget, lane: InferenceLane): number {
  return Math.max(0, inferenceLaneLimit(budget, lane) - budget.used);
}

/**
 * Charge one inference dispatch to the shared budget. Returns false when the lane's
 * partition is already exhausted — the caller must not dispatch that request.
 */
export function tryConsumeInferenceRequest(budget: WorkflowInferenceBudget, lane: InferenceLane): boolean {
  if (inferenceRequestsRemaining(budget, lane) <= 0) return false;
  budget.used += 1;
  return true;
}
