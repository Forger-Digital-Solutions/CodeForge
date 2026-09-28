import {
  type AdaptiveTopology,
  type AdaptiveTopologyPlan,
  AdaptiveTopologyPlanSchema,
} from "@codeforge/protocol";
import { adviseProviderAwareTopology, type ProviderTopologyCapacity } from "@codeforge/forge-green";

export interface ResolveAdaptiveTopologyInput {
  goal: string;
  hasImages?: boolean;
  complexityHint?: "tiny" | "normal" | "complex";
  requestedTopology?: AdaptiveTopology;
  /** Observed only after 8-Bit has admitted free routes. ForgeGreen may reduce parallelism; it
   * never selects a model, admits a route, or overrides an explicit user topology request. */
  providerCapacity?: ProviderTopologyCapacity;
  /** R45: deterministic read-plan coverage probed before spawn. When the orientation packet
   * already covers the task's candidate files and resolved symbols, a "normal" task under a
   * narrow free-capacity window can shed its dedicated explorer — the packet is delivered to
   * the coder directly at context-assembly time. Never applied to explicit requests, never
   * removes ForgeVerify. */
  orientationCoverage?: { covered: boolean; candidateFiles: number };
  /** Enables automatic Planner topology only after controlled evidence proves value for the task class. */
  plannerValueProven?: boolean;
}

/**
 * Deterministically resolves the execution topology for a task.
 *
 * Requirements (§42, §43):
 * 1. The certified R1 fixed topology (2 Explorers -> Planner -> Writer -> Reviewer -> ForgeVerify)
 *    is preserved as the authoritative default baseline.
 * 2. Adaptive options are deterministic and bounded:
 *    - tiny: Coder -> ForgeVerify
 *    - normal: Explorer -> Coder -> Reviewer -> ForgeVerify
 *    - complex: Explorer A + Explorer B -> Planner -> Writer -> Reviewer -> ForgeVerify —
 *      automatic complex selection uses the Planner only when plannerValueProven is set;
 *      an explicit complex/fixed_r1 request always preserves the Planner baseline.
 *    - vision: Vision worker + repository Explorer -> Coder -> Reviewer -> ForgeVerify
 * 3. ForgeVerify remains the non-negotiable final authority across all topologies
 *    (`requiresForgeVerify: true` is strictly enforced).
 */
export function resolveAdaptiveTopology(input: ResolveAdaptiveTopologyInput): AdaptiveTopologyPlan {
  // Explicit request takes precedence
  if (input.requestedTopology) {
    return buildTopologyPlan(input.requestedTopology, `Explicitly requested topology: ${input.requestedTopology}`);
  }

  // Vision assets present
  if (input.hasImages) {
    return capacityAwarePlan("vision", "Visual/image assets present; routes through Vision worker + Explorer", input.providerCapacity);
  }

  // Explicit complexity hint
  if (input.complexityHint === "tiny") {
    return capacityAwarePlan("tiny", "Tiny task: single targeted Coder mutation directly to ForgeVerify", input.providerCapacity);
  }
  if (input.complexityHint === "normal") {
    // R45 §17: a normal task with strong deterministic orientation coverage running against a
    // narrow free window sheds its explorer — the packet reaches the coder directly. Capacity
    // that is merely unobserved (undefined) never justifies the reduction, and the reduction
    // can never remove ForgeVerify: tiny is the floor.
    const narrow = input.providerCapacity !== undefined &&
      ((input.providerCapacity.saturatedRoutes ?? 0) > 0 ||
        input.providerCapacity.minimumRouteConcurrency <= 1 ||
        input.providerCapacity.distinctHealthyProviders <= 1);
    if (input.orientationCoverage?.covered && narrow) {
      return capacityAwarePlan("tiny", `Normal task, narrow free capacity; orientation packet covers ${input.orientationCoverage.candidateFiles} candidate files — deterministic orientation substitutes the explorer`, input.providerCapacity);
    }
    return capacityAwarePlan("normal", "Normal task: Explorer -> Coder -> Reviewer -> ForgeVerify", input.providerCapacity);
  }
  if (input.complexityHint === "complex") {
    if (input.plannerValueProven === true) {
      return capacityAwarePlan("complex", "Complex task: 2 Explorers -> Planner -> Coder -> Reviewer -> ForgeVerify", input.providerCapacity);
    }
    return capacityAwarePlan("normal", "Complex task, but Planner value is not established for this task class; using Explorer -> Coder -> Reviewer -> ForgeVerify", input.providerCapacity);
  }

  // Heuristic / deterministic goal analysis if no explicit hint:
  const lowerGoal = input.goal.toLowerCase();
  if (/\b(typo|fix comment|bump version|single line fix|docstring)\b/.test(lowerGoal)) {
    return capacityAwarePlan("tiny", "Deterministic goal match: targeted typo/one-line mutation", input.providerCapacity);
  }
  if (/\b(refactor architecture|migrate database|multi-package|system redesign)\b/.test(lowerGoal)) {
    if (input.plannerValueProven === true) {
      return capacityAwarePlan("complex", "Deterministic goal match: cross-cutting architectural change", input.providerCapacity);
    }
    return capacityAwarePlan("normal", "Cross-cutting task, but Planner value is not established for this task class; using Explorer -> Coder -> Reviewer -> ForgeVerify", input.providerCapacity);
  }

  // Certified baseline: R1 fixed topology
  return capacityAwarePlan("fixed_r1", "Default certified baseline: 2 Explorers -> Planner -> Coder -> Reviewer -> ForgeVerify", input.providerCapacity);
}

