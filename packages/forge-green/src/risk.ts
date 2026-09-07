import crypto from "node:crypto";
import { canonicalCacheKey } from "./canonical-cache.js";
import type { EfficiencyLedgerEvent } from "./ledger.js";
import type {
  AnalysisCompletenessLevel,
  RepositoryFile,
  RepositoryIntelligence,
} from "@codeforge/repo-intelligence";

export const FORGE_GREEN_RISK_ANALYSIS_VERSION = "fg4-risk-1";
export const FORGE_GREEN_RISK_POLICY_VERSION = "fg4-risk-policy-1";

export type AnalyzabilityClass = "HIGH" | "MODERATE" | "LOW" | "UNKNOWN";
export type TaskRiskClass = "LOCAL" | "LIMITED" | "CROSS_MODULE" | "CROSS_PACKAGE" | "SYSTEMIC" | "UNKNOWN";
export type CapabilityRequirement = "FAST_WORKER" | "CODER" | "REASONER" | "PLANNER";
export type ContextBreadthRecommendation = "L1" | "L2" | "L3" | "L5" | "L6";
export type ChangeKind =
  | "implementation"
  | "signature"
  | "public_api"
  | "type"
  | "config"
  | "dependency"
  | "migration"
  | "rename"
  | "delete"
  | "new_api"
  | "test"
  | "documentation"
  | "generated";

export type RiskReasonCode =
  | "PUBLIC_INTERFACE_CHANGED"
  | "MULTIPLE_DIRECT_CALLERS"
  | "CROSS_PACKAGE_DEPENDENCY"
  | "DYNAMIC_DISPATCH"
  | "UNRESOLVED_DEPENDENCY"
  | "GENERATED_CODE_BOUNDARY"
  | "CONFIGURATION_CHANGE"
  | "SHARED_TYPE_CHANGE"
  | "CENTRAL_ENTRYPOINT"
  | "TEST_MAPPING_PARTIAL"
  | "UNKNOWN_LANGUAGE"
  | "PARSE_FAILURE"
  | "AMBIGUOUS_SYMBOL"
  | "TRAVERSAL_TRUNCATED"
  | "DATABASE_SCHEMA_CHANGE"
  | "DEPENDENCY_VERSION_CHANGE"
  | "DELETED_OR_RENAMED_TARGET"
  | "ANALYSIS_UNAVAILABLE"
  | "REPOSITORY_NOT_READY"
  | "HEURISTIC_RELATIONSHIP"
  | "HIGH_CONFIDENCE_STATIC_GRAPH"
  | "TEST_CANDIDATES_ONLY";

export interface RiskAnalysisCache {
  get(namespace: string, key: string): Promise<{ value: string } | undefined>;
  put(namespace: string, key: string, value: string): Promise<boolean | void>;
}

export interface StructuralRiskRequest {
  intelligence: RepositoryIntelligence;
  changedPaths: readonly string[];
  task?: string;
  changeKind?: ChangeKind;
  changeKinds?: Readonly<Record<string, ChangeKind>>;
  maxDepth?: number;
  limit?: number;
  cache?: RiskAnalysisCache;
  /** Used only to report a capability mismatch; it never permits replacement. */
  exactPinnedRole?: CapabilityRequirement;
  ledger?: { record(event: EfficiencyLedgerEvent): void };
}

export interface StructuralRiskIdentity {
  namespace: string;
  workspaceId: string;
  repositoryGeneration: number;
  graphGeneration: number;
  changedFileHashes: string[];
  changeIdentity: string;
  graphIdentity: string;
  analysisVersion: string;
  policyVersion: string;
}

export interface StructuralImpactEvidence {
  path: string;
  relation: "changed" | "dependent" | "dependency" | "test" | "dynamic" | "unresolved";
  depth: number;
  provenance: string;
  reasonCode?: RiskReasonCode;
}

