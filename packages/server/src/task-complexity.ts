/**
 * R21 deterministic task-complexity classification for topology selection.
 *
 * ForgeAuto must choose the smallest useful agent topology: one coder for a one-line change,
 * an explorer + coder + reviewer for an ordinary bug or feature, and the full planner-led team
 * only for genuinely cross-cutting work. This classifier is pure and inspectable — no model is
 * consulted — so the topology decision is reproducible, testable, and never something a model
 * can talk its way into. It produces a tier plus the reason codes that fired, which the
 * orchestrator persists as a topology receipt.
 *
 * It deliberately errs toward the *smaller* team only when the goal is unambiguously tiny; any
 * signal of breadth escalates. A wrong "tiny" guess costs a review that ForgeVerify still
 * backstops; a wrong "complex" guess costs four agents' worth of quota on a typo.
 */

export type TaskComplexityTier = "tiny" | "normal" | "complex";

export type TaskComplexityReasonCode =
  | "GOAL_MATCHES_TINY_PATTERN"
  | "GOAL_MATCHES_CROSS_CUTTING_PATTERN"
  | "GOAL_NAMES_MULTIPLE_TARGETS"
  | "GOAL_NAMES_SINGLE_FILE"
  | "GOAL_IS_LONG"
  | "GOAL_IS_SHORT"
  | "GOAL_ASKS_FOR_TESTS_OR_INVESTIGATION"
  | "GOAL_MENTIONS_MANY_PACKAGES"
  | "GOAL_SPANS_LAYERS"
  | "REPOSITORY_IS_LARGE"
  | "EXPLICIT_HINT"
  | "DEFAULT_NORMAL";

export interface TaskComplexitySignals {
  goal: string;
  /** Number of tracked files in the repository when known (cheap to obtain; optional). */
  repositoryFileCount?: number;
  /** Paths the user or a prior phase already named as targets. */
  targetPaths?: readonly string[];
  /** An explicit hint from the caller always wins over heuristics. */
  hint?: TaskComplexityTier;
}

export interface TaskComplexityDecision {
  tier: TaskComplexityTier;
  reasonCodes: TaskComplexityReasonCode[];
  /** Human-readable, evidence-bearing explanation for receipts and UI. */
  rationale: string;
  classifierVersion: typeof TASK_COMPLEXITY_CLASSIFIER_VERSION;
}

export const TASK_COMPLEXITY_CLASSIFIER_VERSION = "r21-task-complexity-v1";

const TINY_PATTERNS: readonly RegExp[] = [
  /\b(fix|correct)\s+(a\s+|the\s+)?typo\b/i,
  /\btypo\b/i,
  /\b(fix|update|improve|reword|correct)\s+(a\s+|the\s+)?(comment|docstring|doc comment|jsdoc|readme wording|error message text|log message)\b/i,
  /\bbump\s+(the\s+)?version\b/i,
  /\b(single|one)[- ]line\s+(fix|change|edit)\b/i,
  /\brename\s+(a\s+|the\s+)?(variable|constant|parameter|local)\b/i,
  /\b(add|remove)\s+(a\s+|the\s+)?(missing\s+)?(semicolon|trailing comma|newline|whitespace|blank line)\b/i,
  /\bfix\s+(the\s+)?(lint|formatting|indentation)\s+(error|warning|issue)s?\b/i,
  /\bchange\s+(the\s+)?(default\s+)?(value|string|label|text|constant)\s+(of|for)\b.*\bto\b/i,
  // Detailed acceptance criteria for a single return-value bug are still tiny when they do not
  // name investigation, breadth, or a second target. This keeps the smallest-useful topology
  // from being defeated by a precise one-file bug report.
  /\b(fix|correct|repair)\b[\s\S]{0,220}\breturns?\b/i,
];

const CROSS_CUTTING_PATTERNS: readonly RegExp[] = [
  /\brefactor\s+(the\s+)?architecture\b/i,
  /\bmigrat(e|ion)\b.*\b(database|schema|framework|library|runtime|api)\b/i,
  /\bmulti[- ]package\b/i,
  /\bsystem\s+redesign\b/i,
  /\bacross\s+(all|every|multiple|several|the)\s+(packages|services|modules|apps|repos|workspaces)\b/i,
  /\bend[- ]to[- ]end\b/i,
  /\bnew\s+(micro)?service\b/i,
  /\b(database|db)\s+schema\b.*\b(and|plus|with)\b.*\b(api|frontend|ui|client)\b/i,
  /\b(frontend|ui|client)\b.*\b(and|plus|with)\b.*\b(backend|server|api)\b/i,
  /\bbreaking\s+change\b/i,
  /\bmonorepo[- ]wide\b/i,
  /\breplace\s+(the\s+)?\w+\s+with\s+\w+\s+(everywhere|throughout|across)\b/i,
  /\bupgrade\s+(all|every)\b/i,
];

