import { createHash } from "node:crypto";

/**
 * The one shared, additive contract for 8-Bit, 16-Bit, and ForgeGreen learning evidence.
 * It is intentionally limited to de-identified, derived values; neither prompts nor source or
 * tool output has a field in which it can be stored.
 */
export const INTELLIGENCE_FEATURE_SCHEMA_VERSION = "codeforge-intelligence-features-v1" as const;
export const INTELLIGENCE_SPLIT_VERSION = "codeforge-intelligence-splits-v1" as const;

export type IntelligenceDomain = "8BIT" | "16BIT" | "FORGEGREEN";
export type EvidenceProvenance =
  | "OBSERVED_PRODUCTION"
  | "OBSERVED_BENCHMARK"
  | "SIMULATED"
  | "MOCK"
  | "SYNTHETIC_CHAOS";
export type DatasetPartition = "TRAINING" | "VALIDATION" | "PUBLIC_TEST" | "PROTECTED_HOLDOUT";
export type Confidence = "INSUFFICIENT_DATA" | "LOW" | "MEDIUM" | "HIGH";
export type RiskBand = "NONE" | "LOW" | "MEDIUM" | "HIGH" | "EXHAUSTED" | "UNKNOWN";
export type LatencyBand = "FAST" | "MODERATE" | "SLOW" | "VERY_SLOW" | "UNKNOWN";
export type SizeBand = "TINY" | "SMALL" | "MEDIUM" | "LARGE" | "XLARGE" | "UNKNOWN";
export type HealthState = "HEALTHY" | "DEGRADED" | "RATE_LIMITED" | "QUOTA_EXHAUSTED" | "UNAVAILABLE" | "UNKNOWN";
export type RouteClass = "MANAGED_FREE" | "PAID_AUTO" | "BYOK" | "EXTERNAL_AGENT";

/** Provider transport/availability is deliberately not a capability label. */
export type IntelligenceOutcome =
  | "VERIFIED_SUCCESS"
  | "VERIFIED_SUCCESS_AFTER_RETRY"
  | "VERIFIED_SUCCESS_AFTER_ESCALATION"
  | "MODEL_REASONING_FAILURE"
  | "MODEL_RELIABILITY_FAILURE"
  | "PLANNING_FAILURE"
  | "CONTEXT_FAILURE"
  | "TOOL_FAILURE"
  | "PROVIDER_RATE_LIMIT"
  | "PROVIDER_FAILURE"
  | "QUOTA_BLOCK"
  | "BUDGET_BLOCK"
  | "VERIFICATION_FAILURE"
  | "COMPLETION_CONTROL_FAILURE"
  | "USER_CANCELLED"
  | "TIME_BUDGET_EXHAUSTED"
  | "INFRASTRUCTURE_FAILURE";

export interface TaskFeatures {
  taskClass?: "BUG_FIX" | "FEATURE" | "REFACTOR" | "REVIEW" | "RESEARCH" | "TEST" | "UNKNOWN";
  taskComplexity?: SizeBand;
  role?: string;
  repoLanguage?: string;
  repoFramework?: string;
  repositorySizeBand?: SizeBand;
  candidateFileCount?: number;
  likelyEditFileCount?: number;
  requestedOperation?: "EDIT" | "ANALYZE" | "REVIEW" | "PLAN" | "TEST" | "UNKNOWN";
  surface?: "FRONTEND" | "BACKEND" | "FULLSTACK" | "UNKNOWN";
  testRequired?: boolean;
  terminalRequired?: boolean;
  longContextNeed?: boolean;
  visualNeed?: boolean;
  structuredOutputNeed?: boolean;
  priorAttemptCount?: number;
  priorFailureClass?: IntelligenceOutcome;
}

