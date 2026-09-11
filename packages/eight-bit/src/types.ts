import { z } from "zod";

/**
 * 8-Bit is CodeForge's dynamic model-routing/failover control core. It is routing authority
 * only: it decides which policy-eligible provider+model route serves a CodeForge role. It
 * cannot grant filesystem/shell permission, satisfy an approval or question, certify
 * ForgeVerify or Completion Gate, or cross the free/paid/BYOK/premium policy boundary without
 * explicit authorization. See docs/eight-bit.md for the full authority-boundary writeup.
 */

// --- Roles -----------------------------------------------------------------------------------

export const EightBitRoleSchema = z.enum([
  "CODER",
  "REASONER",
  "PLANNER",
  "REVIEWER",
  "FAST_WORKER",
  "LONG_CONTEXT",
  "VISION",
  "TOOL_AGENT",
  "ANALYST",
]);
export type EightBitRole = z.infer<typeof EightBitRoleSchema>;

/** Hard minimum requirements a route must satisfy to be eligible for a role. Separate from
 * ranking: a route either meets these or it is not a candidate, regardless of score. */
export interface RoleContract {
  role: EightBitRole;
  requiresTools: boolean;
  requiresStructuredOutput: boolean;
  requiresVision: boolean;
  requiresLongContext: boolean;
  minContextTokens: number;
  /** Hard tool-reliability floor (0-1). Only enforced once enough live samples exist. */
  minToolReliability: number;
}

export const ROLE_CONTRACTS: Readonly<Record<EightBitRole, RoleContract>> = {
  CODER: { role: "CODER", requiresTools: true, requiresStructuredOutput: false, requiresVision: false, requiresLongContext: false, minContextTokens: 8_000, minToolReliability: 0.6 },
  REASONER: { role: "REASONER", requiresTools: false, requiresStructuredOutput: false, requiresVision: false, requiresLongContext: false, minContextTokens: 8_000, minToolReliability: 0 },
  PLANNER: { role: "PLANNER", requiresTools: false, requiresStructuredOutput: false, requiresVision: false, requiresLongContext: false, minContextTokens: 8_000, minToolReliability: 0 },
  REVIEWER: { role: "REVIEWER", requiresTools: false, requiresStructuredOutput: false, requiresVision: false, requiresLongContext: false, minContextTokens: 8_000, minToolReliability: 0 },
  FAST_WORKER: { role: "FAST_WORKER", requiresTools: true, requiresStructuredOutput: false, requiresVision: false, requiresLongContext: false, minContextTokens: 4_000, minToolReliability: 0.5 },
  LONG_CONTEXT: { role: "LONG_CONTEXT", requiresTools: false, requiresStructuredOutput: false, requiresVision: false, requiresLongContext: true, minContextTokens: 100_000, minToolReliability: 0 },
  VISION: { role: "VISION", requiresTools: false, requiresStructuredOutput: false, requiresVision: true, requiresLongContext: false, minContextTokens: 8_000, minToolReliability: 0 },
  TOOL_AGENT: { role: "TOOL_AGENT", requiresTools: true, requiresStructuredOutput: true, requiresVision: false, requiresLongContext: false, minContextTokens: 8_000, minToolReliability: 0.7 },
  ANALYST: { role: "ANALYST", requiresTools: false, requiresStructuredOutput: false, requiresVision: false, requiresLongContext: false, minContextTokens: 8_000, minToolReliability: 0 },
} as const;

// --- Failure classification -------------------------------------------------------------------

export const FailureReasonSchema = z.enum([
  "TRANSIENT_NETWORK",
  "TIMEOUT",
  "RATE_LIMITED",
  "QUOTA_EXHAUSTED",
  "MODEL_NOT_FOUND",
  "MODEL_RETIRED",
  "PROVIDER_OUTAGE",
  "AUTH_FAILURE",
  "FREE_ELIGIBILITY_REMOVED",
  "CONTEXT_LIMIT",
  "INVALID_TOOL_OUTPUT",
  "STRUCTURED_OUTPUT_FAILURE",
  "UNKNOWN",
]);
export type FailureReason = z.infer<typeof FailureReasonSchema>;

/** Whether a classified failure justifies bounded retry, cooldown+rotation, or immediate
 * removal. Kept separate from the classifier so policy can be reasoned about/tested standalone. */
export type FailurePolicy = "bounded_retry" | "cooldown_and_rotate" | "remove_and_refresh" | "surface_only";

