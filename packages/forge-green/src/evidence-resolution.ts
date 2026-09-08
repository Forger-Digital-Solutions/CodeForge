import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { canonicalCacheKey } from "./canonical-cache.js";
import type { EfficiencyLedgerEvent } from "./ledger.js";
import {
  FORGE_GREEN_VERIFICATION_POLICY_VERSION,
  type GenericVerificationEvidence,
  type VerificationEvidenceKind,
  type VerificationObligation,
  type VerificationReasonCode,
  type VerificationScope,
} from "./verification-policy.js";

export const FORGE_GREEN_EVIDENCE_RESOLVER_VERSION = "fg6-evidence-resolution-2";

export type EvidenceResolutionOutcome =
  | "RESOLVED"
  | "PARTIALLY_RESOLVED"
  | "BLOCKED"
  | "INVALID"
  | "STALE";

export type SubsumptionReasonCode =
  | "EXACT_DUPLICATE"
  | "WORKSPACE_TYPECHECK_INCLUDES_PACKAGE"
  | "WORKSPACE_BUILD_INCLUDES_PACKAGE"
  | "PARENT_TEST_SUITE"
  | "PACKAGE_TEST_INCLUDES_TARGETED"
  | "ALREADY_VALID_EVIDENCE"
  | "EXPLICIT_POLICY_EQUIVALENCE"
  | "WORKSPACE_SUITE_INCLUDES_PACKAGE";

export interface SubsumptionRecord {
  subsumingProducerId: string;
  subsumedObligationId: string;
  reasonCode: SubsumptionReasonCode;
  basis: string;
  targetScope?: string;
}

export interface DeduplicatedObligation {
  id: string;
  canonicalKey: string;
  kind: VerificationEvidenceKind;
  scope: VerificationScope;
  targetPaths?: readonly string[];
  targetPackages?: readonly string[];
  required: boolean;
  reasonCodes: readonly VerificationReasonCode[];
  sourceObligationIds: readonly string[];
  commandHint?: string;
  requiredEnvironment?: readonly string[];
}

export interface PlannedEvidenceProducer {
  producerId: string;
  kind: VerificationEvidenceKind;
  scope: VerificationScope;
  command: string;
  commandArgs?: readonly string[];
  targetPackage?: string;
  targetPaths?: readonly string[];
  satisfiedObligationIds: readonly string[];
  subsumptions: readonly SubsumptionRecord[];
  costEstimate: number;
  environmentRequirements?: readonly string[];
  isReusedEvidence?: boolean;
  reusedEvidenceId?: string;
}

export interface EvidenceResolutionReceipt {
  kind: "evidence_resolution_receipt";
  receiptId: string;
  resolutionId: string;
  policyReceiptId?: string;
  policyVersion: string;
  resolverVersion: string;
  /** Canonical identity of the inputs that may restore this advisory resolution. */
  cacheIdentity: string;
  outcome: EvidenceResolutionOutcome;
  revision?: number;
  inputStateHash: string;
  inputObligationCount: number;
  deduplicatedObligationCount: number;
  alreadySatisfiedObligationCount: number;
  subsumedObligationCount: number;
  scheduledProducerCount: number;
  dispatchesAvoidedCount: number;
  inputObligations: readonly VerificationObligation[];
  deduplicatedObligations: readonly DeduplicatedObligation[];
  subsumptions: readonly SubsumptionRecord[];
  producers: readonly PlannedEvidenceProducer[];
  unresolvedObligationIds: readonly string[];
  reasonCodes: readonly string[];
  createdAt: string;
}

export interface PackageResolutionMeta {
  name: string;
  path: string;
  relativeDir: string;
  tsconfigPath?: string;
  testFiles?: readonly string[];
  scripts?: Record<string, string>;
  isExcludedFromWorkspaceTypecheck?: boolean;
}

export interface WorkspaceResolutionConfig {
  workspacePath: string;
  packages: readonly PackageResolutionMeta[];
  workspaceTypecheckIncludesAllPackages?: boolean;
  workspaceBuildIncludesAllPackages?: boolean;
  workspaceTestIncludesAllPackages?: boolean;
  packageTestSuites?: Record<string, { command: string; testFiles: readonly string[]; requiresPostgres?: boolean }>;
  environmentAvailability?: { postgres?: boolean; git?: boolean; childProcess?: boolean };
  configHash?: string;
}

export interface EvidenceResolutionRequest {
  obligations: readonly VerificationObligation[];
  workspacePath: string;
  existingEvidence?: readonly GenericVerificationEvidence[];
  workspaceConfig?: WorkspaceResolutionConfig;
  namespace?: string;
  policyReceiptId?: string;
  policyVersion?: string;
  resolverVersion?: string;
  executionRevision?: number;
  verifiedExecutionRevision?: number;
  currentInputStateHash?: string;
  environmentAvailability?: { postgres?: boolean; git?: boolean; childProcess?: boolean };
  ledger?: { record(event: EfficiencyLedgerEvent): void };
  cache?: {
    get(namespace: string, key: string): Promise<{ value: string } | undefined>;
    put(namespace: string, key: string, value: string): Promise<boolean | void>;
  };
}

