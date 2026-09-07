import crypto from "node:crypto";
import path from "node:path";
import { canonicalCacheKey } from "./canonical-cache.js";
import type { EfficiencyLedgerEvent } from "./ledger.js";
import {
  type AnalyzabilityClass,
  type TaskRiskClass,
  type ChangeKind,
  type StructuralRiskAnalysis,
  analyzeStructuralRisk,
} from "./risk.js";
import type { RepositoryIntelligence } from "@codeforge/repo-intelligence";

export const FORGE_GREEN_VERIFICATION_POLICY_VERSION = "fg5-verification-policy-1";

/**
 * Formal verification levels from V0 (provably no executable verification needed)
 * to V5 (full-system / release-grade verification).
 */
export type VerificationLevel =
  | "V0_NO_VERIFICATION"
  | "V1_LOCAL"
  | "V2_TARGETED"
  | "V3_PACKAGE"
  | "V4_CROSS_PACKAGE"
  | "V5_FULL_SYSTEM";

export type VerificationEvidenceKind =
  | "UNIT_TEST"
  | "TARGETED_TEST"
  | "PACKAGE_TEST"
  | "INTEGRATION_TEST"
  | "E2E_TEST"
  | "TYPECHECK"
  | "BUILD"
  | "LINT"
  | "STATIC_ANALYSIS"
  | "SCHEMA_VALIDATION"
  | "REAL_POSTGRESQL"
  | "REAL_CHILD_PROCESS"
  | "REAL_GIT"
  | "DELIVERY_CERTIFICATION"
  | "MANUAL_APPROVAL_EVIDENCE";

export type VerificationScope =
  | "workspace"
  | "target"
  | "package"
  | "cross_package"
  | "integration"
  | "publication"
  | "system";

export type VerificationReasonCode =
  | "PUBLIC_INTERFACE_CHANGED"
  | "MULTIPLE_DIRECT_CALLERS"
  | "CROSS_PACKAGE_DEPENDENCY"
  | "DYNAMIC_DISPATCH"
  | "UNRESOLVED_DEPENDENCY"
  | "GENERATED_CODE_BOUNDARY"
  | "CONFIGURATION_CHANGE"
  | "SHARED_TYPE_CHANGE"
  | "DATABASE_SCHEMA_CHANGE"
  | "PROCESS_OR_SHELL_CHANGE"
  | "GIT_BEHAVIOR_CHANGE"
  | "DOCUMENTATION_ONLY"
  | "HIGH_CONFIDENCE_STATIC_GRAPH"
  | "CANDIDATE_TESTS_PRESENT"
  | "SYSTEMIC_RISK"
  | "ANALYZABILITY_UNKNOWN"
  | "ANALYZABILITY_MODERATE"
  | "GRAPH_PARTIAL_OR_UNKNOWN"
  | "DELIVERY_INTENT"
  | "PUBLICATION_INTENT"
  | "USER_OVERRIDE_ESCALATION"
  | "DIRECT_UNIT_TEST"
  | "TARGETED_TYPECHECK"
  | "PACKAGE_TEST_SUITE"
  | "CROSS_PACKAGE_INTEGRATION"
  | "WORKSPACE_BUILD_TYPECHECK";

export interface VerificationObligationIdentity {
  namespace: string;
  workspacePath: string;
  obligationId: string;
  policyVersion: string;
  revision?: number;
}

export interface VerificationObligation {
  id: string;
  kind: VerificationEvidenceKind;
  scope: VerificationScope;
  targetPaths?: readonly string[];
  targetPackages?: readonly string[];
  required: boolean;
  reasonCodes: readonly VerificationReasonCode[];
  identity: VerificationObligationIdentity;
  commandHint?: string;
}

export type VerificationPolicyDecisionOutcome =
  | "SUFFICIENT"
  | "INSUFFICIENT"
  | "FAILED"
  | "BLOCKED"
  | "STALE";

export type VerificationPolicyReasonCode =
  | "REQUIRED_UNIT_TEST_MISSING"
  | "PACKAGE_TEST_PASS"
  | "PACKAGE_TEST_MISSING"
  | "CROSS_PACKAGE_INTEGRATION_MISSING"
  | "TYPECHECK_PASS"
  | "TYPECHECK_MISSING"
  | "BUILD_FAIL"
  | "BUILD_PASS"
  | "BUILD_MISSING"
  | "POSTGRES_REQUIRED"
  | "POSTGRES_PASS"
  | "POSTGRES_MISSING"
  | "CHILD_PROCESS_REQUIRED"
  | "CHILD_PROCESS_PASS"
  | "CHILD_PROCESS_MISSING"
  | "GIT_FIXTURE_REQUIRED"
  | "GIT_FIXTURE_PASS"
  | "GIT_FIXTURE_MISSING"
  | "STALE_REVISION"
  | "STALE_INPUT_STATE"
  | "DYNAMIC_ANALYSIS_INCOMPLETE"
  | "APPROVAL_BLOCKED"
  | "EXECUTION_FAILED"
  | "ALL_OBLIGATIONS_SATISFIED"
  | "V0_NO_VERIFICATION_REQUIRED"
  | "UNKNOWN_RISK_CONSERVATIVE"
  | "UNRESOLVED_DEPENDENCY_CONSERVATIVE"
  | "CONFIG_CHANGE_BROADENED"
  | "SCHEMA_MIGRATION_CONSERVATIVE"
  | "SKIPPED_REQUIRED_TEST"
  | "MALICIOUS_PROSE_REJECTED"
  | "POLICY_VERSION_MISMATCH";