function capacityAwarePlan(topology: AdaptiveTopology, reason: string, capacity: ProviderTopologyCapacity | undefined): AdaptiveTopologyPlan {
  const plannedParallelAgents: 1 | 2 = topology === "complex" || topology === "fixed_r1" ? 2 : 1;
  const advice = adviseProviderAwareTopology(plannedParallelAgents, capacity);
  if (plannedParallelAgents === 2 && advice.shouldReduceParallelism) {
    return buildTopologyPlan("normal", `${reason}; ForgeGreen capacity advice reduced parallel exploration: ${advice.reasonCodes.join(", ")}`);
  }
  return buildTopologyPlan(topology, `${reason}; ForgeGreen capacity advice: ${advice.reasonCodes.join(", ")}`);
}

function buildTopologyPlan(topology: AdaptiveTopology, reason: string): AdaptiveTopologyPlan {
  let plan: AdaptiveTopologyPlan;

  switch (topology) {
    case "tiny":
      plan = {
        topology: "tiny",
        explorers: 0,
        hasPlanner: false,
        hasReviewer: false,
        hasVision: false,
        requiresForgeVerify: true,
        reason,
        stages: ["Coder", "ForgeVerify"],
      };
      break;

    case "normal":
      plan = {
        topology: "normal",
        explorers: 1,
        hasPlanner: false,
        hasReviewer: true,
        hasVision: false,
        requiresForgeVerify: true,
        reason,
        stages: ["Explorer", "Coder", "Reviewer", "ForgeVerify"],
      };
      break;

    case "complex":
      plan = {
        topology: "complex",
        explorers: 2,
        hasPlanner: true,
        hasReviewer: true,
        hasVision: false,
        requiresForgeVerify: true,
        reason,
        stages: ["Explorer A", "Explorer B", "Planner", "Coder", "Reviewer", "ForgeVerify"],
      };
      break;

    case "vision":
      plan = {
        topology: "vision",
        explorers: 1,
        hasPlanner: false,
        hasReviewer: true,
        hasVision: true,
        requiresForgeVerify: true,
        reason,
        stages: ["Vision Worker", "Explorer", "Coder", "Reviewer", "ForgeVerify"],
      };
      break;

    case "fixed_r1":
    default:
      plan = {
        topology: "fixed_r1",
        explorers: 2,
        hasPlanner: true,
        hasReviewer: true,
        hasVision: false,
        requiresForgeVerify: true,
        reason,
        stages: ["2 Explorers", "Planner", "Coder", "Reviewer", "ForgeVerify"],
      };
      break;
  }

  return AdaptiveTopologyPlanSchema.parse(plan);
}
