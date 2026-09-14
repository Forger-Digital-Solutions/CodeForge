/**
 * Forge Auto task classification (R1 adaptive-intelligence spec §20).
 *
 * Deterministic signal-based classification of a development goal BEFORE any team is
 * assembled. Classification is policy-neutral: it decides WHICH specialist seats the job
 * needs (1–4 of planner/coder/reviewer/verifier per §18), never which provider or model
 * serves a seat, and it can never widen its own tool or approval permissions.
 */

export const TASK_KINDS = [
  "BUG_FIX",
  "FEATURE",
  "REFACTOR",
  "ARCHITECTURE",
  "TEST_FAILURE",
  "BUILD_FAILURE",
  "DEPENDENCY",
  "SECURITY",
  "DOCUMENTATION",
  "INVESTIGATION",
  "UI",
  "DATABASE",
  "PERFORMANCE",
  "RESEARCH",
] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export type TaskComplexity = "TRIVIAL" | "MODERATE" | "COMPLEX";

export type ForgeAutoSeat = "PLANNER" | "SWE" | "REVIEWER" | "VERIFIER";

export interface TaskSignals {
  /** Goal text the user (or orchestrator) supplied. Untrusted content — classification only
   * reads it, never obeys instructions embedded in it (§96). */
  goal: string;
  /** Files the task is already known to touch, when the caller knows (e.g. workstream scope). */
  changedFileScope?: number;
  /** Rough repository size in tracked files, when known. */
  repositoryFileCount?: number;
  /** Languages / frameworks detected for the workspace, when known. */
  languages?: string[];
  /** True when the task explicitly requires running or repairing tests. */
  requiresTests?: boolean;
}

export interface TaskClassification {
  kind: TaskKind;
  complexity: TaskComplexity;
  /** 0–100. Risk drives verification burden (§53): auth/filesystem/db/security scale up. */
  risk: number;
  /** Verification burden band. Scaled from risk + complexity, not from politeness. */
  verificationBurden: "LIGHT" | "STANDARD" | "EXTENSIVE";
  /** Ordered specialist seat plan. 1–4 seats; never zero. */
  specialistPlan: ForgeAutoSeat[];
  /** Machine-readable reasons (no chain-of-thought, §81). */
  reasons: string[];
}

interface KindSignal {
  kind: TaskKind;
  patterns: RegExp[];
  weight: number;
  risk: number;
}