export interface VerificationPolicyReceipt {
  kind: "verification_policy_receipt";
  receiptId: string;
  policyVersion: string;
  level: VerificationLevel;
  decision: VerificationPolicyDecisionOutcome;
  riskReceiptId?: string;
  obligations: readonly VerificationObligation[];
  satisfiedObligations: readonly string[];
  missingObligations: readonly string[];
  evidenceIds: readonly string[];
  reasonCodes: readonly VerificationPolicyReasonCode[];
  revision?: number;
  inputStateHash: string;
  createdAt: string;
}

export interface VerificationPolicyDecision {
  outcome: VerificationPolicyDecisionOutcome;
  level: VerificationLevel;
  policyVersion: string;
  obligations: readonly VerificationObligation[];
  satisfiedObligations: readonly string[];
  missingObligations: readonly string[];
  failedObligations: readonly string[];
  staleObligations: readonly string[];
  blockedObligations: readonly string[];
  reasonCodes: readonly VerificationPolicyReasonCode[];
  receipt: VerificationPolicyReceipt;
  rationale: string;
}

export interface VerificationPolicyCache {
  get(namespace: string, key: string): Promise<{ value: string } | undefined>;
  put(namespace: string, key: string, value: string): Promise<boolean | void>;
}

export interface VerificationPolicyRequest {
  changedPaths: readonly string[];
  changeKind?: ChangeKind;
  changeKinds?: Readonly<Record<string, ChangeKind>>;
  riskAnalysis?: StructuralRiskAnalysis;
  intelligence?: RepositoryIntelligence;
  workspacePath: string;
  namespace?: string;
  task?: string;
  executionRevision?: number;
  userRequestedLevel?: VerificationLevel;
  deliveryIntent?: boolean;
  publicationIntent?: boolean;
  policyVersion?: string;
  ledger?: { record(event: EfficiencyLedgerEvent): void };
  cache?: VerificationPolicyCache;
}

export interface VerificationPolicyObligationsResult {
  level: VerificationLevel;
  obligations: readonly VerificationObligation[];
  reasonCodes: readonly VerificationReasonCode[];
  riskAnalysis?: StructuralRiskAnalysis;
  isV0: boolean;
  policyVersion: string;
  receipt: VerificationPolicyReceipt;
}

export interface GenericVerificationEvidence {
  evidenceId: string;
  kind?: string;
  category?: string;
  verifierId?: string;
  scope?: string;
  workspacePath?: string;
  command?: string;
  targetPaths?: readonly string[];
  inputStateHash?: string;
  policyVersion?: string;
  status: "passed" | "failed" | "timed_out" | "cancelled" | "infra_error" | "interrupted" | "skipped";
  exitCode?: number;
  elapsedMs?: number;
  outputExcerpt?: string;
  passedCount?: number;
  failedCount?: number;
  skippedCount?: number;
  executionRevision?: number;
  createdAt?: string;
}

export interface VerificationSufficiencyInput {
  obligations: readonly VerificationObligation[];
  level: VerificationLevel;
  evidence: readonly GenericVerificationEvidence[];
  workspacePath: string;
  currentInputStateHash: string;
  currentExecutionRevision?: number;
  verifiedExecutionRevision?: number;
  policyVersion?: string;
  riskReceiptId?: string;
  ledger?: { record(event: EfficiencyLedgerEvent): void };
}

function normalizePath(p: string): string {
  return p.replaceAll("\\", "/").toLowerCase();
}

/**
 * Checks if a change is provably documentation-only with no executable or config impact.
 */
function isStrictlyDocumentation(
  changedPaths: readonly string[],
  changeKinds?: Readonly<Record<string, ChangeKind>> | ChangeKind,
): boolean {
  if (changedPaths.length === 0) return true;
  for (const file of changedPaths) {
    const norm = normalizePath(file);
    const ext = path.extname(norm);
    const isDocExt = [".md", ".txt", ".markdown", ".rst", ".adoc"].includes(ext);
    const isDocFile = norm.endsWith("license") || norm.endsWith("notice") || norm.endsWith("copying") || norm.includes("/docs/") || norm.startsWith("docs/");
    // Any code or configuration or schema file cannot be V0
    const isExecutableOrConfig = [
      ".ts", ".js", ".tsx", ".jsx", ".json", ".sql", ".sh", ".ps1", ".bat", ".cmd",
      ".yaml", ".yml", ".toml", ".c", ".cpp", ".rs", ".go", ".py", ".java", ".kt",
      ".swift", ".rb", ".php", ".cs",
    ].includes(ext) || norm.endsWith("package.json") || norm.includes("tsconfig");

    if (isExecutableOrConfig) return false;
    if (!isDocExt && !isDocFile) return false;
  }
  return true;
}

