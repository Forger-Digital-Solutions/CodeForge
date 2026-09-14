import type { FreeModelRecord } from "@codeforge/forge-zero";
import type { ForgeAutoSeat } from "./classification.js";

/**
 * Role-specific scoring (R1 spec §21). Never one generic "model quality" number: each seat
 * weights the observable capability/benchmark/empirical facts a model record carries, so the
 * best PLANNER and the best SWE specialist can be different models even inside a small roster.
 */

/** Normalized 0–100 observable dimensions, derived strictly from record facts. Absent facts
 * contribute their neutral default instead of pretending knowledge. */
export interface RoleDimensions {
  swe: number;
  planning: number;
  reasoning: number;
  architecture: number;
  debug: number;
  review: number;
  verify: number;
  research: number;
  tool: number;
  structuredOutput: number;
  longContext: number;
  reliability: number;
  latency: number;
  availability: number;
}

export type RoleDimension = keyof RoleDimensions;

const SEAT_WEIGHTS: Readonly<Record<ForgeAutoSeat, Partial<Record<RoleDimension, number>>>> = {
  SWE: { swe: 0.38, tool: 0.24, debug: 0.12, longContext: 0.1, latency: 0.08, availability: 0.08 },
  PLANNER: { planning: 0.34, reasoning: 0.3, longContext: 0.18, architecture: 0.1, availability: 0.08 },
  REVIEWER: { review: 0.3, debug: 0.26, reasoning: 0.22, longContext: 0.12, availability: 0.1 },
  VERIFIER: { verify: 0.3, tool: 0.26, debug: 0.18, latency: 0.14, availability: 0.12 },
};

function bench(bp: FreeModelRecord["benchmarkProfile"], key: keyof NonNullable<FreeModelRecord["benchmarkProfile"]>): number {
  return bp?.[key] ?? 50;
}

function scale(value: number, min: number, max: number): number {
  if (value <= min) return 0;
  if (value >= max) return 100;
  return ((value - min) / (max - min)) * 100;
}

export function roleDimensions(model: FreeModelRecord): RoleDimensions {
  const codingCapability = model.capabilities.coding ? 80 : 25;
  const empiricalCoding = model.codingScore;
  const coding = empiricalCoding !== undefined ? empiricalCoding * 0.7 + codingCapability * 0.3 : codingCapability * 0.5 + bench(model.benchmarkProfile, "coding") * 0.5;

  const reasoning = bench(model.benchmarkProfile, "reasoning");
  const speed = bench(model.benchmarkProfile, "speed");
  const context = scale(model.contextWindow ?? 32_000, 8_000, 400_000);
  const toolEmpirical = model.toolReliability !== undefined ? model.toolReliability * 100 : undefined;
  const tool = toolEmpirical ?? bench(model.benchmarkProfile, "toolCalling");

  const failures = model.health?.recentFailureCount ?? 0;
  const healthStatus = model.health?.status ?? "unknown";
  const reliability = Math.max(0, 100 - failures * 12) - (healthStatus === "degraded" ? 15 : 0);
  const availability =
    healthStatus === "offline" || healthStatus === "auth_required" ? 0 : healthStatus === "rate_limited" || healthStatus === "quota_exhausted" ? 20 : healthStatus === "degraded" ? 60 : 90;

  return {
    swe: coding,
    planning: reasoning * 0.6 + context * 0.4,
    reasoning,
    architecture: reasoning * 0.55 + coding * 0.45,
    debug: coding * 0.6 + reasoning * 0.4,
    review: reasoning * 0.5 + coding * 0.5,
    verify: tool * 0.6 + coding * 0.4,
    research: reasoning * 0.5 + context * 0.5,
    tool,
    structuredOutput: model.capabilities.structuredOutput ? 100 : 0,
    longContext: model.capabilities.longContext ? Math.max(70, context) : context * 0.5,
    reliability,
    latency: speed,
    availability,
  };
}

export interface RoleScore {
  seat: ForgeAutoSeat;
  score: number;
  /** Per-dimension contributions — diagnostic, machine-readable, no chain-of-thought. */
  contributions: Array<{ dimension: RoleDimension; weight: number; value: number }>;
}

export function scoreForSeat(model: FreeModelRecord, seat: ForgeAutoSeat): RoleScore {
  const dims = roleDimensions(model);
  const weights = SEAT_WEIGHTS[seat];
  const contributions: RoleScore["contributions"] = [];
  let score = 0;
  for (const [dimension, weight] of Object.entries(weights) as Array<[RoleDimension, number]>) {
    const value = dims[dimension];
    score += value * weight;
    contributions.push({ dimension, weight, value: Math.round(value * 10) / 10 });
  }
  return { seat, score: Math.round(score * 10) / 10, contributions };
}
