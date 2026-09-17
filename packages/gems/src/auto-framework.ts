export type GemsAutoRole = "explorer" | "planner" | "coder" | "reviewer";
export type GemsAutoComplexity = "easy" | "medium" | "hard" | "very_hard";
export type GemsProfileLifecycle = "synthetic" | "frozen_nonproduction" | "unfinished";

export interface GemsCapabilityProfile {
  id: string;
  lifecycle: GemsProfileLifecycle;
  capabilities: Record<GemsAutoRole, number>;
  contextTokens: number;
  latencyMs: number;
  reliability: number;
}

export interface GemsAutoScenario {
  complexity: GemsAutoComplexity;
  requiredContextTokens: number;
}

export type GemsAutoPlan =
  | {
    outcome: "planned";
    mode: "simulation_only";
    roles: GemsAutoRole[];
    assignments: Array<{ role: GemsAutoRole; profileId: string; score: number }>;
    excludedUnfinishedProfileIds: string[];
  }
  | {
    outcome: "blocked";
    mode: "simulation_only";
    reason: "NO_ELIGIBLE_NONPRODUCTION_PROFILE" | "INSUFFICIENT_CAPABILITY_PROFILE";
    excludedUnfinishedProfileIds: string[];
  };

function rolesFor(complexity: GemsAutoComplexity): GemsAutoRole[] {
  if (complexity === "easy") return ["explorer", "coder", "reviewer"];
  if (complexity === "medium") return ["explorer", "planner", "coder", "reviewer"];
  if (complexity === "hard") return ["explorer", "planner", "coder", "reviewer"];
  return ["explorer", "planner", "coder", "coder", "reviewer"];
}

function profileScore(profile: GemsCapabilityProfile, role: GemsAutoRole, requiredContextTokens: number): number {
  if (profile.contextTokens < requiredContextTokens) return Number.NEGATIVE_INFINITY;
  const roleScore = profile.capabilities[role];
  if (!Number.isFinite(roleScore) || roleScore < 0 || roleScore > 1 || profile.reliability < 0 || profile.reliability > 1 || profile.latencyMs <= 0) {
    return Number.NEGATIVE_INFINITY;
  }
  const speed = 1 / profile.latencyMs;
  return roleScore * 100 + profile.reliability * 20 + speed * 1_000;
}

/**
 * Future GEMS Auto decision framework. It intentionally returns a simulation-only plan: this
 * package has no provider adapter and cannot make an unfinished or synthetic GEMS executable.
 */
export function planGemsAutoScenario(
  scenario: GemsAutoScenario,
  profiles: readonly GemsCapabilityProfile[],
): GemsAutoPlan {
  const excludedUnfinishedProfileIds = profiles.filter((profile) => profile.lifecycle === "unfinished").map((profile) => profile.id);
  const eligible = profiles.filter((profile) => profile.lifecycle === "synthetic" || profile.lifecycle === "frozen_nonproduction");
  if (eligible.length === 0) return { outcome: "blocked", mode: "simulation_only", reason: "NO_ELIGIBLE_NONPRODUCTION_PROFILE", excludedUnfinishedProfileIds };

  const assignments = rolesFor(scenario.complexity).map((role) => {
    const ranked = eligible
      .map((profile) => ({ profile, score: profileScore(profile, role, scenario.requiredContextTokens) }))
      .filter((candidate) => Number.isFinite(candidate.score))
      .sort((left, right) => right.score - left.score || left.profile.id.localeCompare(right.profile.id));
    const best = ranked[0];
    return best ? { role, profileId: best.profile.id, score: best.score } : undefined;
  });
  if (assignments.some((assignment) => assignment === undefined)) {
    return { outcome: "blocked", mode: "simulation_only", reason: "INSUFFICIENT_CAPABILITY_PROFILE", excludedUnfinishedProfileIds };
  }
  return {
    outcome: "planned",
    mode: "simulation_only",
    roles: rolesFor(scenario.complexity),
    assignments: assignments as Array<{ role: GemsAutoRole; profileId: string; score: number }>,
    excludedUnfinishedProfileIds,
  };
}
