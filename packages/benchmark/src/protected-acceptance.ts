export const PROTECTED_ACCEPTANCE_STATES = [
  "accepted",
  "rejected",
  "not_applicable",
  "infrastructure_blocked",
] as const;

export type ProtectedAcceptanceState = (typeof PROTECTED_ACCEPTANCE_STATES)[number];

export type ProtectedEvidenceSource = "workspace" | "trace" | "authority" | "policy";

export interface ProtectedAcceptanceCheck {
  id: string;
  source: ProtectedEvidenceSource;
  observed: boolean;
  detail: string;
}

export interface ProtectedAcceptanceFinalState {
  terminalStatus: string;
  diffHash: string;
  changedFiles: readonly string[];
}

export interface ProtectedAcceptanceEvidence {
  schemaVersion: 1;
  stageId: "codeforge-r12-protected-acceptance";
  state: ProtectedAcceptanceState;
  checks: readonly ProtectedAcceptanceCheck[];
  finalState: ProtectedAcceptanceFinalState;
  reasons: readonly string[];
}

export interface ProtectedAcceptanceInput {
  split: "PROTECTED_TEST" | "PUBLIC";
  requiredEvidence: readonly string[];
  visibleAcceptance: "passed" | "failed" | "not_run";
  hiddenAcceptance: "passed" | "failed" | "not_run";
  forgeVerify: "passed" | "failed" | "blocked" | "not_run";
  finalState?: ProtectedAcceptanceFinalState;
  checks?: readonly ProtectedAcceptanceCheck[];
  infrastructureReason?: string;
}

export interface ProtectedAcceptanceResult {
  state: ProtectedAcceptanceState;
  evidence: ProtectedAcceptanceEvidence;
}

const VALID_SOURCES = new Set<ProtectedEvidenceSource>(["workspace", "trace", "authority", "policy"]);

function evidence(
  state: ProtectedAcceptanceState,
  checks: readonly ProtectedAcceptanceCheck[],
  finalState: ProtectedAcceptanceFinalState,
  reasons: readonly string[],
): ProtectedAcceptanceResult {
  return {
    state,
    evidence: {
      schemaVersion: 1,
      stageId: "codeforge-r12-protected-acceptance",
      state,
      checks,
      finalState,
      reasons,
    },
  };
}

function validFinalState(value: ProtectedAcceptanceFinalState | undefined): value is ProtectedAcceptanceFinalState {
  return value !== undefined
    && typeof value.terminalStatus === "string"
    && value.terminalStatus.length > 0
    && typeof value.diffHash === "string"
    && /^[a-f0-9]{64}$/i.test(value.diffHash)
    && Array.isArray(value.changedFiles)
    && value.changedFiles.every((file) => typeof file === "string" && file.length > 0);
}

/**
 * Evaluate the protected acceptance stage from independent final-state and trace evidence.
 *
 * The stage deliberately does not derive its result from `verified` or from one verifier
 * boolean. It requires a complete final state, at least two independent evidence sources, and
 * all checks to be observed. This keeps the strict protected summary honest without making the
 * protected stage a second spelling of the ordinary hidden verifier.
 */
export function evaluateProtectedAcceptance(input: ProtectedAcceptanceInput): ProtectedAcceptanceResult {
  const finalState = input.finalState ?? { terminalStatus: "unknown", diffHash: "", changedFiles: [] };
  if (input.split !== "PROTECTED_TEST") {
    return evidence("not_applicable", [], finalState, ["Case is not in the protected evaluation split."]);
  }
  if (input.infrastructureReason) {
    return evidence("infrastructure_blocked", input.checks ?? [], finalState, [input.infrastructureReason]);
  }
  if (input.requiredEvidence.length === 0 || !input.checks || input.checks.length === 0 || !validFinalState(input.finalState)) {
    return evidence("infrastructure_blocked", input.checks ?? [], finalState, ["Protected acceptance evidence is incomplete."]);
  }

  const malformed = input.checks.some((check) =>
    !check || typeof check.id !== "string" || check.id.trim() === ""
    || !VALID_SOURCES.has(check.source)
    || typeof check.observed !== "boolean"
    || typeof check.detail !== "string"
    || check.detail.trim() === "",
  );
  if (malformed || new Set(input.checks.map((check) => check.id)).size !== input.checks.length) {
    return evidence("rejected", input.checks, input.finalState, ["Protected acceptance evidence is malformed."]);
  }

  const sources = new Set(input.checks.map((check) => check.source));
  const failedChecks = input.checks.filter((check) => !check.observed).map((check) => check.id);
  const reasons: string[] = [];
  if (input.visibleAcceptance !== "passed") reasons.push("Visible acceptance did not pass.");
  if (input.hiddenAcceptance !== "passed") reasons.push("Independent hidden acceptance did not pass.");
  if (input.forgeVerify !== "passed") reasons.push("ForgeVerify did not pass.");
  if (failedChecks.length > 0) reasons.push(`Protected checks failed: ${failedChecks.join(", ")}.`);
  if (sources.size < 2) reasons.push("Protected acceptance requires evidence from at least two independent sources.");

  if (reasons.length > 0) return evidence("rejected", input.checks, input.finalState, reasons);
  return evidence("accepted", input.checks, input.finalState, [
    "Visible acceptance, hidden acceptance, ForgeVerify, and independent final-state checks passed.",
  ]);
}
