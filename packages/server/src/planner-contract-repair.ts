import { validatePlanningCompleteness, type PlannerResult, type PlannerTask } from "@codeforge/agent";

export interface PlannerContractRepair {
  plan: PlannerResult;
  repairs: string[];
}

const EXPLICIT_CONSTRAINT = /\b(?:do not|don't|must not|must|preserve|retain|keep|avoid|never|without|only|no)\b/i;
const MAX_CONSTRAINTS = 24;
const MAX_CONSTRAINT_CHARS = 8_000;

function exactConstraintClauses(goal: string): string[] | undefined {
  const clauses = goal
    .split(/(?<=[.!?])\s+(?=[A-Z])|\r?\n/u)
    .map((clause) => clause.trim().replace(/^[*\-\s]+/, ""))
    .filter((clause) => clause.length > 0 && EXPLICIT_CONSTRAINT.test(clause));
  const selected: string[] = [];
  let characters = 0;
  for (const clause of clauses) {
    if (selected.length >= MAX_CONSTRAINTS || characters + clause.length > MAX_CONSTRAINT_CHARS) return undefined;
    selected.push(clause);
    characters += clause.length;
  }
  return selected;
}

function mergeUnique(values: readonly string[] | undefined, additions: readonly string[]): string[] {
  return [...new Set([...(values ?? []), ...additions].filter((value) => value.trim().length > 0))];
}

function uniqueId(base: string, used: Set<string>): string {
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) candidate = `${base}-${suffix++}`;
  used.add(candidate);
  return candidate;
}

function hasValidDependencyGraph(tasks: readonly PlannerTask[]): boolean {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const inDegree = new Map(tasks.map((task) => [task.id, 0]));
  const dependents = new Map(tasks.map((task) => [task.id, [] as string[]]));
  for (const task of tasks) {
    for (const dependency of task.dependencies) {
      if (!byId.has(dependency)) return false;
      dependents.get(dependency)!.push(task.id);
      inDegree.set(task.id, inDegree.get(task.id)! + 1);
    }
  }
  const ready = [...inDegree].filter(([, degree]) => degree === 0).map(([id]) => id);
  let visited = 0;
  while (ready.length > 0) {
    const id = ready.shift()!;
    visited++;
    for (const dependent of dependents.get(id)!) {
      const degree = inDegree.get(dependent)! - 1;
      inDegree.set(dependent, degree);
      if (degree === 0) ready.push(dependent);
    }
  }
  return visited === tasks.length;
}

/**
 * Repair only obligations whose source is already authoritative at runtime: the original user
 * request, supplied verification commands, and the mandatory Coder/Reviewer lifecycle. Unknown
 * planning decisions remain the Planner's responsibility and malformed graphs still fail closed.
 */
export function repairPlannerContract(
  input: { plan: PlannerResult; goal: string; verificationCommands: readonly string[] },
): PlannerContractRepair | undefined {
  const { plan, goal } = input;
  if (!goal.trim() || plan.tasks.length === 0) return undefined;
  const explicitConstraints = exactConstraintClauses(goal);
  if (!explicitConstraints) return undefined;

  const usedIds = new Set<string>();
  for (const task of plan.tasks) {
    if (!task.id.trim() || usedIds.has(task.id)) return undefined;
    usedIds.add(task.id);
  }

  let tasks: PlannerTask[] = plan.tasks.map((task) => ({ ...task, dependencies: [...task.dependencies] }));
  const repairs: string[] = [];

  // A coder that transitively depends on a reviewer violates the lifecycle — review is a
  // terminal stage and the runtime owns post-review verification. Demoting (not deleting)
  // preserves the planner's intent as verification obligations instead of producing the
  // dependency cycle the naive reviewer-linking repair would create.
  const demotedObjectives: string[] = [];
  {
    const reviewerIds = new Set(tasks.filter((t) => t.assignedRole === "reviewer").map((t) => t.id));
    if (reviewerIds.size > 0) {
      const depsById = new Map(tasks.map((t) => [t.id, t.dependencies]));
      const reachesReviewer = (task: PlannerTask): boolean => {
        const seen = new Set<string>();
        const stack = [...task.dependencies];
        while (stack.length > 0) {
          const id = stack.pop()!;
          if (reviewerIds.has(id)) return true;
          if (seen.has(id)) continue;
          seen.add(id);
          for (const dep of depsById.get(id) ?? []) stack.push(dep);
        }
        return false;
      };
      const demotedIds = new Set(tasks.filter((t) => t.assignedRole === "coder" && reachesReviewer(t)).map((t) => t.id));
      if (demotedIds.size > 0) {
        for (const task of tasks) {
          if (demotedIds.has(task.id)) demotedObjectives.push(task.objective);
          else task.dependencies = task.dependencies.filter((dep) => !demotedIds.has(dep));
        }
        tasks = tasks.filter((task) => !demotedIds.has(task.id));
        repairs.push("demoted post-review coder task(s) to runtime verification obligations");
        if (!tasks.some((t) => t.assignedRole === "coder")) return undefined;
      }
    }
  }

  let coderTasks = tasks.filter((task) => task.assignedRole === "coder");
  if (coderTasks.length === 0) {
    const id = uniqueId("runtime-coder", usedIds);
    const coder: PlannerTask = {
      id,
      title: "Implement the original user request",
      objective: goal.trim(),
      dependencies: [],
      assignedRole: "coder",
    };
    tasks.push(coder);
    coderTasks = [coder];
    repairs.push("added the mandatory Coder task using the original request verbatim");
  }

  let reviewer = tasks.find((task) => task.assignedRole === "reviewer");
  if (!reviewer) {
    const id = uniqueId("runtime-reviewer", usedIds);
    reviewer = {
      id,
      title: "Independently review the implementation",
      objective: "Review the implementation against the original user request and repository evidence.",
      dependencies: [],
      assignedRole: "reviewer",
    };
    tasks.push(reviewer);
    repairs.push("added the mandatory independent Reviewer task");
  }

  const implementationIds = coderTasks.map((task) => task.id);
  for (const reviewTask of tasks.filter((task) => task.assignedRole === "reviewer")) {
    const missingReviewerDependencies = implementationIds.filter((id) => !reviewTask.dependencies.includes(id));
    if (missingReviewerDependencies.length > 0) {
      reviewTask.dependencies = [...reviewTask.dependencies, ...missingReviewerDependencies];
      if (!repairs.includes("linked the Reviewer to every implementation task")) repairs.push("linked the Reviewer to every implementation task");
    }
  }

  const constraints = mergeUnique(plan.planningIntent?.constraints, explicitConstraints);
  const verification = mergeUnique(plan.planningIntent?.verification, [...input.verificationCommands, ...demotedObjectives]);
  if (constraints.length > (plan.planningIntent?.constraints?.length ?? 0)) {
    repairs.push("retained explicit user constraints from the original request");
  }
  if (verification.length > (plan.planningIntent?.verification?.length ?? 0)) {
    repairs.push("propagated runtime-supplied verification commands");
  }

  const repaired: PlannerResult = {
    ...plan,
    tasks,
    ...(constraints.length > 0 || verification.length > 0
      ? {
          planningIntent: {
            ...plan.planningIntent,
            ...(constraints.length > 0 ? { constraints } : {}),
            ...(verification.length > 0 ? { verification } : {}),
          },
        }
      : {}),
  };
  if (!hasValidDependencyGraph(repaired.tasks) || !validatePlanningCompleteness(goal, repaired).valid) return undefined;
  return { plan: repaired, repairs };
}
