import { classifyOutcome, type OutcomeClassificationInput } from "./outcome-taxonomy.js";
import { sanitizeIntelligenceRecord, type EvidenceProvenance, type IntelligenceRecord, type RouteClass } from "./schema.js";

/** Sanitized ingestion boundary for R11/R12/R13 result summaries, never benchmark bodies. */
export interface HistoricalOutcomeInput {
  campaign: "R11" | "R12" | "R13";
  taskId: string;
  runId: string;
  tenantId: string;
  observedAt: string;
  taskFamily: string;
  repository: string;
  providerId?: string;
  canonicalModelId?: string;
  routeId: string;
  routeClass: RouteClass;
  taskClass?: "BUG_FIX" | "FEATURE" | "REFACTOR" | "REVIEW" | "RESEARCH" | "TEST" | "UNKNOWN";
  source: EvidenceProvenance;
  taxonomy: OutcomeClassificationInput;
}

export function historicalOutcomeRecord(input: HistoricalOutcomeInput): IntelligenceRecord {
  const classified = classifyOutcome(input.taxonomy);
  return sanitizeIntelligenceRecord({
    domain: "8BIT",
    lineage: {
      taskId: input.taskId,
      runId: input.runId,
      tenantId: input.tenantId,
      observedAt: input.observedAt,
      policyVersion: `${input.campaign.toLowerCase()}-historical`,
      sourceClassification: "BENCHMARK",
      provenance: input.source,
      taskFamilyHash: input.taskFamily,
      repositoryHash: input.repository,
      benchmarkLineageHash: input.campaign,
    },
    task: { taskClass: input.taskClass ?? "UNKNOWN", requestedOperation: "UNKNOWN" },
    route: {
      routeClass: input.routeClass,
      deterministicRouteIdHash: "unused-before-sanitization",
      ...(input.canonicalModelId === undefined ? {} : { canonicalModelId: input.canonicalModelId }),
      ...(input.providerId === undefined ? {} : { providerId: input.providerId }),
      providerHealthState: "UNKNOWN",
      routeHealthState: "UNKNOWN",
      quotaRemainingBand: classified.outcome === "QUOTA_BLOCK" ? "EXHAUSTED" : "UNKNOWN",
      rateLimitRisk: classified.outcome === "PROVIDER_RATE_LIMIT" ? "HIGH" : "UNKNOWN",
      providerLatencyBand: "UNKNOWN",
      contextLimitBand: "UNKNOWN",
    },
    topology: {},
    context: {},
    tools: {},
    economics: {},
    productionDecision: { routeId: input.routeId, routeClass: input.routeClass, ...(input.canonicalModelId === undefined ? {} : { selectedCanonicalModelId: input.canonicalModelId }), ...(input.providerId === undefined ? {} : { selectedProviderId: input.providerId }) },
    actualOutcome: classified.outcome,
    verification: classified.verification,
  });
}
