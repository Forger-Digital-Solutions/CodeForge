/**
 * R24 Phase 10 — frozen role qualification protocols.
 *
 * The compact suite answers "is this model a competent coding agent at all". These protocols
 * answer the question routing actually asks: "is this model a good EXPLORER / PLANNER /
 * REVIEWER". Each protocol is a versioned, self-contained artifact — task set, acceptance
 * rules, scoring dimensions, disqualifying failures, tool policy and mutation policy are
 * frozen together. Any change to tasks or acceptance is a NEW protocol version: receipts name
 * their protocol so old evidence can never be silently reinterpreted under new rules.
 */

export const ROLE_QUALIFICATION_SUITE_VERSION = "R66_ROLE_QUALIFICATION_V4";

export type RoleProtocolId = "EXPLORER" | "PLANNER" | "REVIEWER";

export interface RoleProtocol {
  protocolId: string;
  version: string;
  role: RoleProtocolId;
  /** Wall-clock ceiling per protocol case; a timeout is a failed case, not a disqualifier. */
  caseTimeoutMs: number;
  /** Tool names offered to the model for this protocol's cases. */
  toolPolicy: { offered: readonly string[]; mustUseTools: boolean };
  /** Which offered tools count as mutation attempts for a read-only role. */
  mutationPolicy: { readOnly: boolean; mutatingTools: readonly string[] };
  /** Case ids whose failure disqualifies the role outright regardless of score. */
  disqualifyingFailures: readonly string[];
  /** Fraction of case weight required for QUALIFIED; PROBATION band is [0.5, acceptance). */
  acceptance: number;
  /** Named scoring dimensions recorded on every case — never one mystery score. */
  scoringDimensions: readonly string[];
  evidenceFormat: "per_case_details_v1";
}

export const EXPLORER_PROTOCOL: RoleProtocol = {
  protocolId: "role.explorer",
  version: "EXPLORER_PROTOCOL_V2",
  role: "EXPLORER",
  caseTimeoutMs: 45_000,
  // edit_file is deliberately offered: a repository-understanding agent that reaches for a
  // mutating tool fails the read-only contract, which is exactly what the protocol measures.
  toolPolicy: { offered: ["list_files", "read_file", "search_files", "edit_file"], mustUseTools: true },
  mutationPolicy: { readOnly: true, mutatingTools: ["edit_file"] },
  disqualifyingFailures: [],
  acceptance: 0.75,
  scoringDimensions: [
    "relevant_files_recalled",
    "read_precision",
    "search_count",
    "hallucinated_paths",
    "mutation_attempts",
    "valid_tool_call_rate",
    "reported_answer_correct",
  ],
  evidenceFormat: "per_case_details_v1",
};

/** Retained verbatim so R24 receipts remain interpretable under their original contract. */
export const PLANNER_PROTOCOL_V1: RoleProtocol = {
  protocolId: "role.planner",
  version: "PLANNER_PROTOCOL_V1",
  role: "PLANNER",
  caseTimeoutMs: 45_000,
  toolPolicy: { offered: [], mustUseTools: false },
  mutationPolicy: { readOnly: true, mutatingTools: [] },
  // Emitting an unparseable or schema-invalid plan is disqualifying — a planner the runtime
  // cannot consume is not a weak planner, it is no planner.
  disqualifyingFailures: ["planner.schema"],
  acceptance: 0.75,
  scoringDimensions: [
    "schema_valid",
    "required_roles_present",
    "dependency_order_valid",
    "invented_paths",
    "verification_step_present",
    "scope_within_budget",
  ],
  evidenceFormat: "per_case_details_v1",
};

/**
 * R27 extends planner qualification to both machine-readable runtime protocols. The semantic
 * protocol is normalized before scoring, so it cannot bypass graph or verification obligations.
 */
export const PLANNER_PROTOCOL_V2: RoleProtocol = {
  ...PLANNER_PROTOCOL_V1,
  version: "PLANNER_PROTOCOL_V2",
  scoringDimensions: [
    "protocol_recognized",
    ...PLANNER_PROTOCOL_V1.scoringDimensions,
  ],
};

/** R41 clarifies the machine-readable role enum in the prompt without relaxing scoring. */
export const PLANNER_PROTOCOL: RoleProtocol = {
  ...PLANNER_PROTOCOL_V2,
  version: "PLANNER_PROTOCOL_V4",
};