export interface RouteFeatures {
  routeClass: RouteClass;
  deterministicRouteIdHash: string;
  canonicalModelId?: string;
  providerId?: string;
  servedModelId?: string;
  providerHealthState: HealthState;
  routeHealthState: HealthState;
  quotaRemainingBand: RiskBand;
  rateLimitRisk: RiskBand;
  providerLatencyBand: LatencyBand;
  contextLimitBand: SizeBand;
  toolSupport?: boolean;
  providerConcentration?: RiskBand;
  recentSuccessRateBand?: RiskBand;
  recent429RateBand?: RiskBand;
  recentErrorRateBand?: RiskBand;
}

export interface TopologyFeatures {
  topologyRequested?: 1 | 2 | 4;
  topologyRecommended?: 1 | 2 | 4;
  topologyActuallyUsed?: 1 | 2 | 4;
  parallelAgentCount?: 1 | 2 | 4;
  providerConcentration?: RiskBand;
  patchSizeBand?: SizeBand;
  verificationCommandCount?: number;
}

export interface ContextFeatures {
  initialContextTokens?: number;
  finalContextTokens?: number;
  contextReuse?: boolean;
  cacheEligibleTokens?: number;
  duplicateContextEstimate?: number;
}

export interface ToolFeatures {
  toolCallCount?: number;
  repeatedSearchCount?: number;
  repeatedFileReadCount?: number;
  repeatedCommandCount?: number;
  noProgressSignals?: number;
}

export interface EconomicFeatures {
  priceCardId?: string;
  estimatedInputCostUsd?: string;
  estimatedOutputCostUsd?: string;
  expectedTotalTaskCostUsd?: string;
  actualCostUsd?: string;
  retryCostUsd?: string;
  verificationCostUsd?: string;
  escalationCostUsd?: string;
  gatewayFeeUsd?: string;
  cacheSavingsUsd?: string;
  reservedBudgetUsd?: string;
  remainingCampaignBudgetUsd?: string;
}

export interface VerificationOutcome {
  verificationStarted: boolean;
  verificationCaught: boolean;
  completionBlocked: boolean;
  falseCompletion: boolean;
}

export interface IntelligenceLineage {
  taskIdHash: string;
  runIdHash: string;
  tenantIdHash: string;
  observedAt: string;
  policyVersion: string;
  modelProfileVersion?: string;
  forgeGreenVersion?: string;
  featureSchemaVersion: typeof INTELLIGENCE_FEATURE_SCHEMA_VERSION;
  provenance: EvidenceProvenance;
  sourceClassification: "HISTORICAL" | "R13" | "BENCHMARK" | "CHAOS" | "TOPOLOGY_ABLATION" | "MOCK";
  taskFamilyHash?: string;
  fixtureFamilyHash?: string;
  repositoryHash?: string;
  benchmarkLineageHash?: string;
}

export interface ProductionDecision {
  routeIdHash: string;
  routeClass: RouteClass;
  selectedCanonicalModelId?: string;
  selectedProviderId?: string;
  deterministicScore?: number;
}

export interface ShadowRecommendation {
  recommendationKind: "ROUTE_RANK" | "ECONOMIC_VALUE" | "TOPOLOGY";
  recommendedRouteIdHash?: string;
  recommendedParallelAgents?: 1 | 2 | 4;
  predictedSuccess?: number;
  predictedRisk?: RiskBand;
  predictedCostUsd?: string;
  predictedLatency?: LatencyBand;
  confidence: Confidence;
  modelArtifactId?: string;
  limitations: string[];
}

export interface IntelligenceRecord {
  recordId: string;
  domain: IntelligenceDomain;
  lineage: IntelligenceLineage;
  task: TaskFeatures;
  route: RouteFeatures;
  topology: TopologyFeatures;
  context: ContextFeatures;
  tools: ToolFeatures;
  economics: EconomicFeatures;
  productionDecision: ProductionDecision;
  shadowRecommendation?: ShadowRecommendation;
  actualOutcome?: IntelligenceOutcome;
  verification?: VerificationOutcome;
}