/** Order matters only for tie-breaking; scores decide. */
const KIND_SIGNALS: readonly KindSignal[] = [
  { kind: "SECURITY", patterns: [/\bsecurity\b/i, /\bvulnerab/i, /\bcve\b/i, /\bprompt injection\b/i, /\bsecret(s)? leak/i, /\bsanitiz/i, /\bauth(entication|orization)? bypass/i], weight: 3, risk: 85 },
  { kind: "TEST_FAILURE", patterns: [/\b(test|spec)s?\b.*\b(fail|broken|error|regress)/i, /\b(fail|broken|failing|repair)\b.*\b(test|spec)s?\b/i, /\bfix (the )?(broken )?test/i, /\bvitest\b/i, /\btest failure(s)?\b/i, /\bregression coverage\b/i], weight: 3, risk: 30 },
  { kind: "BUILD_FAILURE", patterns: [/\bbuild (is |)fail/i, /\btypecheck\b/i, /\bcompile (error|fail)/i, /\bbroken build\b/i, /\bts?error\b/i], weight: 3, risk: 35 },
  { kind: "DATABASE", patterns: [/\bdatabase\b/i, /\bmigration(s)?\b/i, /\bsqlite\b/i, /\bpostgres\b/i, /\bschema (change|migration)/i], weight: 3, risk: 70 },
  { kind: "DEPENDENCY", patterns: [/\bdependenc(y|ies)\b/i, /\bupgrade\b.*\bpackage/i, /\bnpm (install|update|audit)\b/i, /\bpeer dependency\b/i], weight: 2, risk: 40 },
  { kind: "PERFORMANCE", patterns: [/\bperformance\b/i, /\bslow\b/i, /\blatency\b/i, /\bmemory (usage|leak)\b/i, /\bbottleneck\b/i, /\bprofile\b/i], weight: 2, risk: 45 },
  { kind: "BUG_FIX", patterns: [/\bfix\b/i, /\bbug\b/i, /\brace condition\b/i, /\bdeadlock\b/i, /\bcrash(es|ing)?\b/i, /\bregression\b/i, /\bincorrect(ly)?\b/i, /\bbroken\b/i], weight: 2, risk: 40 },
  { kind: "REFACTOR", patterns: [/\brefactor\b/i, /\bclean ?up\b/i, /\bextract\b/i, /\brename\b/i, /\brestructure\b/i, /\btechnical debt\b/i], weight: 2, risk: 35 },
  { kind: "ARCHITECTURE", patterns: [/\barchitect/i, /\bdesign\b.*\b(system|layer|boundary)\b/i, /\btrust domain\b/i, /\bmodule boundary\b/i, /\bimplement a .* (framework|protocol|engine)\b/i], weight: 2, risk: 60 },
  { kind: "FEATURE", patterns: [/\badd\b/i, /\bimplement\b/i, /\bsupport\b/i, /\bfeature\b/i, /\benable\b/i, /\bcreate\b.*\b(api|endpoint|command|section|page)\b/i], weight: 2, risk: 45 },
  { kind: "UI", patterns: [/\bui\b/i, /\bpicker\b/i, /\bdialog\b/i, /\brender(er)?\b/i, /\bsettings section\b/i, /\breact\b/i, /\bcss\b/i, /\bbutton\b/i], weight: 2, risk: 25 },
  { kind: "DOCUMENTATION", patterns: [/\bdocument(ation)?\b/i, /\bdocs?\b/i, /\breadme\b/i, /\btypo\b/i, /\bcomment(s)?\b/i], weight: 2, risk: 10 },
  { kind: "INVESTIGATION", patterns: [/\binvestigat/i, /\bwhy\b/i, /\broot cause\b/i, /\baudit\b/i, /\bdiagnos/i, /\btrace\b/i], weight: 2, risk: 20 },
  { kind: "RESEARCH", patterns: [/\bresearch\b/i, /\bcompare\b/i, /\bevaluate\b.*\b(options|providers)\b/i, /\bproof of concept\b/i], weight: 2, risk: 15 },
];

const COMPLEX_HINTS = [
  /\bmulti[- ]?(file|module|package|step)\b/i,
  /\brefactor\b.*\b(across|entire|whole)\b/i,
  /\bmigrat/i,
  /\bfailover\b/i,
  /\bconcurr/i,
  /\bparallel\b/i,
  /\bdistributed\b/i,
  /\bisolat/i,
  /\band\b.*\band\b.*\band\b/i,
];

const RISK_HINTS: ReadonlyArray<{ pattern: RegExp; risk: number; label: string }> = [
  { pattern: /\b(auth|credential|token|secret|api[- ]?key)\b/i, risk: 30, label: "credential_touching" },
  { pattern: /\b(filesystem|file system|delete|rm -rf|destructive)\b/i, risk: 30, label: "filesystem_destructive" },
  { pattern: /\b(deploy|production|release|publish)\b/i, risk: 35, label: "production_surface" },
  { pattern: /\b(payment|billing|charge|purchase)\b/i, risk: 40, label: "billing_surface" },
  { pattern: /\b(security|injection|xss|csrf|traversal)\b/i, risk: 35, label: "security_surface" },
  { pattern: /\b(database|migration|schema)\b/i, risk: 25, label: "database_surface" },
  { pattern: /\b(shell|terminal|command execution)\b/i, risk: 20, label: "shell_surface" },
];