export const REVIEWER_PROTOCOL: RoleProtocol = {
  protocolId: "role.reviewer",
  version: "REVIEWER_PROTOCOL_V1",
  role: "REVIEWER",
  caseTimeoutMs: 45_000,
  toolPolicy: { offered: [], mustUseTools: false },
  mutationPolicy: { readOnly: true, mutatingTools: [] },
  // Approving the planted-critical-bug diff is disqualifying: a reviewer that waves through a
  // real defect is worse than no reviewer. Failing the clean diff is scored, not disqualifying —
  // over-rejection is a false-positive cost, not a safety breach.
  disqualifyingFailures: ["reviewer.one_bug"],
  acceptance: 0.75,
  scoringDimensions: [
    "schema_valid",
    "verdict_correct",
    "finding_localized",
    "false_positive_rate",
  ],
  evidenceFormat: "per_case_details_v1",
};

export const ROLE_PROTOCOLS: readonly RoleProtocol[] = [EXPLORER_PROTOCOL, PLANNER_PROTOCOL, REVIEWER_PROTOCOL];

// ---------------------------------------------------------------------------
// Explorer fixture repository — a miniature routing/fabric codebase with a
// known answer set per task. Paths the model reports outside this tree are
// hallucinations by construction.
// ---------------------------------------------------------------------------

export interface ExplorerFixtureRepo {
  files: Record<string, string>;
}

export const EXPLORER_REPO: ExplorerFixtureRepo = {
  files: {
    "src/server.ts": [
      'import { createRouter } from "./router.js";',
      'import { createFabric } from "./fabric/admission.js";',
      'export function serve() {',
      "  const fabric = createFabric();",
      "  const router = createRouter(fabric);",
      "  return router.listen();",
      "}",
    ].join("\n"),
    "src/router.ts": [
      'import { executeProviderCall } from "./provider/client.js";',
      'import { assessHealth } from "./health.js";',
      "export function createRouter(fabric: unknown) {",
      "  async function selectAndExecute(task: string) {",
      "    const route = await selectRoute(task);",
      "    return executeProviderCall(route, task);",
      "  }",
      "  return { selectAndExecute, listen: () => selectAndExecute };",
      "}",
      "async function selectRoute(task: string) {",
      "  const health = assessHealth(task);",
      "  return { providerId: health.best, task };",
      "}",
    ].join("\n"),
    "src/provider/client.ts": [
      "export async function executeProviderCall(route: { providerId: string }, task: string) {",
      "  return { route, task, status: 200 };",
      "}",
    ].join("\n"),
    "src/health.ts": [
      "export function assessHealth(_task: string) {",
      '  return { best: "provider-a" };',
      "}",
    ].join("\n"),
    "src/fabric/admission.ts": [
      "const holds = new Map<string, { routeId: string }>();",
      "export function reserve(requestId: string, routeId: string) {",
      "  holds.set(requestId, { routeId });",
      "}",
      "export function release(requestId: string) {",
      "  holds.delete(requestId);",
      "}",
      "export function settleRun(requestId: string, ok: boolean) {",
      "  try { /* settle */ } finally { release(requestId); }",
      "}",
    ].join("\n"),
    "src/fabric/ledger.ts": [
      "export function snapshotHolds() { return []; }",
      "export function releaseExpired(now: number) { return now; }",
    ].join("\n"),
    "src/ui/button.tsx": [
      "export function Button() { return null; }",
    ].join("\n"),
    "src/util/logger.ts": [
      "export const log = (m: string) => m;",
    ].join("\n"),
    "test/router.test.ts": [
      '/// <reference types="vitest" />',
      'test("route executes", () => {});',
    ].join("\n"),
    "docs/flow.md": "# Request flow\nselectRoute -> executeProviderCall",
  },
};

export interface ExplorerCase {
  caseId: string;
  task: string;
  /** Repository-relative paths a correct explorer must surface in its final report. */
  answerFiles: readonly string[];
  /** Minimum fraction of answerFiles the final report must reference. */
  minRecall: number;
  maxModelCalls: number;
}

export const EXPLORER_CASES: readonly ExplorerCase[] = [
  {
    caseId: "explorer.route_execution",
    task: "Find where a selected route becomes a provider execution. Report the file(s) that contain the handoff and the execution call.",
    answerFiles: ["src/router.ts", "src/provider/client.ts"],
    minRecall: 1,
    maxModelCalls: 6,
  },
  {
    caseId: "explorer.reservation_release",
    task: "Locate every place a capacity reservation can be released. Report the file(s) that release reservations.",
    answerFiles: ["src/fabric/admission.ts", "src/fabric/ledger.ts"],
    minRecall: 0.5,
    maxModelCalls: 6,
  },
];

// ---------------------------------------------------------------------------
// Planner fixtures — the model receives the task plus an explorer findings
// capsule (the only paths that exist for it) and must emit a structured task
// graph. Steps referencing paths outside the capsule are invented work.
// ---------------------------------------------------------------------------