/**
 * Deterministically maps risk analysis, change kinds, and project facts to a VerificationLevel.
 */
export function determineVerificationLevel(
  changedPaths: readonly string[],
  risk?: StructuralRiskAnalysis,
  options: {
    changeKind?: ChangeKind;
    changeKinds?: Readonly<Record<string, ChangeKind>>;
    userRequestedLevel?: VerificationLevel;
    deliveryIntent?: boolean;
    publicationIntent?: boolean;
  } = {},
): { level: VerificationLevel; reasonCodes: VerificationReasonCode[] } {
  const reasonCodes: VerificationReasonCode[] = [];

  // V0 check: Strictly non-executable documentation
  if (isStrictlyDocumentation(changedPaths, options.changeKinds ?? options.changeKind)) {
    reasonCodes.push("DOCUMENTATION_ONLY");
    return { level: "V0_NO_VERIFICATION", reasonCodes };
  }

  // Delivery / publication intent mandates full system verification
  if (options.deliveryIntent) {
    reasonCodes.push("DELIVERY_INTENT");
    return { level: "V5_FULL_SYSTEM", reasonCodes };
  }
  if (options.publicationIntent) {
    reasonCodes.push("PUBLICATION_INTENT");
    return { level: "V5_FULL_SYSTEM", reasonCodes };
  }

  // Explicit API-surface changes have a deterministic cross-package obligation. They do not
  // become release-grade solely because structural analysis could not resolve every consumer.
  if (options.changeKind === "public_api") {
    reasonCodes.push("PUBLIC_INTERFACE_CHANGED");
    return { level: "V4_CROSS_PACKAGE", reasonCodes };
  }

  // Signature changes require caller-aware targeted/package verification, but are not by
  // themselves a reason to require full-system certification.
  if (options.changeKind === "signature") {
    reasonCodes.push("PUBLIC_INTERFACE_CHANGED");
    return { level: "V3_PACKAGE", reasonCodes };
  }

  // Check special file patterns
  for (const p of changedPaths) {
    const norm = normalizePath(p);
    if (norm.includes("migration") || norm.endsWith(".sql") || risk?.reasonCodes.includes("DATABASE_SCHEMA_CHANGE")) {
      if (!reasonCodes.includes("DATABASE_SCHEMA_CHANGE")) reasonCodes.push("DATABASE_SCHEMA_CHANGE");
    }
    if (norm.includes("child-process") || norm.includes("spawn") || norm.includes("exec")) {
      if (!reasonCodes.includes("PROCESS_OR_SHELL_CHANGE")) reasonCodes.push("PROCESS_OR_SHELL_CHANGE");
    }
    if (norm.includes("git") || norm.includes("worktree") || norm.includes("repo-inspector")) {
      if (!reasonCodes.includes("GIT_BEHAVIOR_CHANGE")) reasonCodes.push("GIT_BEHAVIOR_CHANGE");
    }
    if (norm.endsWith("package.json") || norm.includes("tsconfig") || options.changeKind === "config" || options.changeKind === "dependency") {
      if (!reasonCodes.includes("CONFIGURATION_CHANGE")) reasonCodes.push("CONFIGURATION_CHANGE");
    }
  }

  // Evaluate structural risk advice
  let computedLevel: VerificationLevel = "V3_PACKAGE";

  if (!risk) {
    reasonCodes.push("ANALYZABILITY_UNKNOWN");
    computedLevel = "V4_CROSS_PACKAGE";
  } else {
    // Collect risk reason codes
    if (risk.reasonCodes.includes("PUBLIC_INTERFACE_CHANGED")) reasonCodes.push("PUBLIC_INTERFACE_CHANGED");
    if (risk.reasonCodes.includes("SHARED_TYPE_CHANGE")) reasonCodes.push("SHARED_TYPE_CHANGE");
    if (risk.reasonCodes.includes("CROSS_PACKAGE_DEPENDENCY")) reasonCodes.push("CROSS_PACKAGE_DEPENDENCY");
    if (risk.reasonCodes.includes("DYNAMIC_DISPATCH")) reasonCodes.push("DYNAMIC_DISPATCH");
    if (risk.reasonCodes.includes("UNRESOLVED_DEPENDENCY")) reasonCodes.push("UNRESOLVED_DEPENDENCY");
    if (risk.reasonCodes.includes("MULTIPLE_DIRECT_CALLERS")) reasonCodes.push("MULTIPLE_DIRECT_CALLERS");
    if (risk.candidateTests.length > 0) reasonCodes.push("CANDIDATE_TESTS_PRESENT");

    if (risk.risk === "SYSTEMIC" || risk.analyzability === "LOW" || risk.analyzability === "UNKNOWN") {
      if (risk.risk === "SYSTEMIC") reasonCodes.push("SYSTEMIC_RISK");
      if (risk.analyzability === "UNKNOWN" || risk.analyzability === "LOW") reasonCodes.push("ANALYZABILITY_UNKNOWN");
      computedLevel = "V5_FULL_SYSTEM";
    } else if (
      risk.risk === "CROSS_PACKAGE" ||
      risk.reasonCodes.includes("CROSS_PACKAGE_DEPENDENCY") ||
      (options.changeKind === "config" && !changedPaths.some((p) => normalizePath(p) === "package.json"))
    ) {
      computedLevel = "V4_CROSS_PACKAGE";
    } else if (
      risk.risk === "CROSS_MODULE" ||
      risk.analyzability === "MODERATE" ||
      reasonCodes.includes("PUBLIC_INTERFACE_CHANGED") ||
      reasonCodes.includes("MULTIPLE_DIRECT_CALLERS") ||
      reasonCodes.includes("DYNAMIC_DISPATCH") ||
      reasonCodes.includes("UNRESOLVED_DEPENDENCY")
    ) {
      if (risk.analyzability === "MODERATE") reasonCodes.push("ANALYZABILITY_MODERATE");
      computedLevel = "V3_PACKAGE";
    } else if (risk.risk === "LIMITED" || risk.candidateTests.length > 0) {
      computedLevel = "V2_TARGETED";
    } else if (risk.risk === "LOCAL" && risk.analyzability === "HIGH") {
      reasonCodes.push("HIGH_CONFIDENCE_STATIC_GRAPH");
      computedLevel = "V1_LOCAL";
    }
  }

  // If user requested a higher level, escalate monotonically (user cannot lower mandatory verification)
  const levelOrder: Record<VerificationLevel, number> = {
    V0_NO_VERIFICATION: 0,
    V1_LOCAL: 1,
    V2_TARGETED: 2,
    V3_PACKAGE: 3,
    V4_CROSS_PACKAGE: 4,
    V5_FULL_SYSTEM: 5,
  };

  if (options.userRequestedLevel && levelOrder[options.userRequestedLevel] > levelOrder[computedLevel]) {
    reasonCodes.push("USER_OVERRIDE_ESCALATION");
    computedLevel = options.userRequestedLevel;
  }

  return { level: computedLevel, reasonCodes };
}