export interface EvidenceResolutionResult {
  outcome: EvidenceResolutionOutcome;
  producers: readonly PlannedEvidenceProducer[];
  receipt: EvidenceResolutionReceipt;
  subsumptions: readonly SubsumptionRecord[];
  deduplicatedObligations: readonly DeduplicatedObligation[];
  alreadySatisfiedObligations: readonly string[];
  unresolvedObligations: readonly string[];
  dispatchesAvoided: number;
  isResolved: boolean;
  rationale: string;
}

function normalizeObligationForCache(obligation: VerificationObligation): Record<string, unknown> {
  return {
    id: obligation.id,
    kind: obligation.kind,
    scope: obligation.scope,
    required: obligation.required,
    targetPaths: [...(obligation.targetPaths ?? [])].map((item) => item.replaceAll("\\", "/")).sort(),
    targetPackages: [...(obligation.targetPackages ?? [])].sort(),
    reasonCodes: [...obligation.reasonCodes].sort(),
    commandHint: obligation.commandHint ?? "",
    identity: obligation.identity
      ? {
          namespace: obligation.identity.namespace,
          policyVersion: obligation.identity.policyVersion,
          obligationId: obligation.identity.obligationId,
        }
      : undefined,
  };
}

function resolutionCacheIdentity(input: {
  namespace: string;
  policyVersion: string;
  resolverVersion: string;
  obligations: readonly VerificationObligation[];
  configHash?: string;
  inputStateHash: string;
  executionRevision?: number;
  environmentAvailability: { postgres?: boolean; git?: boolean; childProcess?: boolean };
}): string {
  return canonicalCacheKey({
    namespace: input.namespace,
    analysis: "fg6_evidence_resolution",
    parameters: {
      obligations: input.obligations.map(normalizeObligationForCache).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
      configHash: input.configHash ?? "",
      executionRevision: input.executionRevision ?? null,
      environmentAvailability: input.environmentAvailability,
      resolverVersion: input.resolverVersion,
    },
    policyVersion: input.policyVersion,
    runtimeConfigDigest: input.configHash,
    contentHashes: input.inputStateHash ? [input.inputStateHash] : [],
  });
}

function isCurrentCachedReceipt(
  value: unknown,
  expected: {
    policyVersion: string;
    resolverVersion: string;
    cacheIdentity: string;
    inputStateHash: string;
    executionRevision?: number;
    inputObligationCount: number;
  },
): value is EvidenceResolutionReceipt {
  if (!value || typeof value !== "object") return false;
  const receipt = value as Partial<EvidenceResolutionReceipt>;
  return receipt.kind === "evidence_resolution_receipt"
    && receipt.outcome === "RESOLVED"
    && receipt.policyVersion === expected.policyVersion
    && receipt.resolverVersion === expected.resolverVersion
    && receipt.cacheIdentity === expected.cacheIdentity
    && receipt.inputStateHash === expected.inputStateHash
    && receipt.revision === expected.executionRevision
    && receipt.inputObligationCount === expected.inputObligationCount
    && Array.isArray(receipt.inputObligations)
    && Array.isArray(receipt.deduplicatedObligations)
    && Array.isArray(receipt.subsumptions)
    && Array.isArray(receipt.producers)
    && Array.isArray(receipt.unresolvedObligationIds)
    && Array.isArray(receipt.reasonCodes);
}

/**
 * Derives the canonical key for a verification obligation based strictly on its
 * semantic type, scope, targets, requirements, and security namespace.
 */