export const FAILURE_POLICY: Readonly<Record<FailureReason, FailurePolicy>> = {
  TRANSIENT_NETWORK: "bounded_retry",
  TIMEOUT: "bounded_retry",
  RATE_LIMITED: "cooldown_and_rotate",
  QUOTA_EXHAUSTED: "cooldown_and_rotate",
  MODEL_NOT_FOUND: "remove_and_refresh",
  MODEL_RETIRED: "remove_and_refresh",
  PROVIDER_OUTAGE: "cooldown_and_rotate",
  AUTH_FAILURE: "cooldown_and_rotate",
  FREE_ELIGIBILITY_REMOVED: "remove_and_refresh",
  CONTEXT_LIMIT: "surface_only",
  INVALID_TOOL_OUTPUT: "surface_only",
  STRUCTURED_OUTPUT_FAILURE: "surface_only",
  UNKNOWN: "bounded_retry",
} as const;

// --- Route assignment / health --------------------------------------------------------------

export const RouteAssignmentSchema = z.enum(["PRIMARY", "STANDBY", "ELIGIBLE", "COOLDOWN", "INELIGIBLE"]);
export type RouteAssignment = z.infer<typeof RouteAssignmentSchema>;

export interface RouteKey {
  providerId: string;
  modelId: string;
}

export function routeKeyOf(providerId: string, modelId: string): string {
  return `${providerId}::${modelId}`;
}

/** Per-route rolling health as tracked live by 8-Bit. Distinct from ForgeZero's
 * `ModelHealthState`, which this feeds via `markProviderHealth`. */
export interface EightBitRouteHealth {
  providerId: string;
  modelId: string;
  consecutiveFailures: number;
  lastFailureReason?: FailureReason;
  lastFailureAt?: string;
  cooldownUntil?: number;
  status: "HEALTHY" | "DEGRADED" | "RATE_LIMITED" | "QUOTA_EXHAUSTED" | "UNAVAILABLE" | "SUSPENDED" | "UNKNOWN";
}

// --- Tool reliability --------------------------------------------------------------------------

export interface ReliabilitySample {
  attempts: number;
  validCalls: number;
  malformedCalls: number;
  unknownToolCalls: number;
  missingArgCalls: number;
  schemaViolations: number;
  structuredOutputFailures: number;
}

export interface ReliabilityScore {
  /** 0-1, undefined when there are not yet enough samples to judge (explicit unknown). */
  score: number | undefined;
  sampleSize: number;
  demoted: boolean;
  quarantined: boolean;
}

// --- Decision receipts -------------------------------------------------------------------------

export const DecisionActionSchema = z.enum([
  "INITIAL_SELECTION",
  "ROTATE",
  "COOLDOWN",
  "QUARANTINE",
  "RESTORE",
  "NO_ELIGIBLE_ROUTE",
  "EXACT_PIN_FAILED",
]);
export type DecisionAction = z.infer<typeof DecisionActionSchema>;

export interface DecisionReceipt {
  receiptId: string;
  createdAt: string;
  sessionId: string;
  runId?: string;
  agentId?: string;
  turnId?: string;
  workstreamId?: string;
  role: EightBitRole;
  action: DecisionAction;
  policyMode: "adaptive" | "exact-pin";
  previous?: RouteKey;
  selected?: RouteKey;
  reasonCodes: string[];
  /** Non-secret evidence references (e.g. failure reason, receipt ids). Never raw prompts. */
  evidence?: Record<string, string | number | boolean>;
}

// --- Handoff -------------------------------------------------------------------------------

export interface HandoffCompletedAction {
  kind: "tool_call" | "file_change" | "command";
  summary: string;
  at?: string;
}

/** FG-3: a reusable Context Page the replacement model can pull via the existing repo_* tools
 * (which are already cache-backed by the same store) rather than needing the full page content
 * inlined into the handoff message. */
export interface HandoffContextPageRef {
  type: string;
  path: string;
  /** True when this page was served from the persistent cross-session/cross-worktree page
   * cache rather than freshly recomputed — the observable "reused a valid Context Page" signal. */
  reused: boolean;
}

/** Bounded, deterministic snapshot of authoritative runtime truth handed to a replacement
 * route. This is a summary for injection into the model-visible context, never the source of
 * truth itself — CodeForge runtime persistence remains authoritative. `kernel`/`contextPages`
 * are the FG-3 additions (both optional; every pre-FG-3 field and consumer is unchanged). */