export interface RiskReceipt {
  kind: "structural_risk_receipt";
  receiptId: string;
  identity: StructuralRiskIdentity;
  risk: TaskRiskClass;
  analyzability: AnalyzabilityClass;
  knownAffectedFiles: number;
  unresolvedRelationships: number;
  dynamicConstructs: number;
  reasonCodes: RiskReasonCode[];
  recommendedContextLevel: ContextBreadthRecommendation;
  recommendedCapability: CapabilityRequirement;
  cache: "hit" | "miss" | "bypass" | "fallback";
}

export interface StructuralRiskAnalysis {
  kind: "structural_risk_analysis";
  changedTargets: string[];
  directDependents: string[];
  transitiveDependents: string[];
  callers: string[];
  callees: string[];
  candidateTests: string[];
  packages: string[];
  publicInterfaces: string[];
  unresolvedRelationships: StructuralImpactEvidence[];
  dynamicConstructs: Array<{ path: string; kind: string; line: number }>;
  evidence: StructuralImpactEvidence[];
  analysisCompleteness: AnalysisCompletenessLevel;
  analyzability: AnalyzabilityClass;
  risk: TaskRiskClass;
  reasonCodes: RiskReasonCode[];
  recommendedContextLevel: ContextBreadthRecommendation;
  recommendedCapability: CapabilityRequirement;
  capabilityMismatch?: { pinned: CapabilityRequirement; required: CapabilityRequirement };
  parallelism: { safe: boolean; reasonCodes: RiskReasonCode[] };
  identity: StructuralRiskIdentity;
  receipt: RiskReceipt;
}

const CAPABILITY_ORDER: Record<CapabilityRequirement, number> = {
  FAST_WORKER: 0,
  CODER: 1,
  REASONER: 2,
  PLANNER: 3,
};