export function canonicalObligationKey(
  obligation: VerificationObligation,
  namespace = "default",
  policyVersion = FORGE_GREEN_VERIFICATION_POLICY_VERSION,
): string {
  const normPaths = obligation.targetPaths ? [...obligation.targetPaths].map((p) => p.replace(/\\/g, "/")).sort() : [];
  const normPackages = obligation.targetPackages ? [...obligation.targetPackages].sort() : [];
  const envReq = obligation.kind === "REAL_POSTGRESQL" ? ["postgres"]
    : obligation.kind === "REAL_GIT" ? ["git"]
    : obligation.kind === "REAL_CHILD_PROCESS" ? ["child_process"]
    : [];

  const effectiveNamespace = namespace !== "default" ? namespace : (obligation.identity?.namespace ?? namespace);
  const effectivePolicyVersion = policyVersion !== FORGE_GREEN_VERIFICATION_POLICY_VERSION ? policyVersion : (obligation.identity?.policyVersion ?? policyVersion);

  const payload = {
    namespace: effectiveNamespace,
    policyVersion: effectivePolicyVersion,
    kind: obligation.kind,
    scope: obligation.scope,
    targetPaths: normPaths,
    targetPackages: normPackages,
    required: obligation.required,
    requiredEnvironment: envReq,
  };

  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/**
 * Deterministically inspects workspace configuration (package.json workspaces, tsconfig project
 * references, test suites) without trusting prose, comments, or unverified script names.
 */
export function discoverWorkspaceResolutionConfig(
  workspacePath: string,
  options: { environmentAvailability?: { postgres?: boolean; git?: boolean; childProcess?: boolean } } = {},
): WorkspaceResolutionConfig {
  const packages: PackageResolutionMeta[] = [];
  let workspaceTypecheckIncludesAllPackages = false;
  let workspaceBuildIncludesAllPackages = false;
  let workspaceTestIncludesAllPackages = false;

  const rootPkgPath = path.join(workspacePath, "package.json");
  let rootPkg: { workspaces?: string[] | { packages?: string[] }; scripts?: Record<string, string> } = {};

  try {
    if (fs.existsSync(rootPkgPath)) {
      rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, "utf-8"));
    }
  } catch {
    // Graceful empty
  }

  const workspaceGlobs: string[] = Array.isArray(rootPkg.workspaces)
    ? rootPkg.workspaces
    : Array.isArray(rootPkg.workspaces?.packages)
    ? rootPkg.workspaces.packages
    : ["packages/*", "apps/*"];

  for (const glob of workspaceGlobs) {
    const parentDir = glob.replace(/\/\*$/, "").replace(/\\\*$/, "");
    const fullParent = path.join(workspacePath, parentDir);
    if (!fs.existsSync(fullParent)) continue;

    try {
      const entries = fs.readdirSync(fullParent, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const subPkgDir = path.join(fullParent, entry.name);
        const subPkgJsonPath = path.join(subPkgDir, "package.json");
        if (fs.existsSync(subPkgJsonPath)) {
          try {
            const subPkg = JSON.parse(fs.readFileSync(subPkgJsonPath, "utf-8"));
            const relDir = path.relative(workspacePath, subPkgDir).replace(/\\/g, "/");
            const tsconfigPath = fs.existsSync(path.join(subPkgDir, "tsconfig.json"))
              ? path.join(subPkgDir, "tsconfig.json")
              : undefined;

            // Collect test files
            const testFiles: string[] = [];
            for (const subDirName of ["test", "tests", "src"]) {
              const testDir = path.join(subPkgDir, subDirName);
              if (fs.existsSync(testDir)) {
                try {
                  const scanDir = (dir: string) => {
                    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
                      const fullF = path.join(dir, f.name);
                      if (f.isDirectory()) {
                        scanDir(fullF);
                      } else if (/\.(test|spec)\.(ts|tsx|js|jsx|mjs)$/.test(f.name)) {
                        testFiles.push(path.relative(workspacePath, fullF).replace(/\\/g, "/"));
                      }
                    }
                  };
                  scanDir(testDir);
                } catch {
                  // Ignore readdir error
                }
              }
            }

            packages.push({
              name: subPkg.name ?? entry.name,
              path: subPkgDir,
              relativeDir: relDir,
              tsconfigPath,
              testFiles: Object.freeze(testFiles),
              scripts: subPkg.scripts,
            });
          } catch {
            // Ignore corrupted package.json
          }
        }
      }
    } catch {
      // Ignore parent dir error
    }
  }

  // Inspect tsconfig.json for project references
  const rootTsconfigPath = path.join(workspacePath, "tsconfig.json");
  if (fs.existsSync(rootTsconfigPath)) {
    try {
      const rootTsconfig = JSON.parse(fs.readFileSync(rootTsconfigPath, "utf-8"));
      if (Array.isArray(rootTsconfig.references) && rootTsconfig.references.length > 0) {
        const refPaths = rootTsconfig.references.map((r: { path: string }) => r.path?.replace(/\\/g, "/"));
        for (const pkg of packages) {
          const isRef = refPaths.some((ref: string) =>
            ref === pkg.relativeDir ||
            ref === `${pkg.relativeDir}/tsconfig.json` ||
            pkg.relativeDir === ref.replace(/^\.\//, "") ||
            pkg.relativeDir.endsWith(ref.replace(/^\.\//, ""))
          );
          if (!isRef) {
            pkg.isExcludedFromWorkspaceTypecheck = true;
          }
        }
        workspaceTypecheckIncludesAllPackages = true;
      }
    } catch {
      // Ignore
    }
  }

  // Check if build script builds all packages
  if (rootPkg.scripts?.build && (rootPkg.scripts.build.includes("--workspaces") || rootPkg.scripts.build.includes("tsc -b"))) {
    workspaceBuildIncludesAllPackages = true;
  }

  // Check if test script runs workspace vitest / jest
  if (rootPkg.scripts?.test && (rootPkg.scripts.test.includes("vitest") || rootPkg.scripts.test.includes("jest"))) {
    workspaceTestIncludesAllPackages = true;
  }

  const envAvail = {
    postgres: options.environmentAvailability?.postgres ?? Boolean(process.env.CODEFORGE_TEST_POSTGRES_URL || process.env.DATABASE_URL),
    git: options.environmentAvailability?.git ?? true,
    childProcess: options.environmentAvailability?.childProcess ?? true,
  };

  const configContent = JSON.stringify({
    packages: packages.map((p) => ({ name: p.name, rel: p.relativeDir, tests: p.testFiles })),
    workspaceTypecheckIncludesAllPackages,
    workspaceBuildIncludesAllPackages,
    workspaceTestIncludesAllPackages,
    envAvail,
  });
  const configHash = crypto.createHash("sha256").update(configContent).digest("hex");

  return {
    workspacePath,
    packages: Object.freeze(packages),
    workspaceTypecheckIncludesAllPackages,
    workspaceBuildIncludesAllPackages,
    workspaceTestIncludesAllPackages,
    environmentAvailability: envAvail,
    configHash,
  };
}

/**
 * Core FG-6 Evidence Resolution Engine.
 * Resolves hard verification obligations into the minimum valid evidence plan
 * through deterministic deduplication, structured project-configuration subsumption,
 * and valid evidence reuse without weakening any obligation.
 */
export async function resolveVerificationObligations(
  request: EvidenceResolutionRequest,
): Promise<EvidenceResolutionResult> {
  const policyVersion = request.policyVersion ?? FORGE_GREEN_VERIFICATION_POLICY_VERSION;
  const resolverVersion = request.resolverVersion ?? FORGE_GREEN_EVIDENCE_RESOLVER_VERSION;
  const namespace = request.namespace ?? "default";
  const resolutionId = crypto.randomUUID();
  const inputStateHash = request.currentInputStateHash ?? "";

  const config = request.workspaceConfig ?? discoverWorkspaceResolutionConfig(request.workspacePath, {
    environmentAvailability: request.environmentAvailability,
  });

  const envAvail = {
    postgres: request.environmentAvailability?.postgres ?? config.environmentAvailability?.postgres ?? false,
    git: request.environmentAvailability?.git ?? config.environmentAvailability?.git ?? true,
    childProcess: request.environmentAvailability?.childProcess ?? config.environmentAvailability?.childProcess ?? true,
  };
  const cacheIdentity = resolutionCacheIdentity({
    namespace,
    policyVersion,
    resolverVersion,
    obligations: request.obligations,
    configHash: config.configHash,
    inputStateHash,
    executionRevision: request.executionRevision,
    environmentAvailability: envAvail,
  });

  // Check Canonical Cache if available
  let cacheKey: string | undefined;
  if (request.cache) {
    try {
      cacheKey = cacheIdentity;

      const cached = await request.cache.get(namespace, cacheKey);
      if (cached?.value) {
        const parsed: unknown = JSON.parse(cached.value);
        if (isCurrentCachedReceipt(parsed, {
          policyVersion,
          resolverVersion,
          cacheIdentity,
          inputStateHash,
          executionRevision: request.executionRevision,
          inputObligationCount: request.obligations.length,
        })) {
          request.ledger?.record({
            mechanism: "evidence_resolution",
            measurement: "measured",
            quantity: 1,
            unit: "count",
            reason: "cache_hit",
          });
          return {
            outcome: parsed.outcome,
            producers: parsed.producers,
            receipt: parsed,
            subsumptions: parsed.subsumptions,
            deduplicatedObligations: parsed.deduplicatedObligations,
            alreadySatisfiedObligations: parsed.deduplicatedObligations.filter((o) =>
              parsed.subsumptions.some((s) => s.subsumedObligationId === o.id && s.reasonCode === "ALREADY_VALID_EVIDENCE")
            ).map((o) => o.id),
            unresolvedObligations: parsed.unresolvedObligationIds,
            dispatchesAvoided: parsed.dispatchesAvoidedCount,
            isResolved: parsed.outcome === "RESOLVED",
            rationale: "Evidence resolution restored from canonical cache.",
          };
        }
      }
    } catch {
      // Cache lookup failed, continue with full computation
    }
    request.ledger?.record({
      mechanism: "evidence_resolution",
      measurement: "measured",
      quantity: 1,
      unit: "count",
      reason: "cache_miss",
    });
  }

  // 1. Record input count
  const inputObligations = request.obligations;
  if (request.ledger && inputObligations.length > 0) {
    request.ledger.record({
      mechanism: "evidence_resolution",
      measurement: "measured",
      quantity: inputObligations.length,
      unit: "count",
      reason: "obligations_received",
    });
  }

  // If no obligations (V0), return immediate RESOLVED
  if (inputObligations.length === 0) {
    const emptyReceipt: EvidenceResolutionReceipt = Object.freeze({
      kind: "evidence_resolution_receipt",
      receiptId: crypto.randomUUID(),
      resolutionId,
      policyReceiptId: request.policyReceiptId,
      policyVersion,
      resolverVersion,
      cacheIdentity,
      outcome: "RESOLVED",
      revision: request.executionRevision,
      inputStateHash,
      inputObligationCount: 0,
      deduplicatedObligationCount: 0,
      alreadySatisfiedObligationCount: 0,
      subsumedObligationCount: 0,
      scheduledProducerCount: 0,
      dispatchesAvoidedCount: 0,
      inputObligations: [],
      deduplicatedObligations: [],
      subsumptions: [],
      producers: [],
      unresolvedObligationIds: [],
      reasonCodes: ["V0_NO_OBLIGATIONS"],
      createdAt: new Date().toISOString(),
    });

    return {
      outcome: "RESOLVED",
      producers: [],
      receipt: emptyReceipt,
      subsumptions: [],
      deduplicatedObligations: [],
      alreadySatisfiedObligations: [],
      unresolvedObligations: [],
      dispatchesAvoided: 0,
      isResolved: true,
      rationale: "V0 documentation-only change requires no verification obligations.",
    };
  }

  // 2. Exact Deduplication while preserving ALL reason codes and source origins
  const deduplicatedMap = new Map<string, DeduplicatedObligation>();
  const exactDuplicateSubsumptions: SubsumptionRecord[] = [];

  for (const obligation of inputObligations) {
    const key = canonicalObligationKey(obligation, namespace, policyVersion);
    const existing = deduplicatedMap.get(key);

    if (!existing) {
      deduplicatedMap.set(key, {
        id: obligation.id,
        canonicalKey: key,
        kind: obligation.kind,
        scope: obligation.scope,
        targetPaths: obligation.targetPaths ? [...obligation.targetPaths] : undefined,
        targetPackages: obligation.targetPackages ? [...obligation.targetPackages] : undefined,
        required: obligation.required,
        reasonCodes: [...obligation.reasonCodes],
        sourceObligationIds: [obligation.id],
        commandHint: obligation.commandHint,
        requiredEnvironment: obligation.kind === "REAL_POSTGRESQL" ? ["postgres"]
          : obligation.kind === "REAL_GIT" ? ["git"]
          : obligation.kind === "REAL_CHILD_PROCESS" ? ["child_process"]
          : undefined,
      });
    } else {
      // Merge reason codes and source IDs
      const combinedReasons = Array.from(new Set([...existing.reasonCodes, ...obligation.reasonCodes]));
      const combinedSources = [...existing.sourceObligationIds, obligation.id];
      deduplicatedMap.set(key, {
        ...existing,
        required: existing.required || obligation.required,
        reasonCodes: combinedReasons,
        sourceObligationIds: combinedSources,
      });

      exactDuplicateSubsumptions.push({
        subsumingProducerId: existing.id,
        subsumedObligationId: obligation.id,
        reasonCode: "EXACT_DUPLICATE",
        basis: `Exact duplicate obligation canonicalized to ${existing.id}`,
        targetScope: obligation.scope,
      });
    }
  }

  const deduplicatedObligations = Array.from(deduplicatedMap.values());
  const exactDuplicatesRemoved = inputObligations.length - deduplicatedObligations.length;

  if (request.ledger && exactDuplicatesRemoved > 0) {
    request.ledger.record({
      mechanism: "evidence_resolution",
      measurement: "measured",
      quantity: exactDuplicatesRemoved,
      unit: "count",
      reason: "duplicates_removed",
    });
  }

  // 3. Existing Valid Evidence Reuse
  const existingEvidence = request.existingEvidence ?? [];
  const alreadySatisfiedObligations: string[] = [];
  const reusedProducers: PlannedEvidenceProducer[] = [];
  const allSubsumptions: SubsumptionRecord[] = [...exactDuplicateSubsumptions];

  const unsatisfiedDeduplicated: DeduplicatedObligation[] = [];

  for (const dedup of deduplicatedObligations) {
    // Look for exact valid matching evidence
    const matching = existingEvidence.filter((ev) => {
      if (ev.status !== "passed") return false;
      if (ev.exitCode !== undefined && ev.exitCode !== 0) return false;

      // An evidence record with a missing identity component is not a weaker form of current
      // evidence. It is unknown evidence and must cause fresh execution rather than reuse.
      if (typeof ev.workspacePath !== "string" || path.resolve(ev.workspacePath) !== path.resolve(request.workspacePath)) return false;

      // Check revision freshness
      if (request.executionRevision !== undefined && ev.executionRevision !== request.executionRevision) {
        return false;
      }

      // Check input state hash
      if (inputStateHash && ev.inputStateHash !== inputStateHash) {
        return false;
      }

      // Check policy version
      if (ev.policyVersion !== policyVersion) {
        return false;
      }

      // Scope is part of the evidence claim. Broader coverage may only subsume a narrower
      // obligation through the separately explicit, configuration-backed planner below.
      if (ev.scope !== dedup.scope) return false;

      // Match kind and scope
      const kindMatches =
        ev.kind === dedup.kind ||
        ev.category === dedup.kind.toLowerCase() ||
        (dedup.kind === "TYPECHECK" && (ev.verifierId?.includes("typecheck") || ev.category === "typecheck")) ||
        (dedup.kind === "BUILD" && (ev.verifierId?.includes("build") || ev.category === "build")) ||
        (dedup.kind === "UNIT_TEST" && (ev.verifierId?.includes("test") || ev.category === "unit-test")) ||
        (dedup.kind === "TARGETED_TEST" && (ev.verifierId?.includes("test") || ev.category === "unit-test")) ||
        (dedup.kind === "PACKAGE_TEST" && (ev.verifierId?.includes("test") || ev.category === "unit-test" || ev.category === "integration-test")) ||
        (dedup.kind === "REAL_POSTGRESQL" && (ev.verifierId?.includes("postgres") || ev.kind === "REAL_POSTGRESQL")) ||
        (dedup.kind === "REAL_GIT" && (ev.verifierId?.includes("git") || ev.kind === "REAL_GIT")) ||
        (dedup.kind === "REAL_CHILD_PROCESS" && (ev.verifierId?.includes("child-process") || ev.kind === "REAL_CHILD_PROCESS"));

      if (!kindMatches) return false;

      // Match targets if targeted
      if (dedup.targetPaths && dedup.targetPaths.length > 0) {
        if (!ev.targetPaths) return false;
        const evPaths = new Set(ev.targetPaths.map((p: string) => p.replace(/\\/g, "/")));
        const allIncluded = dedup.targetPaths.every((p) => evPaths.has(p.replace(/\\/g, "/")));
        if (!allIncluded) return false;
      }

      return true;
    });

    if (matching.length > 0) {
      const validEv = matching[0]!;
      alreadySatisfiedObligations.push(dedup.id);
      reusedProducers.push({
        producerId: `reused-${validEv.evidenceId}`,
        kind: dedup.kind,
        scope: dedup.scope,
        command: validEv.command ?? dedup.commandHint ?? "reused-evidence",
        targetPackage: dedup.targetPackages?.[0],
        targetPaths: dedup.targetPaths,
        satisfiedObligationIds: dedup.sourceObligationIds,
        subsumptions: [
          {
            subsumingProducerId: `reused-${validEv.evidenceId}`,
            subsumedObligationId: dedup.id,
            reasonCode: "ALREADY_VALID_EVIDENCE",
            basis: `Current valid evidence ${validEv.evidenceId} matches input state hash and revision.`,
            targetScope: dedup.scope,
          },
        ],
        costEstimate: 0,
        isReusedEvidence: true,
        reusedEvidenceId: validEv.evidenceId,
      });

      allSubsumptions.push({
        subsumingProducerId: `reused-${validEv.evidenceId}`,
        subsumedObligationId: dedup.id,
        reasonCode: "ALREADY_VALID_EVIDENCE",
        basis: `Current valid evidence ${validEv.evidenceId} matches input state hash and revision.`,
        targetScope: dedup.scope,
      });
    } else {
      unsatisfiedDeduplicated.push(dedup);
    }
  }

  if (request.ledger && alreadySatisfiedObligations.length > 0) {
    request.ledger.record({
      mechanism: "evidence_resolution",
      measurement: "measured",
      quantity: alreadySatisfiedObligations.length,
      unit: "count",
      reason: "evidence_reused",
    });
  }

  // 4. Minimum Valid Verification Plan Resolution & Subsumption
  const scheduledProducers: PlannedEvidenceProducer[] = [];
  const unresolvedObligationIds: string[] = [];
  const subsumedObligations = new Set<string>();

  // Check for workspace-level subsumptions
  const hasWorkspaceTypecheck = unsatisfiedDeduplicated.some((o) => o.kind === "TYPECHECK" && o.scope === "workspace");
  const packageTypechecks = unsatisfiedDeduplicated.filter((o) => o.kind === "TYPECHECK" && (o.scope === "package" || o.scope === "target"));

  // Check if workspace typecheck can subsume package typechecks
  let workspaceTypecheckProducer: PlannedEvidenceProducer | undefined;

  if (hasWorkspaceTypecheck || (packageTypechecks.length >= 2 && config.workspaceTypecheckIncludesAllPackages)) {
    if (config.workspaceTypecheckIncludesAllPackages) {
      const satisfiedObligationsForTypecheck: string[] = [];
      const subsumptionRecordsForTypecheck: SubsumptionRecord[] = [];

      const wsTypecheckObligation = unsatisfiedDeduplicated.find((o) => o.kind === "TYPECHECK" && o.scope === "workspace");
      if (wsTypecheckObligation) {
        satisfiedObligationsForTypecheck.push(...wsTypecheckObligation.sourceObligationIds);
      }

      for (const pkgTc of packageTypechecks) {
        // Check if package is not excluded
        const pkgMeta = config.packages.find((p) => p.name === pkgTc.targetPackages?.[0] || pkgTc.targetPaths?.some((tp) => tp.startsWith(p.relativeDir)));
        if (!pkgMeta?.isExcludedFromWorkspaceTypecheck) {
          satisfiedObligationsForTypecheck.push(...pkgTc.sourceObligationIds);
          subsumedObligations.add(pkgTc.id);
          subsumptionRecordsForTypecheck.push({
            subsumingProducerId: "prod-workspace-typecheck",
            subsumedObligationId: pkgTc.id,
            reasonCode: "WORKSPACE_TYPECHECK_INCLUDES_PACKAGE",
            basis: `Workspace typecheck includes all referenced tsconfig packages including ${pkgTc.targetPackages?.[0] ?? "target"}.`,
            targetScope: pkgTc.scope,
          });
        }
      }

      workspaceTypecheckProducer = {
        producerId: "prod-workspace-typecheck",
        kind: "TYPECHECK",
        scope: "workspace",
        command: "npm run typecheck",
        satisfiedObligationIds: satisfiedObligationsForTypecheck,
        subsumptions: subsumptionRecordsForTypecheck,
        costEstimate: 5,
      };

      scheduledProducers.push(workspaceTypecheckProducer);
      allSubsumptions.push(...subsumptionRecordsForTypecheck);
    }
  }

  // Handle remaining unsatisfied obligations
  for (const obligation of unsatisfiedDeduplicated) {
    if (subsumedObligations.has(obligation.id)) continue;
    if (workspaceTypecheckProducer && obligation.kind === "TYPECHECK" && obligation.scope === "workspace") continue;

    // Environment-Sensitive Gates
    if (obligation.kind === "REAL_POSTGRESQL") {
      if (!envAvail.postgres) {
        unresolvedObligationIds.push(obligation.id);
        continue;
      }
      scheduledProducers.push({
        producerId: `prod-postgres-${obligation.id}`,
        kind: "REAL_POSTGRESQL",
        scope: obligation.scope,
        command: obligation.commandHint ?? "npx vitest run tests/cloud-postgres-adversarial.test.ts",
        targetPackage: obligation.targetPackages?.[0],
        targetPaths: obligation.targetPaths,
        satisfiedObligationIds: obligation.sourceObligationIds,
        subsumptions: [],
        costEstimate: 10,
        environmentRequirements: ["postgres"],
      });
      continue;
    }

    if (obligation.kind === "REAL_GIT") {
      if (!envAvail.git) {
        unresolvedObligationIds.push(obligation.id);
        continue;
      }
      scheduledProducers.push({
        producerId: `prod-git-${obligation.id}`,
        kind: "REAL_GIT",
        scope: obligation.scope,
        command: obligation.commandHint ?? "npx vitest run packages/git/test/git-service.test.ts",
        targetPackage: obligation.targetPackages?.[0],
        targetPaths: obligation.targetPaths,
        satisfiedObligationIds: obligation.sourceObligationIds,
        subsumptions: [],
        costEstimate: 4,
        environmentRequirements: ["git"],
      });
      continue;
    }

    if (obligation.kind === "REAL_CHILD_PROCESS") {
      if (!envAvail.childProcess) {
        unresolvedObligationIds.push(obligation.id);
        continue;
      }
      scheduledProducers.push({
        producerId: `prod-child-process-${obligation.id}`,
        kind: "REAL_CHILD_PROCESS",
        scope: obligation.scope,
        command: obligation.commandHint ?? "npx vitest run packages/workflow/test/child-process.test.ts",
        targetPackage: obligation.targetPackages?.[0],
        targetPaths: obligation.targetPaths,
        satisfiedObligationIds: obligation.sourceObligationIds,
        subsumptions: [],
        costEstimate: 3,
        environmentRequirements: ["child_process"],
      });
      continue;
    }

    // Package-test suite subsumption over targeted tests
    if (obligation.kind === "PACKAGE_TEST" || obligation.scope === "package") {
      const pkgName = obligation.targetPackages?.[0];
      const pkgMeta = config.packages.find((p) => p.name === pkgName || obligation.targetPaths?.some((tp) => tp.startsWith(p.relativeDir)));

      // Find targeted tests belonging to this package
      const subsumedTargetedTests = unsatisfiedDeduplicated.filter((o) => {
        if (o.id === obligation.id || subsumedObligations.has(o.id)) return false;
        if (o.kind !== "TARGETED_TEST" && o.kind !== "UNIT_TEST") return false;
        if (!o.targetPaths || o.targetPaths.length === 0) return false;
        if (!pkgMeta) return false;
        return o.targetPaths.every((tp) => {
          const norm = tp.replace(/\\/g, "/");
          return norm.startsWith(pkgMeta.relativeDir) && (pkgMeta.testFiles?.includes(norm) ?? true);
        });
      });

      const satisfiedForPkgTest = [...obligation.sourceObligationIds];
      const pkgSubsumptionRecords: SubsumptionRecord[] = [];

      for (const tgt of subsumedTargetedTests) {
        satisfiedForPkgTest.push(...tgt.sourceObligationIds);
        subsumedObligations.add(tgt.id);
        pkgSubsumptionRecords.push({
          subsumingProducerId: `prod-package-test-${obligation.id}`,
          subsumedObligationId: tgt.id,
          reasonCode: "PACKAGE_TEST_INCLUDES_TARGETED",
          basis: `Package test suite for ${pkgName ?? pkgMeta?.name ?? "package"} includes targeted test ${tgt.targetPaths?.join(", ")}.`,
          targetScope: tgt.scope,
        });
      }

      scheduledProducers.push({
        producerId: `prod-package-test-${obligation.id}`,
        kind: obligation.kind,
        scope: obligation.scope,
        command: obligation.commandHint ?? (pkgMeta ? `npm test --workspace=${pkgMeta.name}` : `npm test`),
        targetPackage: pkgName ?? pkgMeta?.name,
        targetPaths: obligation.targetPaths,
        satisfiedObligationIds: satisfiedForPkgTest,
        subsumptions: pkgSubsumptionRecords,
        costEstimate: 3,
      });

      allSubsumptions.push(...pkgSubsumptionRecords);
      continue;
    }

    // Fallback direct producer for any other obligation
    scheduledProducers.push({
      producerId: `prod-${obligation.kind.toLowerCase()}-${obligation.id}`,
      kind: obligation.kind,
      scope: obligation.scope,
      command: obligation.commandHint ?? (obligation.targetPaths ? `npx vitest run ${obligation.targetPaths.join(" ")}` : "npm test"),
      targetPackage: obligation.targetPackages?.[0],
      targetPaths: obligation.targetPaths,
      satisfiedObligationIds: obligation.sourceObligationIds,
      subsumptions: [],
      costEstimate: obligation.scope === "target" ? 1 : obligation.scope === "workspace" ? 6 : 2,
    });
  }

  // 5. Outcome Resolution
  let outcome: EvidenceResolutionOutcome = "RESOLVED";
  if (unresolvedObligationIds.length > 0) {
    const hasMandatoryUnresolved = deduplicatedObligations.some(
      (o) => unresolvedObligationIds.includes(o.id) && o.required
    );
    outcome = hasMandatoryUnresolved ? "BLOCKED" : "PARTIALLY_RESOLVED";
  }

  const allProducers = [...reusedProducers, ...scheduledProducers];
  const subsumedCount = allSubsumptions.filter((s) => s.reasonCode !== "EXACT_DUPLICATE" && s.reasonCode !== "ALREADY_VALID_EVIDENCE").length;
  const dispatchesAvoided = Math.max(
    0,
    inputObligations.length - scheduledProducers.length - alreadySatisfiedObligations.length,
  );

  // 6. Record Ledger Metrics
  if (request.ledger) {
    if (subsumedCount > 0) {
      request.ledger.record({
        mechanism: "evidence_resolution",
        measurement: "measured",
        quantity: subsumedCount,
        unit: "count",
        reason: "obligations_subsumed",
      });
    }
    if (scheduledProducers.length > 0) {
      request.ledger.record({
        mechanism: "evidence_resolution",
        measurement: "measured",
        quantity: scheduledProducers.length,
        unit: "count",
        reason: "producers_scheduled",
      });
    }
    if (dispatchesAvoided > 0) {
      request.ledger.record({
        mechanism: "evidence_resolution",
        measurement: "measured",
        quantity: dispatchesAvoided,
        unit: "count",
        reason: "dispatches_avoided",
      });
    }
  }

  // 7. Durable Receipt
  const receipt: EvidenceResolutionReceipt = Object.freeze({
    kind: "evidence_resolution_receipt",
    receiptId: crypto.randomUUID(),
    resolutionId,
    policyReceiptId: request.policyReceiptId,
    policyVersion,
    resolverVersion,
    cacheIdentity,
    outcome,
    revision: request.executionRevision,
    inputStateHash,
    inputObligationCount: inputObligations.length,
    deduplicatedObligationCount: deduplicatedObligations.length,
    alreadySatisfiedObligationCount: alreadySatisfiedObligations.length,
    subsumedObligationCount: subsumedCount,
    scheduledProducerCount: scheduledProducers.length,
    dispatchesAvoidedCount: dispatchesAvoided,
    inputObligations: Object.freeze(inputObligations),
    deduplicatedObligations: Object.freeze(deduplicatedObligations),
    subsumptions: Object.freeze(allSubsumptions),
    producers: Object.freeze(allProducers),
    unresolvedObligationIds: Object.freeze(unresolvedObligationIds),
    reasonCodes: Object.freeze(
      outcome === "RESOLVED"
        ? ["RESOLUTION_COMPLETE", "MINIMUM_VALID_PLAN_PRODUCED"]
        : outcome === "BLOCKED"
        ? ["ENVIRONMENT_UNAVAILABLE", "OBLIGATION_UNRESOLVED"]
        : ["PARTIAL_RESOLUTION"]
    ),
    createdAt: new Date().toISOString(),
  });

  // Put in canonical cache if available
  if (request.cache && cacheKey && outcome === "RESOLVED") {
    try {
      await request.cache.put(namespace, cacheKey, JSON.stringify(receipt));
    } catch {
      // Cache put best-effort
    }
  }

  return {
    outcome,
    producers: allProducers,
    receipt,
    subsumptions: allSubsumptions,
    deduplicatedObligations,
    alreadySatisfiedObligations,
    unresolvedObligations: unresolvedObligationIds,
    dispatchesAvoided,
    isResolved: outcome === "RESOLVED",
    rationale:
      outcome === "RESOLVED"
        ? `Successfully resolved ${inputObligations.length} obligations into ${scheduledProducers.length} scheduled executions (${dispatchesAvoided} redundant dispatches avoided).`
        : `Resolution blocked: ${unresolvedObligationIds.length} mandatory obligations lack valid executable paths.`,
  };
}