export interface IntelligenceRecordInput extends Omit<IntelligenceRecord, "recordId" | "lineage" | "productionDecision"> {
  lineage: Omit<IntelligenceLineage, "taskIdHash" | "runIdHash" | "tenantIdHash" | "featureSchemaVersion"> & {
    taskId: string;
    runId: string;
    tenantId: string;
  };
  productionDecision: Omit<ProductionDecision, "routeIdHash"> & { routeId: string };
}

const SECRET_PATTERN = /(?:api[_-]?key|authorization\s*[:=]|bearer\s+|oauth|password\s*[:=]|secret\s*[:=]|sk-[a-z0-9]|gsk_|gh[pousr]_|github_pat_|xox[baprs]-|-----begin [a-z ]*private key-----)/i;
const MONEY_PATTERN = /^\d+(?:\.\d{1,6})?$/;

export function stableHash(value: string, namespace = "codeforge-intelligence"): string {
  return createHash("sha256").update(`${namespace}:${value}`).digest("hex");
}

function assertSafeControlledString(field: string, value: string | undefined): void {
  if (value !== undefined && (SECRET_PATTERN.test(value) || value.length > 160)) {
    throw new Error(`${field} cannot contain secrets or unbounded text`);
  }
}

function assertFiniteCounts(value: number | undefined, field: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new Error(`${field} must be a non-negative safe integer`);
}

function assertMoney(value: string | undefined, field: string): void {
  if (value !== undefined && !MONEY_PATTERN.test(value)) throw new Error(`${field} must be an unsigned decimal with at most six fractional places`);
}

/** Builds a bounded row by whitelisting every persisted field. Unknown/raw input is never spread. */
export function sanitizeIntelligenceRecord(input: IntelligenceRecordInput): IntelligenceRecord {
  assertSafeControlledString("canonicalModelId", input.route.canonicalModelId);
  assertSafeControlledString("providerId", input.route.providerId);
  assertSafeControlledString("servedModelId", input.route.servedModelId);
  assertSafeControlledString("role", input.task.role);
  assertSafeControlledString("repoLanguage", input.task.repoLanguage);
  assertSafeControlledString("repoFramework", input.task.repoFramework);
  for (const [name, value] of Object.entries(input.economics)) assertMoney(value, name);
  for (const [name, value] of Object.entries({
    candidateFileCount: input.task.candidateFileCount,
    likelyEditFileCount: input.task.likelyEditFileCount,
    priorAttemptCount: input.task.priorAttemptCount,
    initialContextTokens: input.context.initialContextTokens,
    finalContextTokens: input.context.finalContextTokens,
    cacheEligibleTokens: input.context.cacheEligibleTokens,
    duplicateContextEstimate: input.context.duplicateContextEstimate,
    toolCallCount: input.tools.toolCallCount,
    repeatedSearchCount: input.tools.repeatedSearchCount,
    repeatedFileReadCount: input.tools.repeatedFileReadCount,
    repeatedCommandCount: input.tools.repeatedCommandCount,
    noProgressSignals: input.tools.noProgressSignals,
    verificationCommandCount: input.topology.verificationCommandCount,
  })) assertFiniteCounts(value, name);
  if (Number.isNaN(Date.parse(input.lineage.observedAt))) throw new Error("observedAt must be an ISO timestamp");

  const lineage: IntelligenceLineage = {
    taskIdHash: stableHash(input.lineage.taskId, "task"),
    runIdHash: stableHash(input.lineage.runId, "run"),
    tenantIdHash: stableHash(input.lineage.tenantId, "tenant"),
    observedAt: input.lineage.observedAt,
    policyVersion: input.lineage.policyVersion,
    ...(input.lineage.modelProfileVersion === undefined ? {} : { modelProfileVersion: input.lineage.modelProfileVersion }),
    ...(input.lineage.forgeGreenVersion === undefined ? {} : { forgeGreenVersion: input.lineage.forgeGreenVersion }),
    featureSchemaVersion: INTELLIGENCE_FEATURE_SCHEMA_VERSION,
    provenance: input.lineage.provenance,
    sourceClassification: input.lineage.sourceClassification,
    ...(input.lineage.taskFamilyHash === undefined ? {} : { taskFamilyHash: stableHash(input.lineage.taskFamilyHash, "task-family") }),
    ...(input.lineage.fixtureFamilyHash === undefined ? {} : { fixtureFamilyHash: stableHash(input.lineage.fixtureFamilyHash, "fixture-family") }),
    ...(input.lineage.repositoryHash === undefined ? {} : { repositoryHash: stableHash(input.lineage.repositoryHash, "repository") }),
    ...(input.lineage.benchmarkLineageHash === undefined ? {} : { benchmarkLineageHash: stableHash(input.lineage.benchmarkLineageHash, "benchmark-lineage") }),
  };
  const decision: ProductionDecision = {
    routeIdHash: stableHash(input.productionDecision.routeId, "route"),
    routeClass: input.productionDecision.routeClass,
    ...(input.productionDecision.selectedCanonicalModelId === undefined ? {} : { selectedCanonicalModelId: input.productionDecision.selectedCanonicalModelId }),
    ...(input.productionDecision.selectedProviderId === undefined ? {} : { selectedProviderId: input.productionDecision.selectedProviderId }),
    ...(input.productionDecision.deterministicScore === undefined ? {} : { deterministicScore: input.productionDecision.deterministicScore }),
  };
  const recordId = stableHash(`${input.domain}:${lineage.runIdHash}:${decision.routeIdHash}:${lineage.observedAt}`, "record").slice(0, 32);
  return {
    recordId,
    domain: input.domain,
    lineage,
    task: { ...input.task },
    route: { ...input.route, deterministicRouteIdHash: decision.routeIdHash },
    topology: { ...input.topology },
    context: { ...input.context },
    tools: { ...input.tools },
    economics: { ...input.economics },
    productionDecision: decision,
    ...(input.shadowRecommendation === undefined ? {} : { shadowRecommendation: { ...input.shadowRecommendation, limitations: [...input.shadowRecommendation.limitations] } }),
    ...(input.actualOutcome === undefined ? {} : { actualOutcome: input.actualOutcome }),
    ...(input.verification === undefined ? {} : { verification: { ...input.verification } }),
  };
}