/**
 * Extracts affected package names from changed paths.
 */
function extractAffectedPackages(changedPaths: readonly string[]): string[] {
  const packages = new Set<string>();
  for (const p of changedPaths) {
    const norm = normalizePath(p);
    const match = norm.match(/(?:packages|apps|plugins)\/([^/]+)/);
    if (match && match[1]) {
      packages.add(match[1]);
    }
  }
  return [...packages].sort();
}

/**
 * Deterministically generates verification obligations from verification level, changed paths, and domain needs.
 */
export function generateVerificationObligations(
  workspacePath: string,
  level: VerificationLevel,
  changedPaths: readonly string[],
  reasonCodes: readonly VerificationReasonCode[],
  options: {
    namespace?: string;
    revision?: number;
    candidateTests?: readonly string[];
    affectedPackages?: readonly string[];
  } = {},
): readonly VerificationObligation[] {
  const obligations: VerificationObligation[] = [];
  const namespace = options.namespace ?? "default";
  const revision = options.revision;
  const packages = options.affectedPackages ?? extractAffectedPackages(changedPaths);

  if (level === "V0_NO_VERIFICATION") {
    return Object.freeze(obligations);
  }

  const makeObligation = (
    id: string,
    kind: VerificationEvidenceKind,
    scope: VerificationScope,
    required: boolean,
    reasons: VerificationReasonCode[],
    targetPaths?: readonly string[],
    targetPackages?: readonly string[],
    commandHint?: string,
  ): VerificationObligation => {
    return Object.freeze({
      id,
      kind,
      scope,
      targetPaths: targetPaths ? Object.freeze([...targetPaths]) : undefined,
      targetPackages: targetPackages ? Object.freeze([...targetPackages]) : undefined,
      required,
      reasonCodes: Object.freeze([...reasons]),
      identity: Object.freeze({
        namespace,
        workspacePath,
        obligationId: id,
        policyVersion: FORGE_GREEN_VERIFICATION_POLICY_VERSION,
        ...(revision !== undefined ? { revision } : {}),
      }),
      ...(commandHint ? { commandHint } : {}),
    });
  };

  // Base obligations by level
  switch (level) {
    case "V1_LOCAL":
      obligations.push(
        makeObligation("obligation.typecheck.local", "TYPECHECK", "target", true, ["TARGETED_TYPECHECK"], changedPaths, packages, "npm run typecheck"),
        makeObligation("obligation.unit_test.local", "UNIT_TEST", "target", true, ["DIRECT_UNIT_TEST"], changedPaths, packages, "npm test"),
      );
      break;

    case "V2_TARGETED":
      obligations.push(
        makeObligation("obligation.typecheck.targeted", "TYPECHECK", "target", true, ["TARGETED_TYPECHECK"], changedPaths, packages, "npm run typecheck"),
        makeObligation("obligation.test.targeted", "TARGETED_TEST", "target", true, ["CANDIDATE_TESTS_PRESENT"], options.candidateTests ?? changedPaths, packages, "npm test"),
      );
      break;

    case "V3_PACKAGE":
      obligations.push(
        makeObligation("obligation.typecheck.package", "TYPECHECK", "package", true, ["TARGETED_TYPECHECK"], changedPaths, packages, "npm run typecheck"),
        makeObligation("obligation.test.package", "PACKAGE_TEST", "package", true, ["PACKAGE_TEST_SUITE"], changedPaths, packages, "npm test"),
      );
      break;

    case "V4_CROSS_PACKAGE":
      obligations.push(
        makeObligation("obligation.typecheck.workspace", "TYPECHECK", "workspace", true, ["WORKSPACE_BUILD_TYPECHECK"], changedPaths, packages, "npm run typecheck"),
        makeObligation("obligation.build.workspace", "BUILD", "workspace", true, ["WORKSPACE_BUILD_TYPECHECK"], changedPaths, packages, "npm run build"),
        makeObligation("obligation.test.cross_package", "PACKAGE_TEST", "cross_package", true, ["CROSS_PACKAGE_INTEGRATION"], changedPaths, packages, "npm test"),
        makeObligation("obligation.test.integration", "INTEGRATION_TEST", "integration", true, ["CROSS_PACKAGE_INTEGRATION"], changedPaths, packages, "npm test"),
      );
      break;

    case "V5_FULL_SYSTEM":
      obligations.push(
        makeObligation("obligation.typecheck.system", "TYPECHECK", "workspace", true, ["WORKSPACE_BUILD_TYPECHECK"], changedPaths, packages, "npm run typecheck"),
        makeObligation("obligation.build.system", "BUILD", "workspace", true, ["WORKSPACE_BUILD_TYPECHECK"], changedPaths, packages, "npm run build"),
        makeObligation("obligation.test.system", "PACKAGE_TEST", "workspace", true, ["PACKAGE_TEST_SUITE"], changedPaths, packages, "npm test"),
        makeObligation("obligation.test.integration_system", "INTEGRATION_TEST", "system", true, ["CROSS_PACKAGE_INTEGRATION"], changedPaths, packages, "npm test"),
        makeObligation("obligation.test.e2e_system", "E2E_TEST", "system", true, ["SYSTEMIC_RISK"], changedPaths, packages, "npm test"),
      );
      break;
  }

  // Domain-specific requirements
  if (reasonCodes.includes("DATABASE_SCHEMA_CHANGE")) {
    obligations.push(
      makeObligation("obligation.real_postgres.migration", "REAL_POSTGRESQL", "integration", true, ["DATABASE_SCHEMA_CHANGE"], changedPaths, packages, "pg_parity"),
    );
  }

  if (reasonCodes.includes("PROCESS_OR_SHELL_CHANGE")) {
    obligations.push(
      makeObligation("obligation.real_child_process.execution", "REAL_CHILD_PROCESS", "integration", true, ["PROCESS_OR_SHELL_CHANGE"], changedPaths, packages, "child_process_e2e"),
    );
  }

  if (reasonCodes.includes("GIT_BEHAVIOR_CHANGE")) {
    obligations.push(
      makeObligation("obligation.real_git.mutation", "REAL_GIT", "integration", true, ["GIT_BEHAVIOR_CHANGE"], changedPaths, packages, "git_fixture_test"),
    );
  }

  if (reasonCodes.includes("DELIVERY_INTENT")) {
    obligations.push(
      makeObligation("obligation.delivery.certification", "DELIVERY_CERTIFICATION", "publication", true, ["DELIVERY_INTENT"], changedPaths, packages, "delivery_cert"),
    );
  }

  return Object.freeze(obligations);
}