/** Architectural layers; a goal that names two or more is cross-cutting by definition. */
const LAYER_PATTERNS: readonly RegExp[] = [
  /\b(database|db|schema|migrations?|table|column)\b/i,
  /\b(api|backend|server|endpoints?|gateway|service layer)\b/i,
  /\b(frontend|ui|client|web app|pages?|components?|screen)\b/i,
];

const INVESTIGATION_PATTERNS: readonly RegExp[] = [
  /\b(investigate|diagnose|root[- ]cause|why does|why is|flaky|intermittent|regression)\b/i,
  /\b(add|write)\s+(unit\s+|integration\s+)?tests?\b/i,
];

const FILE_REFERENCE = /(?:^|[\s"'`(])((?:[\w.-]+\/)*[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|cs|json|yaml|yml|toml|md|sql|css|scss|html))(?=$|[\s"'`),.:;])/g;

function countFileReferences(goal: string): number {
  const seen = new Set<string>();
  for (const match of goal.matchAll(FILE_REFERENCE)) seen.add(match[1]!.toLowerCase());
  return seen.size;
}

function countPackageMentions(goal: string): number {
  const matches = goal.match(/\b(?:packages?|apps?|services?|modules?)\s*\/\s*[\w-]+|@[\w-]+\/[\w-]+/g) ?? [];
  return new Set(matches.map((entry) => entry.toLowerCase())).size;
}

/** Word count after collapsing whitespace — a coarse but deterministic breadth proxy. */
function wordCount(goal: string): number {
  return goal.trim().split(/\s+/).filter(Boolean).length;
}

export function classifyTaskComplexity(signals: TaskComplexitySignals): TaskComplexityDecision {
  const goal = signals.goal.trim();
  const reasonCodes: TaskComplexityReasonCode[] = [];

  if (signals.hint) {
    return { tier: signals.hint, reasonCodes: ["EXPLICIT_HINT"], rationale: `Explicit complexity hint: ${signals.hint}.`, classifierVersion: TASK_COMPLEXITY_CLASSIFIER_VERSION };
  }

  const words = wordCount(goal);
  const files = countFileReferences(goal) + (signals.targetPaths?.length ?? 0);
  const packages = countPackageMentions(goal);
  const crossCutting = CROSS_CUTTING_PATTERNS.some((pattern) => pattern.test(goal));
  const tiny = TINY_PATTERNS.some((pattern) => pattern.test(goal));
  const investigation = INVESTIGATION_PATTERNS.some((pattern) => pattern.test(goal));
  const largeRepository = (signals.repositoryFileCount ?? 0) >= 5_000;
  const layers = LAYER_PATTERNS.filter((pattern) => pattern.test(goal)).length;

  if (crossCutting) reasonCodes.push("GOAL_MATCHES_CROSS_CUTTING_PATTERN");
  if (layers >= 2) reasonCodes.push("GOAL_SPANS_LAYERS");
  if (packages >= 2) reasonCodes.push("GOAL_MENTIONS_MANY_PACKAGES");
  if (files >= 3) reasonCodes.push("GOAL_NAMES_MULTIPLE_TARGETS");
  if (words >= 60) reasonCodes.push("GOAL_IS_LONG");
  if (largeRepository) reasonCodes.push("REPOSITORY_IS_LARGE");

  // Escalation wins over reduction: any breadth signal rules out "tiny", and two or more breadth
  // signals (or a cross-cutting phrase, or an explicit many-packages mention) mean "complex".
  const breadthSignals = reasonCodes.length;
  if (crossCutting || layers >= 2 || packages >= 2 || breadthSignals >= 2) {
    return { tier: "complex", reasonCodes, rationale: `Cross-cutting work: ${reasonCodes.join(", ")}.`, classifierVersion: TASK_COMPLEXITY_CLASSIFIER_VERSION };
  }

  if (tiny && breadthSignals === 0 && !investigation && words <= 48 && files <= 1) {
    reasonCodes.push("GOAL_MATCHES_TINY_PATTERN", "GOAL_IS_SHORT");
    if (files === 1) reasonCodes.push("GOAL_NAMES_SINGLE_FILE");
    return { tier: "tiny", reasonCodes, rationale: "A single, narrowly scoped edit with no breadth signal; a coder plus ForgeVerify is the smallest useful team.", classifierVersion: TASK_COMPLEXITY_CLASSIFIER_VERSION };
  }

  if (investigation) reasonCodes.push("GOAL_ASKS_FOR_TESTS_OR_INVESTIGATION");
  if (files === 1) reasonCodes.push("GOAL_NAMES_SINGLE_FILE");
  reasonCodes.push("DEFAULT_NORMAL");
  return { tier: "normal", reasonCodes, rationale: "Ordinary bug or feature: one explorer, one coder, one independent reviewer, then ForgeVerify.", classifierVersion: TASK_COMPLEXITY_CLASSIFIER_VERSION };
}