function assertHash(field: string, value: string, length: number): void {
  if (!new RegExp(`^[a-f0-9]{${length}}$`).test(value)) throw new Error(`${field} must be a ${String(length)}-character SHA-256-derived hash`);
}

/**
 * Persistence accepts an already-sanitized record, so it still needs a runtime whitelist before
 * an untyped caller can hand an object to a generic JSON work-item store.
 */
export function clonePersistableIntelligenceRecord(record: IntelligenceRecord): IntelligenceRecord {
  assertHash("recordId", record.recordId, 32);
  for (const [field, value] of Object.entries({
    taskIdHash: record.lineage.taskIdHash,
    runIdHash: record.lineage.runIdHash,
    tenantIdHash: record.lineage.tenantIdHash,
    deterministicRouteIdHash: record.route.deterministicRouteIdHash,
    routeIdHash: record.productionDecision.routeIdHash,
  })) assertHash(field, value, 64);
  for (const [field, value] of Object.entries({
    policyVersion: record.lineage.policyVersion,
    modelProfileVersion: record.lineage.modelProfileVersion,
    forgeGreenVersion: record.lineage.forgeGreenVersion,
    role: record.task.role,
    repoLanguage: record.task.repoLanguage,
    repoFramework: record.task.repoFramework,
    canonicalModelId: record.route.canonicalModelId,
    providerId: record.route.providerId,
    servedModelId: record.route.servedModelId,
    priceCardId: record.economics.priceCardId,
    selectedCanonicalModelId: record.productionDecision.selectedCanonicalModelId,
    selectedProviderId: record.productionDecision.selectedProviderId,
    modelArtifactId: record.shadowRecommendation?.modelArtifactId,
  })) assertSafeControlledString(field, value);
  for (const [field, value] of Object.entries(record.economics)) assertMoney(value, field);
  for (const limitation of record.shadowRecommendation?.limitations ?? []) assertSafeControlledString("shadowRecommendation.limitation", limitation);

  return {
    recordId: record.recordId,
    domain: record.domain,
    lineage: {
      taskIdHash: record.lineage.taskIdHash,
      runIdHash: record.lineage.runIdHash,
      tenantIdHash: record.lineage.tenantIdHash,
      observedAt: record.lineage.observedAt,
      policyVersion: record.lineage.policyVersion,
      featureSchemaVersion: record.lineage.featureSchemaVersion,
      provenance: record.lineage.provenance,
      sourceClassification: record.lineage.sourceClassification,
      ...(record.lineage.modelProfileVersion === undefined ? {} : { modelProfileVersion: record.lineage.modelProfileVersion }),
      ...(record.lineage.forgeGreenVersion === undefined ? {} : { forgeGreenVersion: record.lineage.forgeGreenVersion }),
      ...(record.lineage.taskFamilyHash === undefined ? {} : { taskFamilyHash: record.lineage.taskFamilyHash }),
      ...(record.lineage.fixtureFamilyHash === undefined ? {} : { fixtureFamilyHash: record.lineage.fixtureFamilyHash }),
      ...(record.lineage.repositoryHash === undefined ? {} : { repositoryHash: record.lineage.repositoryHash }),
      ...(record.lineage.benchmarkLineageHash === undefined ? {} : { benchmarkLineageHash: record.lineage.benchmarkLineageHash }),
    },
    task: {
      ...(record.task.taskClass === undefined ? {} : { taskClass: record.task.taskClass }),
      ...(record.task.taskComplexity === undefined ? {} : { taskComplexity: record.task.taskComplexity }),
      ...(record.task.role === undefined ? {} : { role: record.task.role }),
      ...(record.task.repoLanguage === undefined ? {} : { repoLanguage: record.task.repoLanguage }),
      ...(record.task.repoFramework === undefined ? {} : { repoFramework: record.task.repoFramework }),
      ...(record.task.repositorySizeBand === undefined ? {} : { repositorySizeBand: record.task.repositorySizeBand }),
      ...(record.task.candidateFileCount === undefined ? {} : { candidateFileCount: record.task.candidateFileCount }),
      ...(record.task.likelyEditFileCount === undefined ? {} : { likelyEditFileCount: record.task.likelyEditFileCount }),
      ...(record.task.requestedOperation === undefined ? {} : { requestedOperation: record.task.requestedOperation }),
      ...(record.task.surface === undefined ? {} : { surface: record.task.surface }),
      ...(record.task.testRequired === undefined ? {} : { testRequired: record.task.testRequired }),
      ...(record.task.terminalRequired === undefined ? {} : { terminalRequired: record.task.terminalRequired }),
      ...(record.task.longContextNeed === undefined ? {} : { longContextNeed: record.task.longContextNeed }),
      ...(record.task.visualNeed === undefined ? {} : { visualNeed: record.task.visualNeed }),
      ...(record.task.structuredOutputNeed === undefined ? {} : { structuredOutputNeed: record.task.structuredOutputNeed }),
      ...(record.task.priorAttemptCount === undefined ? {} : { priorAttemptCount: record.task.priorAttemptCount }),
      ...(record.task.priorFailureClass === undefined ? {} : { priorFailureClass: record.task.priorFailureClass }),
    },
    route: {
      routeClass: record.route.routeClass,
      deterministicRouteIdHash: record.route.deterministicRouteIdHash,
      providerHealthState: record.route.providerHealthState,
      routeHealthState: record.route.routeHealthState,
      quotaRemainingBand: record.route.quotaRemainingBand,
      rateLimitRisk: record.route.rateLimitRisk,
      providerLatencyBand: record.route.providerLatencyBand,
      contextLimitBand: record.route.contextLimitBand,
      ...(record.route.canonicalModelId === undefined ? {} : { canonicalModelId: record.route.canonicalModelId }),
      ...(record.route.providerId === undefined ? {} : { providerId: record.route.providerId }),
      ...(record.route.servedModelId === undefined ? {} : { servedModelId: record.route.servedModelId }),
      ...(record.route.toolSupport === undefined ? {} : { toolSupport: record.route.toolSupport }),
      ...(record.route.providerConcentration === undefined ? {} : { providerConcentration: record.route.providerConcentration }),
      ...(record.route.recentSuccessRateBand === undefined ? {} : { recentSuccessRateBand: record.route.recentSuccessRateBand }),
      ...(record.route.recent429RateBand === undefined ? {} : { recent429RateBand: record.route.recent429RateBand }),
      ...(record.route.recentErrorRateBand === undefined ? {} : { recentErrorRateBand: record.route.recentErrorRateBand }),
    },
    topology: { ...record.topology },
    context: { ...record.context },
    tools: { ...record.tools },
    economics: { ...record.economics },
    productionDecision: {
      routeIdHash: record.productionDecision.routeIdHash,
      routeClass: record.productionDecision.routeClass,
      ...(record.productionDecision.selectedCanonicalModelId === undefined ? {} : { selectedCanonicalModelId: record.productionDecision.selectedCanonicalModelId }),
      ...(record.productionDecision.selectedProviderId === undefined ? {} : { selectedProviderId: record.productionDecision.selectedProviderId }),
      ...(record.productionDecision.deterministicScore === undefined ? {} : { deterministicScore: record.productionDecision.deterministicScore }),
    },
    ...(record.shadowRecommendation === undefined ? {} : {
      shadowRecommendation: {
        recommendationKind: record.shadowRecommendation.recommendationKind,
        confidence: record.shadowRecommendation.confidence,
        limitations: [...record.shadowRecommendation.limitations],
        ...(record.shadowRecommendation.recommendedRouteIdHash === undefined ? {} : { recommendedRouteIdHash: record.shadowRecommendation.recommendedRouteIdHash }),
        ...(record.shadowRecommendation.recommendedParallelAgents === undefined ? {} : { recommendedParallelAgents: record.shadowRecommendation.recommendedParallelAgents }),
        ...(record.shadowRecommendation.predictedSuccess === undefined ? {} : { predictedSuccess: record.shadowRecommendation.predictedSuccess }),
        ...(record.shadowRecommendation.predictedRisk === undefined ? {} : { predictedRisk: record.shadowRecommendation.predictedRisk }),
        ...(record.shadowRecommendation.predictedCostUsd === undefined ? {} : { predictedCostUsd: record.shadowRecommendation.predictedCostUsd }),
        ...(record.shadowRecommendation.predictedLatency === undefined ? {} : { predictedLatency: record.shadowRecommendation.predictedLatency }),
        ...(record.shadowRecommendation.modelArtifactId === undefined ? {} : { modelArtifactId: record.shadowRecommendation.modelArtifactId }),
      },
    }),
    ...(record.actualOutcome === undefined ? {} : { actualOutcome: record.actualOutcome }),
    ...(record.verification === undefined ? {} : {
      verification: {
        verificationStarted: record.verification.verificationStarted,
        verificationCaught: record.verification.verificationCaught,
        completionBlocked: record.verification.completionBlocked,
        falseCompletion: record.verification.falseCompletion,
      },
    }),
  };
}

export function isVerifiedSuccess(outcome: IntelligenceOutcome | undefined): boolean | undefined {
  if (!outcome) return undefined;
  return outcome === "VERIFIED_SUCCESS" || outcome === "VERIFIED_SUCCESS_AFTER_RETRY" || outcome === "VERIFIED_SUCCESS_AFTER_ESCALATION";
}