/**
 * High-level policy evaluation: derives level, obligations, and initial receipt.
 */
export async function determineVerificationObligations(
  request: VerificationPolicyRequest,
): Promise<VerificationPolicyObligationsResult> {
  const namespace = request.namespace ?? "default";
  let riskAnalysis = request.riskAnalysis;

  // Run structural risk analysis if intelligence provided and no precomputed risk
  if (!riskAnalysis && request.intelligence) {
    try {
      riskAnalysis = await analyzeStructuralRisk({
        intelligence: request.intelligence,
        changedPaths: request.changedPaths,
        task: request.task,
        changeKind: request.changeKind,
        changeKinds: request.changeKinds,
      });
    } catch {
      // Degrade safely to conservative UNKNOWN
    }
  }

  const { level, reasonCodes } = determineVerificationLevel(
    request.changedPaths,
    riskAnalysis,
    {
      changeKind: request.changeKind,
      changeKinds: request.changeKinds,
      userRequestedLevel: request.userRequestedLevel,
      deliveryIntent: request.deliveryIntent,
      publicationIntent: request.publicationIntent,
    },
  );

  const obligations = generateVerificationObligations(
    request.workspacePath,
    level,
    request.changedPaths,
    reasonCodes,
    {
      namespace,
      revision: request.executionRevision,
      candidateTests: riskAnalysis?.candidateTests,
      affectedPackages: riskAnalysis?.packages,
    },
  );

  const isV0 = level === "V0_NO_VERIFICATION";
  const policyVersion = request.policyVersion ?? FORGE_GREEN_VERIFICATION_POLICY_VERSION;

  // Ledger recording
  if (request.ledger) {
    if (obligations.length > 0) {
      request.ledger.record({
        mechanism: "verification_policy",
        measurement: "measured",
        quantity: obligations.length,
        unit: "count",
        reason: "obligations_generated",
      });
    }
    if (isV0 || ["V1_LOCAL", "V2_TARGETED", "V3_PACKAGE"].includes(level)) {
      request.ledger.record({
        mechanism: "verification_policy",
        measurement: "measured",
        quantity: 1,
        unit: "count",
        reason: "targeted_suite_used",
      });
      request.ledger.record({
        mechanism: "verification_policy",
        measurement: "measured",
        quantity: 1,
        unit: "count",
        reason: "full_suite_avoided",
      });
    } else {
      request.ledger.record({
        mechanism: "verification_policy",
        measurement: "measured",
        quantity: 1,
        unit: "count",
        reason: "full_suite_required",
      });
    }
  }

  const receipt: VerificationPolicyReceipt = Object.freeze({
    kind: "verification_policy_receipt",
    receiptId: crypto.randomUUID(),
    policyVersion,
    level,
    decision: isV0 ? "SUFFICIENT" : "INSUFFICIENT",
    riskReceiptId: riskAnalysis?.receipt.receiptId,
    obligations,
    satisfiedObligations: isV0 ? [] : [],
    missingObligations: isV0 ? [] : obligations.map((o) => o.id),
    evidenceIds: [],
    reasonCodes: isV0 ? (["V0_NO_VERIFICATION_REQUIRED"] as const) : ([] as readonly VerificationPolicyReasonCode[]),
    revision: request.executionRevision,
    inputStateHash: "",
    createdAt: new Date().toISOString(),
  });

  return {
    level,
    obligations,
    reasonCodes,
    riskAnalysis,
    isV0,
    policyVersion,
    receipt,
  };
}