export interface HandoffContext {
  sessionId: string;
  turnId: string;
  objective: string;
  completedActions: HandoffCompletedAction[];
  changedFiles: string[];
  verificationRequired: boolean;
  approvalPending: boolean;
  questionPending: boolean;
  repositoryIntelligenceCompleteness?: "COMPLETE" | "PARTIAL" | "UNKNOWN";
  generatedAt: string;
  /** FG-3A: the full authoritative Context Kernel this handoff was derived from (steer state,
   * verification status/plan id, constraints, workstream/revision identity). */
  kernel?: import("@codeforge/context").ContextKernel;
  /** FG-3D: reusable Context Pages available for the changed files in this turn. */
  contextPages?: HandoffContextPageRef[];
}

export function renderHandoffMessage(ctx: HandoffContext): string {
  const lines: string[] = [
    "[8-Bit model handoff] The previous model for this turn became unavailable. You are continuing " +
      "the SAME turn — do not restart, do not re-introduce yourself, do not repeat any action listed below.",
    `Objective: ${ctx.objective}`,
  ];
  if (ctx.completedActions.length > 0) {
    lines.push("Already completed (do not repeat):");
    for (const action of ctx.completedActions.slice(0, 25)) {
      lines.push(`- [${action.kind}] ${action.summary}`);
    }
  }
  if (ctx.changedFiles.length > 0) {
    lines.push(`Files already changed this turn: ${ctx.changedFiles.slice(0, 25).join(", ")}`);
  }
  if (ctx.approvalPending) lines.push("An approval is pending — do not assume it was granted.");
  if (ctx.questionPending) lines.push("A question to the user is pending — do not assume it was answered.");
  if (ctx.verificationRequired) lines.push("Verification is still required before this task may be reported complete.");
  if (ctx.repositoryIntelligenceCompleteness) {
    lines.push(`Repository intelligence completeness: ${ctx.repositoryIntelligenceCompleteness} (do not treat as more complete than reported).`);
  }
  if (ctx.kernel) {
    if (ctx.kernel.constraints.length > 0) lines.push(`Constraints: ${ctx.kernel.constraints.join("; ")}`);
    if (ctx.kernel.steer.unconsumedSteerIds.length > 0) {
      lines.push(`${ctx.kernel.steer.unconsumedSteerIds.length} user steering instruction(s) are queued and not yet applied.`);
    }
    if (ctx.kernel.steer.lastConsumedSteerId) {
      lines.push(`Most recently applied steering instruction: ${ctx.kernel.steer.lastConsumedSteerId} (do not re-apply it).`);
    }
    if (ctx.kernel.verification.latestStatus) {
      lines.push(`Latest recorded verification status: ${ctx.kernel.verification.latestStatus}.`);
    }
  }
  if (ctx.contextPages && ctx.contextPages.length > 0) {
    lines.push(
      `Reusable structural context is available for: ${ctx.contextPages.map((page) => `${page.path} [${page.type}${page.reused ? ", cached" : ""}]`).join(", ")}. Pull details with repo_dependencies/repo_dependents/repo_tests/repo_file_summary rather than re-deriving them.`,
    );
  }
  return lines.join("\n");
}

// --- Overall status ----------------------------------------------------------------------------

export const EightBitOverallStatusSchema = z.enum([
  "HEALTHY",
  "DEGRADED",
  "SCANNING",
  "ROTATING",
  "POLICY_BLOCKED",
  "NO_ELIGIBLE_MODEL",
  "OFFLINE",
]);
export type EightBitOverallStatus = z.infer<typeof EightBitOverallStatusSchema>;

export const EightBitStatusEventSchema = z.enum([
  "CATALOG_SCAN_STARTED",
  "ROUTE_DEGRADED",
  "ROUTE_COOLDOWN",
  "PROVIDER_OFFLINE",
  "PROVIDER_ONLINE",
  "FREE_ELIGIBILITY_REMOVED",
  "ROUTE_ROTATION_STARTED",
  "ROUTE_ROTATED",
  "ROUTE_READY",
  "NO_ELIGIBLE_FREE_MODEL",
]);
export type EightBitStatusEvent = z.infer<typeof EightBitStatusEventSchema>;

export interface RoleDiagnostics {
  role: EightBitRole;
  primary?: RouteKey;
  standby?: RouteKey;
  status: EightBitOverallStatus;
}