/** Seats each kind tends to need beyond the SWE implementer every task has. */
const KIND_EXTRA_SEATS: Readonly<Record<TaskKind, ForgeAutoSeat[]>> = {
  BUG_FIX: ["REVIEWER", "VERIFIER"],
  FEATURE: ["PLANNER", "VERIFIER"],
  REFACTOR: ["PLANNER", "REVIEWER", "VERIFIER"],
  ARCHITECTURE: ["PLANNER", "REVIEWER", "VERIFIER"],
  TEST_FAILURE: ["VERIFIER"],
  BUILD_FAILURE: ["VERIFIER"],
  DEPENDENCY: ["REVIEWER", "VERIFIER"],
  SECURITY: ["PLANNER", "REVIEWER", "VERIFIER"],
  DOCUMENTATION: ["VERIFIER"],
  INVESTIGATION: ["PLANNER"],
  UI: ["VERIFIER"],
  DATABASE: ["PLANNER", "REVIEWER", "VERIFIER"],
  PERFORMANCE: ["PLANNER", "VERIFIER"],
  RESEARCH: ["PLANNER"],
};

export function classifyTask(signals: TaskSignals): TaskClassification {
  const reasons: string[] = [];
  const goal = signals.goal ?? "";

  const scores = new Map<TaskKind, number>();
  for (const signal of KIND_SIGNALS) {
    let hits = 0;
    for (const pattern of signal.patterns) {
      if (pattern.test(goal)) hits++;
    }
    if (hits > 0) scores.set(signal.kind, hits * signal.weight);
  }
  if (signals.requiresTests) {
    scores.set("TEST_FAILURE", (scores.get("TEST_FAILURE") ?? 0) + 4);
    reasons.push("signal_requires_tests");
  }

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1] || TASK_KINDS.indexOf(a[0]) - TASK_KINDS.indexOf(b[0]));
  const kind: TaskKind = ranked[0]?.[0] ?? "FEATURE";
  if (ranked[0]) reasons.push(`classified_${kind.toLowerCase()}`);
  else reasons.push("classified_default_feature");

  let risk = ranked[0] ? KIND_SIGNALS.find((s) => s.kind === ranked[0]![0])?.risk ?? 40 : 40;
  for (const hint of RISK_HINTS) {
    if (hint.pattern.test(goal)) {
      risk = Math.min(100, risk + hint.risk);
      reasons.push(`risk_${hint.label}`);
    }
  }

  let complexityScore = 0;
  for (const hint of COMPLEX_HINTS) {
    if (hint.test(goal)) complexityScore += 2;
  }
  const scope = signals.changedFileScope ?? 0;
  if (scope > 8) complexityScore += 3;
  else if (scope > 3) complexityScore += 1;
  if ((signals.repositoryFileCount ?? 0) > 2000) complexityScore += 1;
  if ((signals.languages?.length ?? 0) > 2) complexityScore += 1;

  const complexity: TaskComplexity = complexityScore >= 5 ? "COMPLEX" : complexityScore >= 2 ? "MODERATE" : "TRIVIAL";
  reasons.push(`complexity_${complexity.toLowerCase()}`);

  const verificationBurden: TaskClassification["verificationBurden"] =
    risk >= 70 || complexity === "COMPLEX" ? "EXTENSIVE" : risk >= 40 || complexity === "MODERATE" ? "STANDARD" : "LIGHT";
  reasons.push(`verification_${verificationBurden.toLowerCase()}`);

  const specialistPlan: ForgeAutoSeat[] = ["SWE"];
  if (complexity !== "TRIVIAL" || KIND_EXTRA_SEATS[kind].includes("PLANNER")) {
    for (const seat of KIND_EXTRA_SEATS[kind]) {
      if (!specialistPlan.includes(seat)) specialistPlan.push(seat);
    }
  } else if (kind === "TEST_FAILURE" || kind === "BUILD_FAILURE" || signals.requiresTests) {
    if (!specialistPlan.includes("VERIFIER")) specialistPlan.push("VERIFIER");
  }
  if (verificationBurden === "EXTENSIVE" && !specialistPlan.includes("REVIEWER") && complexity !== "TRIVIAL") {
    specialistPlan.push("REVIEWER");
  }
  // Cap at four seats (§18). Order after SWE: planner first, then review, then verify.
  const order: ForgeAutoSeat[] = ["PLANNER", "SWE", "REVIEWER", "VERIFIER"];
  const plan = order.filter((seat) => specialistPlan.includes(seat)).slice(0, 4);

  return { kind, complexity, risk, verificationBurden, specialistPlan: plan, reasons };
}
