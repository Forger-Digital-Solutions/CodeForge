export interface PlanningIntent {
  targetSelection?: readonly string[];
  constraints?: readonly string[];
  uncertainties?: readonly string[];
  verification?: readonly string[];
  completionEvidence?: readonly string[];
}

export interface PlanningTaskShape {
  id: string;
  title: string;
  objective: string;
  dependencies: readonly string[];
  assignedRole?: string;
}

export interface PlanningCandidateShape {
  summary: string;
  tasks: readonly PlanningTaskShape[];
  planningIntent?: PlanningIntent;
}

export type PlanningComplexity = "trivial" | "standard" | "complex";

export interface PlanningCompletenessResult {
  valid: boolean;
  complexity: PlanningComplexity;
  requiredDimensions: readonly string[];
  missingDimensions: readonly string[];
}

function textOf(plan: PlanningCandidateShape): string {
  return [
    plan.summary,
    ...plan.tasks.flatMap((task) => [task.title, task.objective]),
    ...(plan.planningIntent?.targetSelection ?? []),
    ...(plan.planningIntent?.constraints ?? []),
    ...(plan.planningIntent?.uncertainties ?? []),
    ...(plan.planningIntent?.verification ?? []),
    ...(plan.planningIntent?.completionEvidence ?? []),
  ].join(" ").toLowerCase();
}

function hasSignal(text: string, words: readonly string[]): boolean {
  return words.some((word) => text.includes(word));
}

/**
 * Check planning obligations against the task, not against a fixed verbose template. A tiny
 * local fix can remain a one-task plan; routing, ambiguity, safety, and multi-file work must
 * carry the corresponding intent before a coder is allowed to start.
 */
export function validatePlanningCompleteness(goal: string, plan: PlanningCandidateShape): PlanningCompletenessResult {
  const goalText = goal.trim().toLowerCase();
  const planText = textOf(plan);
  const complexity: PlanningComplexity =
    plan.tasks.length > 2 || hasSignal(goalText, ["multi-file", "distributed", "migration", "restart", "recovery", "security", "high-context", "cross-package", "subagent"])
      ? "complex"
      : plan.tasks.length > 1 || goalText.length > 80 || hasSignal(goalText, ["implement", "repair", "change", "fix", "compare", "review"])
        ? "standard"
        : "trivial";

  const required: string[] = [];
  if (hasSignal(goalText, ["select", "selection", "route", "routing", "provider", "model", "exact", "adaptive", "choose", "capacity"])) required.push("target_selection");
  if (complexity !== "trivial" || hasSignal(goalText, ["test", "verify", "verification", "acceptance", "repair", "fix", "review"])) required.push("verification_intent");
  if (hasSignal(goalText, ["ambiguous", "ambiguity", "underspecified", "uncertain", "unknown", "degraded", "unavailable", "assumption", "plausible"])) required.push("uncertainty_handling");
  if (hasSignal(goalText, ["preserve", "safe", "smallest", "only", "without", "boundary", "constraint", "do not"])) required.push("task_constraints");
  if (complexity === "complex") required.push("completion_evidence");

  const intent = plan.planningIntent;
  const satisfied = new Set<string>();
  if ((intent?.targetSelection?.length ?? 0) > 0 || hasSignal(planText, ["select", "selection", "route", "routing", "provider", "model", "exact", "adaptive", "target"])) satisfied.add("target_selection");
  if ((intent?.verification?.length ?? 0) > 0 || hasSignal(planText, ["test", "verify", "verification", "acceptance", "check", "proof", "pass"])) satisfied.add("verification_intent");
  if ((intent?.uncertainties?.length ?? 0) > 0 || hasSignal(planText, ["uncertain", "unknown", "assum", "risk", "fallback", "clarif"])) satisfied.add("uncertainty_handling");
  if ((intent?.constraints?.length ?? 0) > 0 || hasSignal(planText, ["preserve", "safe", "smallest", "only", "without", "boundary", "constraint", "do not"])) satisfied.add("task_constraints");
  if ((intent?.completionEvidence?.length ?? 0) > 0 || hasSignal(planText, ["evidence", "verify", "verification", "acceptance", "test", "check"])) satisfied.add("completion_evidence");

  const missingDimensions = required.filter((dimension) => !satisfied.has(dimension));
  return { valid: missingDimensions.length === 0, complexity, requiredDimensions: required, missingDimensions };
}