function unique(values: Iterable<string>): string[] {
  return [...new Set([...values].filter(Boolean))].sort();
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function fingerprint(value: unknown): string {
  return crypto.createHash("sha256").update(stableJson(value)).digest("hex");
}

function packageFor(file: string): string {
  const parts = file.replaceAll("\\", "/").split("/");
  return parts.length > 2 && (parts[0] === "packages" || parts[0] === "apps") ? `${parts[0]}/${parts[1]}` : "repository";
}

function isConfig(file: string): boolean {
  return /(?:^|\/)(?:package\.json|tsconfig(?:\.[^/]+)?\.json|Dockerfile|[^/]+\.(?:config\.|ya?ml$|toml$|json$|env(?:\.[^/]+)?$))/i.test(file);
}

function isMigration(file: string): boolean {
  return /(?:^|\/)(?:migrations?|schema)(?:\/|\.|$)|\.(?:sql|sqlite)$/i.test(file);
}

function isTest(file: string): boolean {
  return /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|\.(?:test|spec)\.[^.]+$/i.test(file);
}

function isDocumentation(file: string): boolean {
  return /(?:^|\/)(?:docs?|readme|changelog)(?:\/|\.|$)/i.test(file);
}

function inferChangeKind(path: string, request: StructuralRiskRequest, file?: RepositoryFile): ChangeKind {
  const explicit = request.changeKinds?.[path] ?? request.changeKind;
  if (explicit) return explicit;
  if (isMigration(path)) return "migration";
  if (isConfig(path)) return "config";
  if (isTest(path)) return "test";
  if (isDocumentation(path)) return "documentation";
  if (file?.generated) return "generated";
  return "implementation";
}

function addReason(reasons: Set<RiskReasonCode>, reason: RiskReasonCode): void {
  reasons.add(reason);
}

function capabilityFor(risk: TaskRiskClass, analyzability: AnalyzabilityClass): CapabilityRequirement {
  if (risk === "SYSTEMIC" || risk === "UNKNOWN") return "PLANNER";
  if (risk === "CROSS_PACKAGE") return "REASONER";
  if (risk === "CROSS_MODULE" || analyzability === "LOW") return "REASONER";
  if (risk === "LIMITED") return "CODER";
  return "FAST_WORKER";
}

function contextFor(risk: TaskRiskClass): ContextBreadthRecommendation {
  switch (risk) {
    case "LOCAL": return "L1";
    case "LIMITED": return "L2";
    case "CROSS_MODULE": return "L3";
    case "CROSS_PACKAGE": return "L5";
    case "SYSTEMIC":
    case "UNKNOWN": return "L6";
  }
}

function normalizeCompleteness(level: AnalysisCompletenessLevel | undefined): AnalysisCompletenessLevel {
  return level === "COMPLETE" || level === "PARTIAL" || level === "UNKNOWN" ? level : "UNKNOWN";
}

function identityFor(status: ReturnType<RepositoryIntelligence["status"]>, paths: string[], hashes: string[], kinds: Record<string, ChangeKind>): StructuralRiskIdentity {
  const namespace = status.repositoryNamespace ?? status.workspaceId;
  const graphIdentity = fingerprint({ namespace, graphGeneration: status.graphGeneration, paths, maxVersion: FORGE_GREEN_RISK_ANALYSIS_VERSION });
  const changeIdentity = fingerprint({
    namespace,
    workspaceId: status.workspaceId,
    generation: status.generation,
    graphGeneration: status.graphGeneration,
    paths,
    hashes,
    kinds,
    analysisVersion: FORGE_GREEN_RISK_ANALYSIS_VERSION,
    policyVersion: FORGE_GREEN_RISK_POLICY_VERSION,
  });
  return {
    namespace,
    workspaceId: status.workspaceId,
    repositoryGeneration: status.generation,
    graphGeneration: status.graphGeneration,
    changedFileHashes: hashes,
    changeIdentity,
    graphIdentity,
    analysisVersion: FORGE_GREEN_RISK_ANALYSIS_VERSION,
    policyVersion: FORGE_GREEN_RISK_POLICY_VERSION,
  };
}

function withReceipt(result: Omit<StructuralRiskAnalysis, "receipt">, cache: RiskReceipt["cache"]): StructuralRiskAnalysis {
  const receiptBase = {
    kind: "structural_risk_receipt" as const,
    receiptId: fingerprint({ identity: result.identity, risk: result.risk, analyzability: result.analyzability }).slice(0, 24),
    identity: result.identity,
    risk: result.risk,
    analyzability: result.analyzability,
    knownAffectedFiles: new Set([...result.changedTargets, ...result.directDependents, ...result.transitiveDependents]).size,
    unresolvedRelationships: result.unresolvedRelationships.length,
    dynamicConstructs: result.dynamicConstructs.length,
    reasonCodes: result.reasonCodes,
    recommendedContextLevel: result.recommendedContextLevel,
    recommendedCapability: result.recommendedCapability,
    cache,
  };
  return { ...result, receipt: receiptBase };
}

function fallback(identity: StructuralRiskIdentity, reason: RiskReasonCode): StructuralRiskAnalysis {
  const result: Omit<StructuralRiskAnalysis, "receipt"> = {
    kind: "structural_risk_analysis",
    changedTargets: [],
    directDependents: [],
    transitiveDependents: [],
    callers: [],
    callees: [],
    candidateTests: [],
    packages: [],
    publicInterfaces: [],
    unresolvedRelationships: [],
    dynamicConstructs: [],
    evidence: [],
    analysisCompleteness: "UNKNOWN",
    analyzability: "UNKNOWN",
    risk: "UNKNOWN",
    reasonCodes: [reason],
    recommendedContextLevel: "L6",
    recommendedCapability: "PLANNER",
    parallelism: { safe: false, reasonCodes: [reason] },
    identity,
  };
  return withReceipt(result, "fallback");
}

export async function analyzeStructuralRisk(request: StructuralRiskRequest): Promise<StructuralRiskAnalysis> {
  const paths = unique(request.changedPaths);
  const status = request.intelligence.status();
  const files = await Promise.all(paths.map(async (path) => await request.intelligence.getFile(path).catch(() => undefined)));
  const hashes = paths.map((path, index) => files[index]?.hash ?? `missing:${path}`);
  const kinds = Object.fromEntries(paths.map((path, index) => [path, inferChangeKind(path, request, files[index])]));
  const identity = identityFor(status, paths, hashes, kinds);
  const cacheKey = canonicalCacheKey({
    namespace: identity.namespace,
    analysis: "structural_risk",
    parameters: { paths, kinds, maxDepth: request.maxDepth ?? 3, limit: request.limit ?? 100 },
    scopeDigest: `${status.indexVersion}:${status.parserVersion}:graphgen-${status.graphGeneration}`,
    parserVersion: status.parserVersion,
    policyVersion: FORGE_GREEN_RISK_POLICY_VERSION,
    repositoryGeneration: status.graphGeneration,
  });

  if (request.cache) {
    const cached = await request.cache.get(identity.namespace, cacheKey).catch(() => undefined);
    if (cached) {
      try {
        const parsed = JSON.parse(cached.value) as StructuralRiskAnalysis;
        if (parsed.kind === "structural_risk_analysis" && parsed.identity.graphIdentity === identity.graphIdentity) {
          request.ledger?.record({ mechanism: "risk_analysis", measurement: "measured", quantity: 1, unit: "count", reason: "cache_hit" });
          const refreshed = withReceipt({ ...parsed, identity }, "hit");
          if (CAPABILITY_ORDER[refreshed.recommendedCapability] > CAPABILITY_ORDER.FAST_WORKER) request.ledger?.record({ mechanism: "risk_analysis", measurement: "measured", quantity: 1, unit: "count", reason: "role_escalation" });
          if (refreshed.recommendedContextLevel !== "L1") request.ledger?.record({ mechanism: "risk_analysis", measurement: "measured", quantity: 1, unit: "count", reason: "context_expansion" });
          return refreshed;
        }
      } catch {
        // A corrupt advisory entry is a miss; recomputation is safer than reuse.
      }
    }
  }

  if (paths.length === 0 || !["READY", "DEGRADED"].includes(status.state)) {
    return fallback(identity, paths.length === 0 ? "ANALYSIS_UNAVAILABLE" : "REPOSITORY_NOT_READY");
  }

  try {
    const limit = Math.min(200, Math.max(1, Math.floor(request.limit ?? 100)));
    const maxDepth = Math.min(10, Math.max(1, Math.floor(request.maxDepth ?? 3)));
    const impact = await request.intelligence.getImpactCandidates(paths, { limit, maxDepth });
    const dependentEdges = (await Promise.all(paths.map(async (path) => await request.intelligence.findDependents(path, { limit }).catch(() => ({ items: [], truncated: true }))))).flatMap((page) => page.items);
    const dependencyEdges = (await Promise.all(paths.map(async (path) => await request.intelligence.findDependencies(path, { limit }).catch(() => ({ items: [], truncated: true }))))).flatMap((page) => page.items);
    const callGraphs = (await Promise.all(paths.map(async (path) => await request.intelligence.getCallGraph(path).catch(() => undefined)))).filter((graph): graph is NonNullable<typeof graph> => Boolean(graph));
    const analysisCompleteness = normalizeCompleteness(impact.completeness?.level);
    const reasons = new Set<RiskReasonCode>();
    const evidence: StructuralImpactEvidence[] = paths.map((path) => ({ path, relation: "changed", depth: 0, provenance: "static-direct" }));
    const unresolvedRelationships: StructuralImpactEvidence[] = [];
    const dynamicConstructs = callGraphs.flatMap((graph) => graph.dynamicConstructs.map((dynamic) => ({ path: graph.path, kind: dynamic.kind, line: dynamic.line })));
    const callers = unique(dependentEdges.map((edge) => edge.sourcePath));
    const callees = unique(dependencyEdges.map((edge) => edge.targetPath).filter((path): path is string => Boolean(path)));
    const directDependents = callers;
    const transitiveDependents = unique(impact.candidateDependents).filter((path) => !directDependents.includes(path));
    const candidateTests = unique(impact.candidateTests);
    const publicInterfaces: string[] = [];

    for (const [index, path] of paths.entries()) {
      const file = files[index];
      const kind = kinds[path]!;
      const summary = await request.intelligence.getFileSummary(path).catch(() => undefined);
      if (file?.parserStatus === "error") addReason(reasons, "PARSE_FAILURE");
      if (file?.parserStatus === "fallback" || file?.parserStatus === "skipped" || !file?.language) addReason(reasons, "UNKNOWN_LANGUAGE");
      if (file?.generated || kind === "generated") addReason(reasons, "GENERATED_CODE_BOUNDARY");
      if (kind === "config") addReason(reasons, "CONFIGURATION_CHANGE");
      if (kind === "dependency") addReason(reasons, "DEPENDENCY_VERSION_CHANGE");
      if (kind === "migration") addReason(reasons, "DATABASE_SCHEMA_CHANGE");
      if (kind === "delete" || kind === "rename") addReason(reasons, "DELETED_OR_RENAMED_TARGET");
      if ((kind === "signature" || kind === "public_api" || kind === "type" || kind === "new_api") && summary) {
        for (const symbol of summary.exports) publicInterfaces.push(`${path}:${symbol.qualifiedName}`);
        addReason(reasons, kind === "type" ? "SHARED_TYPE_CHANGE" : "PUBLIC_INTERFACE_CHANGED");
      }
      if (kind === "public_api" || /(?:^|\/)index\.[^.]+$/i.test(path)) {
        for (const symbol of summary?.exports ?? []) publicInterfaces.push(`${path}:${symbol.qualifiedName}`);
      }
    }
    if (impact.unresolvedEdges > 0 || dependencyEdges.some((edge) => edge.provenance === "unresolved")) {
      addReason(reasons, "UNRESOLVED_DEPENDENCY");
      for (const edge of dependencyEdges.filter((edge) => edge.provenance === "unresolved")) {
        unresolvedRelationships.push({ path: edge.targetPath ?? edge.sourcePath, relation: "unresolved", depth: 1, provenance: edge.provenance, reasonCode: "UNRESOLVED_DEPENDENCY" });
      }
    }
    if (dynamicConstructs.length > 0) {
      addReason(reasons, "DYNAMIC_DISPATCH");
      for (const dynamic of dynamicConstructs) unresolvedRelationships.push({ path: dynamic.path, relation: "dynamic", depth: 0, provenance: "unresolved", reasonCode: "DYNAMIC_DISPATCH" });
    }
    if (callGraphs.some((graph) => graph.ambiguousCalls > 0)) addReason(reasons, "AMBIGUOUS_SYMBOL");
    if (impact.truncated || dependentEdges.length >= limit) addReason(reasons, "TRAVERSAL_TRUNCATED");
    if (candidateTests.length > 0) addReason(reasons, "TEST_CANDIDATES_ONLY");
    for (const edge of [...dependentEdges, ...dependencyEdges]) {
      evidence.push({ path: edge.targetPath ?? edge.sourcePath, relation: edge.targetPath ? "dependency" : "dependent", depth: 1, provenance: edge.provenance, reasonCode: edge.provenance === "heuristic" ? "HEURISTIC_RELATIONSHIP" : undefined });
      if (edge.provenance === "heuristic") addReason(reasons, "HEURISTIC_RELATIONSHIP");
    }
    if (analysisCompleteness === "COMPLETE" && dynamicConstructs.length === 0 && impact.unresolvedEdges === 0 && !impact.truncated) addReason(reasons, "HIGH_CONFIDENCE_STATIC_GRAPH");

    const packageSet = unique([...paths, ...directDependents, ...transitiveDependents].map(packageFor));
    const interfaceChange = paths.some((path) => ["signature", "public_api", "type", "new_api"].includes(kinds[path]!));
    const structuralUnknown = analysisCompleteness === "UNKNOWN" || reasons.has("PARSE_FAILURE") || reasons.has("UNKNOWN_LANGUAGE");
    const partial = analysisCompleteness === "PARTIAL" || unresolvedRelationships.length > 0 || reasons.has("AMBIGUOUS_SYMBOL") || reasons.has("TRAVERSAL_TRUNCATED") || reasons.has("HEURISTIC_RELATIONSHIP");
    const analyzability: AnalyzabilityClass = structuralUnknown ? "UNKNOWN" : partial ? (reasons.has("DYNAMIC_DISPATCH") || reasons.has("PARSE_FAILURE") ? "LOW" : "MODERATE") : "HIGH";
    const hasSystemicKind = paths.some((path) => ["config", "dependency", "migration"].includes(kinds[path]!));
    const crossPackage = packageSet.length > 1 || (publicInterfaces.length > 0 && directDependents.some((path) => packageFor(path) !== packageFor(paths[0]!)));
    let risk: TaskRiskClass;
    if (structuralUnknown) risk = "UNKNOWN";
    else if (hasSystemicKind || impact.truncated && transitiveDependents.length > 10) risk = "SYSTEMIC";
    else if (crossPackage) risk = "CROSS_PACKAGE";
    else if (interfaceChange || publicInterfaces.length > 0 || dynamicConstructs.length > 0 || unresolvedRelationships.length > 0) risk = "CROSS_MODULE";
    else if (directDependents.length > 0 || transitiveDependents.length > 0) risk = "LIMITED";
    else risk = "LOCAL";
    const recommendedCapability = capabilityFor(risk, analyzability);
    const resultWithoutReceipt: Omit<StructuralRiskAnalysis, "receipt"> = {
      kind: "structural_risk_analysis",
      changedTargets: paths,
      directDependents,
      transitiveDependents,
      callers,
      callees,
      candidateTests,
      packages: packageSet,
      publicInterfaces: unique(publicInterfaces),
      unresolvedRelationships,
      dynamicConstructs,
      evidence,
      analysisCompleteness,
      analyzability,
      risk,
      reasonCodes: [...reasons],
      recommendedContextLevel: contextFor(risk),
      recommendedCapability,
      ...(request.exactPinnedRole && CAPABILITY_ORDER[request.exactPinnedRole] < CAPABILITY_ORDER[recommendedCapability]
        ? { capabilityMismatch: { pinned: request.exactPinnedRole, required: recommendedCapability } }
        : {}),
      parallelism: {
        safe: paths.length > 1 && risk === "LOCAL" && analyzability === "HIGH",
        reasonCodes: paths.length > 1 && risk === "LOCAL" && analyzability === "HIGH" ? [] : ["CROSS_PACKAGE_DEPENDENCY"],
      },
      identity,
    };
    const result = withReceipt(resultWithoutReceipt, "miss");
    request.ledger?.record({ mechanism: "risk_analysis", measurement: "measured", quantity: 1, unit: "count", reason: "analysis" });
    request.ledger?.record({ mechanism: "risk_analysis", measurement: "measured", quantity: 1, unit: "count", reason: "cache_miss" });
    if (CAPABILITY_ORDER[result.recommendedCapability] > CAPABILITY_ORDER.FAST_WORKER) request.ledger?.record({ mechanism: "risk_analysis", measurement: "measured", quantity: 1, unit: "count", reason: "role_escalation" });
    if (result.recommendedContextLevel !== "L1") request.ledger?.record({ mechanism: "risk_analysis", measurement: "measured", quantity: 1, unit: "count", reason: "context_expansion" });
    if (request.cache) await request.cache.put(identity.namespace, cacheKey, JSON.stringify(result)).catch(() => undefined);
    return result;
  } catch {
    return fallback(identity, "ANALYSIS_UNAVAILABLE");
  }
}