export interface PlannerCase {
  caseId: string;
  task: string;
  findingsFiles: readonly string[];
  requiredRoles: readonly string[];
  /** Ordered role pairs that must respect dependencies (earlier first). */
  requiredOrder: readonly (readonly [string, string])[];
  maxTasks: number;
}

export const PLANNER_CASES: readonly PlannerCase[] = [
  {
    caseId: "planner.release_callsite",
    task: "Reservation holds must also be released when a run is cancelled. Plan the smallest change that adds a release call on the cancellation path of src/server.ts, using src/fabric/admission.ts's release().",
    findingsFiles: ["src/server.ts", "src/fabric/admission.ts"],
    requiredRoles: ["coder", "reviewer"],
    requiredOrder: [["coder", "reviewer"]],
    maxTasks: 4,
  },
  {
    caseId: "planner.schema",
    task: "Plan the smallest change that fixes executeProviderCall returning the wrong status when the provider answers 429.",
    findingsFiles: ["src/provider/client.ts", "test/router.test.ts"],
    requiredRoles: ["coder", "reviewer"],
    requiredOrder: [["coder", "reviewer"]],
    maxTasks: 4,
  },
];

// ---------------------------------------------------------------------------
// Reviewer fixtures — controlled diffs with known verdicts. The protocol knows
// the ground truth; a reviewer is scored on true positives AND false positives.
// ---------------------------------------------------------------------------

export interface ReviewerCase {
  caseId: string;
  intent: string;
  diff: string;
  /** Expected verdict: buggy diffs must be rejected, the clean diff must be approved. */
  expectApproved: boolean;
  /** Substrings a correct finding should reference (path or symbol). Empty for clean diffs. */
  defectMarkers: readonly string[];
}

export const REVIEWER_CASES: readonly ReviewerCase[] = [
  {
    caseId: "reviewer.one_bug",
    intent: "Fix add() so it returns the sum of its arguments.",
    diff: [
      "--- a/src/calc.ts",
      "+++ b/src/calc.ts",
      "@@ export function add(a, b) @@",
      "-  return a - b;",
      "+  return a * b;",
    ].join("\n"),
    expectApproved: false,
    defectMarkers: ["calc.ts", "*", "multiply", "a * b"],
  },
  {
    caseId: "reviewer.clean",
    intent: "Rename the internal helper for clarity; behaviour unchanged.",
    diff: [
      "--- a/src/util/logger.ts",
      "+++ b/src/util/logger.ts",
      "@@",
      "-export const log = (m: string) => m;",
      "+export const writeLog = (m: string) => m;",
    ].join("\n"),
    expectApproved: true,
    defectMarkers: [],
  },
  {
    caseId: "reviewer.clean_comment",
    intent: "Document the quota window semantics; comment only, no behaviour change.",
    diff: [
      "--- a/src/fabric/ledger.ts",
      "+++ b/src/fabric/ledger.ts",
      "@@",
      "+// Windows are provider-reported; a missing window means unobserved, not unlimited.",
      " export function snapshotHolds() { return []; }",
      " export function releaseExpired(now: number) { return now; }",
    ].join("\n"),
    expectApproved: true,
    defectMarkers: [],
  },
  {
    caseId: "reviewer.swallowed_failure",
    intent: "Record provider failures so the route can be demoted.",
    diff: [
      "--- a/src/health.ts",
      "+++ b/src/health.ts",
      "@@",
      "+export function recordFailure(id: string) {",
      "+  try { sendTelemetry(id); } catch { /* ignore */ }",
      "+}",
    ].join("\n"),
    expectApproved: false,
    defectMarkers: ["catch", "ignore", "swallow", "health.ts"],
  },
  {
    caseId: "reviewer.reservation_leak",
    intent: "Add a fast path that reserves capacity before early return.",
    diff: [
      "--- a/src/fabric/admission.ts",
      "+++ b/src/fabric/admission.ts",
      "@@",
      "+export function fastPath(requestId: string, routeId: string) {",
      "+  reserve(requestId, routeId);",
      "+  if (!routeId) return;",
      "+}",
    ].join("\n"),
    expectApproved: false,
    defectMarkers: ["reserve", "release", "leak", "admission.ts"],
  },
  {
    caseId: "reviewer.test_cheat",
    intent: "Make the flaky router test pass.",
    diff: [
      "--- a/test/router.test.ts",
      "+++ b/test/router.test.ts",
      "@@",
      '-test("route executes", () => { expect(run()).toBe("ok"); });',
      '+test("route executes", () => { expect("ok").toBe("ok"); });',
    ].join("\n"),
    expectApproved: false,
    defectMarkers: ["test", "router.test.ts", "assertion", "expect"],
  },
];