/**
 * Pure and deterministic evaluation of collected evidence against verification obligations.
 */
export function evaluateVerificationSufficiency(
  input: VerificationSufficiencyInput,
): VerificationPolicyDecision {
  const policyVersion = input.policyVersion ?? FORGE_GREEN_VERIFICATION_POLICY_VERSION;
  const reasonCodes: VerificationPolicyReasonCode[] = [];
  const satisfiedObligations: string[] = [];
  const missingObligations: string[] = [];
  const failedObligations: string[] = [];
  const staleObligations: string[] = [];
  const blockedObligations: string[] = [];
  const evidenceIds: string[] = [];

  // V0 check
  if (input.level === "V0_NO_VERIFICATION" || input.obligations.length === 0) {
    reasonCodes.push("V0_NO_VERIFICATION_REQUIRED");
    const receipt: VerificationPolicyReceipt = Object.freeze({
      kind: "verification_policy_receipt",
      receiptId: crypto.randomUUID(),
      policyVersion,
      level: input.level,
      decision: "SUFFICIENT",
      riskReceiptId: input.riskReceiptId,
      obligations: input.obligations,
      satisfiedObligations: [],
      missingObligations: [],
      evidenceIds: [],
      reasonCodes: Object.freeze(reasonCodes),
      revision: input.currentExecutionRevision,
      inputStateHash: input.currentInputStateHash,
      createdAt: new Date().toISOString(),
    });

    return {
      outcome: "SUFFICIENT",
      level: input.level,
      policyVersion,
      obligations: input.obligations,
      satisfiedObligations: [],
      missingObligations: [],
      failedObligations: [],
      staleObligations: [],
      blockedObligations: [],
      reasonCodes: Object.freeze(reasonCodes),
      receipt,
      rationale: "V0 documentation-only change requires no executable verification.",
    };
  }

  // Revision mismatch check (CF-17 exactness)
  const isRevisionStale =
    input.currentExecutionRevision !== undefined &&
    input.verifiedExecutionRevision !== undefined &&
    input.currentExecutionRevision !== input.verifiedExecutionRevision;

  if (isRevisionStale) {
    reasonCodes.push("STALE_REVISION");
  }

  for (const obligation of input.obligations) {
    // Find matching candidate evidence
    const matchingEvidence = input.evidence.filter((ev) => {
      // Match by verifier category / kind or ID or hint
      const kindMatch =
        ev.kind === obligation.kind ||
        ev.category === obligation.kind.toLowerCase() ||
        (obligation.kind === "TYPECHECK" && (ev.verifierId?.includes("typecheck") || ev.category === "typecheck")) ||
        (obligation.kind === "BUILD" && (ev.verifierId?.includes("build") || ev.category === "build")) ||
        (obligation.kind === "UNIT_TEST" && (ev.verifierId?.includes("test") || ev.category === "unit-test")) ||
        (obligation.kind === "TARGETED_TEST" && (ev.verifierId?.includes("test") || ev.category === "unit-test")) ||
        (obligation.kind === "PACKAGE_TEST" && (ev.verifierId?.includes("test") || ev.category === "unit-test" || ev.category === "integration-test")) ||
        (obligation.kind === "INTEGRATION_TEST" && (ev.verifierId?.includes("test") || ev.category === "integration-test")) ||
        (obligation.kind === "E2E_TEST" && (ev.verifierId?.includes("test") || ev.category === "e2e-test")) ||
        (obligation.kind === "REAL_POSTGRESQL" && (ev.verifierId?.includes("postgres") || ev.kind === "REAL_POSTGRESQL")) ||
        (obligation.kind === "REAL_CHILD_PROCESS" && (ev.verifierId?.includes("child-process") || ev.kind === "REAL_CHILD_PROCESS")) ||
        (obligation.kind === "REAL_GIT" && (ev.verifierId?.includes("git") || ev.kind === "REAL_GIT")) ||
        (obligation.kind === "DELIVERY_CERTIFICATION" && (ev.verifierId?.includes("delivery") || ev.kind === "DELIVERY_CERTIFICATION"));

      return kindMatch;
    });

    if (matchingEvidence.length === 0) {
      missingObligations.push(obligation.id);
      if (obligation.kind === "TYPECHECK") reasonCodes.push("TYPECHECK_MISSING");
      else if (obligation.kind === "BUILD") reasonCodes.push("BUILD_MISSING");
      else if (obligation.kind === "REAL_POSTGRESQL") reasonCodes.push("POSTGRES_MISSING");
      else if (obligation.kind === "REAL_CHILD_PROCESS") reasonCodes.push("CHILD_PROCESS_MISSING");
      else if (obligation.kind === "REAL_GIT") reasonCodes.push("GIT_FIXTURE_MISSING");
      else if (obligation.kind === "PACKAGE_TEST") reasonCodes.push("PACKAGE_TEST_MISSING");
      else if (obligation.kind === "INTEGRATION_TEST") reasonCodes.push("CROSS_PACKAGE_INTEGRATION_MISSING");
      else reasonCodes.push("REQUIRED_UNIT_TEST_MISSING");
      continue;
    }

    // Check evidence status and freshness
    let hasValidPass = false;
    let hasFailure = false;
    let hasStale = false;
    let hasBlocked = false;

    for (const ev of matchingEvidence) {
      evidenceIds.push(ev.evidenceId);

      // Policy version check
      if (ev.policyVersion && ev.policyVersion !== policyVersion) {
        hasStale = true;
        if (!reasonCodes.includes("POLICY_VERSION_MISMATCH")) reasonCodes.push("POLICY_VERSION_MISMATCH");
      }

      // Input state hash check (dirty tree / HEAD)
      if (ev.inputStateHash && ev.inputStateHash !== input.currentInputStateHash) {
        hasStale = true;
        if (!reasonCodes.includes("STALE_INPUT_STATE")) reasonCodes.push("STALE_INPUT_STATE");
      }

      if (isRevisionStale) {
        hasStale = true;
      }

      // Execution status check
      if (ev.status === "failed" || (typeof ev.exitCode === "number" && ev.exitCode !== 0) || (ev.failedCount !== undefined && ev.failedCount > 0)) {
        hasFailure = true;
        if (obligation.kind === "BUILD" && !reasonCodes.includes("BUILD_FAIL")) reasonCodes.push("BUILD_FAIL");
        else if (!reasonCodes.includes("EXECUTION_FAILED")) reasonCodes.push("EXECUTION_FAILED");
      } else if (ev.status === "timed_out" || ev.status === "cancelled" || ev.status === "infra_error" || ev.status === "interrupted") {
        hasBlocked = true;
        if (!reasonCodes.includes("APPROVAL_BLOCKED")) reasonCodes.push("APPROVAL_BLOCKED");
      } else if (ev.status === "passed" && (ev.exitCode === undefined || ev.exitCode === 0)) {
        // Check if all required tests were skipped
        if (ev.skippedCount !== undefined && ev.skippedCount > 0 && ev.passedCount === 0) {
          hasBlocked = true;
          if (!reasonCodes.includes("SKIPPED_REQUIRED_TEST")) reasonCodes.push("SKIPPED_REQUIRED_TEST");
        } else if (!hasStale) {
          hasValidPass = true;
        }
      }
    }

    if (hasFailure) {
      failedObligations.push(obligation.id);
    } else if (hasStale) {
      staleObligations.push(obligation.id);
    } else if (hasBlocked) {
      blockedObligations.push(obligation.id);
    } else if (hasValidPass) {
      satisfiedObligations.push(obligation.id);
      if (obligation.kind === "TYPECHECK" && !reasonCodes.includes("TYPECHECK_PASS")) reasonCodes.push("TYPECHECK_PASS");
      else if (obligation.kind === "BUILD" && !reasonCodes.includes("BUILD_PASS")) reasonCodes.push("BUILD_PASS");
      else if (obligation.kind === "PACKAGE_TEST" && !reasonCodes.includes("PACKAGE_TEST_PASS")) reasonCodes.push("PACKAGE_TEST_PASS");
      else if (obligation.kind === "REAL_POSTGRESQL" && !reasonCodes.includes("POSTGRES_PASS")) reasonCodes.push("POSTGRES_PASS");
      else if (obligation.kind === "REAL_CHILD_PROCESS" && !reasonCodes.includes("CHILD_PROCESS_PASS")) reasonCodes.push("CHILD_PROCESS_PASS");
      else if (obligation.kind === "REAL_GIT" && !reasonCodes.includes("GIT_FIXTURE_PASS")) reasonCodes.push("GIT_FIXTURE_PASS");
    } else {
      missingObligations.push(obligation.id);
    }
  }

  // Determine overall outcome
  let outcome: VerificationPolicyDecisionOutcome = "SUFFICIENT";
  let rationale = "All verification obligations satisfied.";

  if (failedObligations.length > 0) {
    outcome = "FAILED";
    rationale = `Verification failed for ${failedObligations.length} obligation(s): ${failedObligations.join(", ")}.`;
  } else if (staleObligations.length > 0 || isRevisionStale) {
    outcome = "STALE";
    rationale = `Verification evidence is stale for ${staleObligations.length} obligation(s) due to working tree changes or revision advancement.`;
  } else if (blockedObligations.length > 0) {
    outcome = "BLOCKED";
    rationale = `Verification was interrupted or blocked for ${blockedObligations.length} obligation(s).`;
  } else if (missingObligations.length > 0) {
    outcome = "INSUFFICIENT";
    rationale = `Missing required verification evidence for ${missingObligations.length} obligation(s): ${missingObligations.join(", ")}.`;
  } else {
    reasonCodes.push("ALL_OBLIGATIONS_SATISFIED");
  }

  // Ledger recording
  if (input.ledger) {
    if (staleObligations.length > 0 || isRevisionStale) {
      input.ledger.record({
        mechanism: "verification_policy",
        measurement: "measured",
        quantity: staleObligations.length || 1,
        unit: "count",
        reason: "stale_rejected",
      });
    }
    if (satisfiedObligations.length > 0 && outcome === "SUFFICIENT") {
      input.ledger.record({
        mechanism: "verification_policy",
        measurement: "measured",
        quantity: satisfiedObligations.length,
        unit: "count",
        reason: "evidence_reused",
      });
    }
    if (outcome === "BLOCKED") {
      input.ledger.record({
        mechanism: "verification_policy",
        measurement: "measured",
        quantity: 1,
        unit: "count",
        reason: "blocked",
      });
    }
  }

  const receipt: VerificationPolicyReceipt = Object.freeze({
    kind: "verification_policy_receipt",
    receiptId: crypto.randomUUID(),
    policyVersion,
    level: input.level,
    decision: outcome,
    riskReceiptId: input.riskReceiptId,
    obligations: input.obligations,
    satisfiedObligations: Object.freeze([...satisfiedObligations]),
    missingObligations: Object.freeze([...missingObligations]),
    evidenceIds: Object.freeze([...new Set(evidenceIds)]),
    reasonCodes: Object.freeze([...reasonCodes]),
    revision: input.currentExecutionRevision,
    inputStateHash: input.currentInputStateHash,
    createdAt: new Date().toISOString(),
  });

  return {
    outcome,
    level: input.level,
    policyVersion,
    obligations: input.obligations,
    satisfiedObligations: Object.freeze(satisfiedObligations),
    missingObligations: Object.freeze(missingObligations),
    failedObligations: Object.freeze(failedObligations),
    staleObligations: Object.freeze(staleObligations),
    blockedObligations: Object.freeze(blockedObligations),
    reasonCodes: Object.freeze(reasonCodes),
    receipt,
    rationale,
  };
}
