import {
  type AdaptiveTopology,
  type AdaptiveTopologyPlan,
  AdaptiveTopologyPlanSchema,
} from "@codeforge/protocol";

export interface ResolveAdaptiveTopologyInput {
  goal: string;
  hasImages?: boolean;
  complexityHint?: "tiny" | "normal" | "complex";
  requestedTopology?: AdaptiveTopology;
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
 *    - complex: Explorer A + Explorer B -> Planner -> Writer -> Reviewer -> ForgeVerify
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
    return buildTopologyPlan("vision", "Visual/image assets present; routes through Vision worker + Explorer");
  }

  // Explicit complexity hint
  if (input.complexityHint === "tiny") {
    return buildTopologyPlan("tiny", "Tiny task: single targeted Coder mutation directly to ForgeVerify");
  }
  if (input.complexityHint === "normal") {
    return buildTopologyPlan("normal", "Normal task: Explorer -> Coder -> Reviewer -> ForgeVerify");
  }
  if (input.complexityHint === "complex") {
    return buildTopologyPlan("complex", "Complex task: 2 Explorers -> Planner -> Coder -> Reviewer -> ForgeVerify");
  }

  // Heuristic / deterministic goal analysis if no explicit hint:
  const lowerGoal = input.goal.toLowerCase();
  if (/\b(typo|fix comment|bump version|single line fix|docstring)\b/.test(lowerGoal)) {
    return buildTopologyPlan("tiny", "Deterministic goal match: targeted typo/one-line mutation");
  }
  if (/\b(refactor architecture|migrate database|multi-package|system redesign)\b/.test(lowerGoal)) {
    return buildTopologyPlan("complex", "Deterministic goal match: cross-cutting architectural change");
  }

  // Certified baseline: R1 fixed topology
  return buildTopologyPlan("fixed_r1", "Default certified baseline: 2 Explorers -> Planner -> Coder -> Reviewer -> ForgeVerify");
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
