import {
  createSixteenBitShadowPredictor,
  sanitizeIntelligenceRecord,
  type IntelligenceRecord,
  type ShadowModelArtifact,
} from "@codeforge/intelligence";

export interface SixteenBitShadowInput {
  campaignId: string;
  requestId: string;
  providerId: string;
  canonicalModelId: string;
  routeId: string;
  expectedTotalTaskCostUsd?: string;
  remainingCampaignBudgetUsd?: string;
  deterministicScore?: number;
}

/**
 * A pure recommendation surface. It deliberately receives no budget ledger and has no route,
 * reservation, authorization, or provider-call method. Callers may label controlled test inputs
 * as MOCK, but the default represents an observed deterministic production decision.
 */
export function observeSixteenBitShadow(input: SixteenBitShadowInput, options: { enabled: boolean; artifact?: ShadowModelArtifact; provenance?: "OBSERVED_PRODUCTION" | "OBSERVED_BENCHMARK" | "MOCK" }): IntelligenceRecord {
  const record = sanitizeIntelligenceRecord({
    domain: "16BIT",
    lineage: {
      taskId: input.requestId,
      runId: input.requestId,
      tenantId: input.campaignId,
      observedAt: new Date().toISOString(),
      policyVersion: "paid-auto-r13",
      sourceClassification: "R13",
      provenance: options.provenance ?? "OBSERVED_PRODUCTION",
      taskFamilyHash: "paid-evaluation",
    },
    task: { taskClass: "UNKNOWN", requestedOperation: "UNKNOWN" },
    route: {
      routeClass: "PAID_AUTO",
      deterministicRouteIdHash: "unused-before-sanitization",
      canonicalModelId: input.canonicalModelId,
      providerId: input.providerId,
      providerHealthState: "UNKNOWN",
      routeHealthState: "UNKNOWN",
      quotaRemainingBand: "UNKNOWN",
      rateLimitRisk: "UNKNOWN",
      providerLatencyBand: "UNKNOWN",
      contextLimitBand: "UNKNOWN",
    },
    topology: {},
    context: {},
    tools: {},
    economics: {
      ...(input.expectedTotalTaskCostUsd === undefined ? {} : { expectedTotalTaskCostUsd: input.expectedTotalTaskCostUsd }),
      ...(input.remainingCampaignBudgetUsd === undefined ? {} : { remainingCampaignBudgetUsd: input.remainingCampaignBudgetUsd }),
    },
    productionDecision: {
      routeId: input.routeId,
      routeClass: "PAID_AUTO",
      selectedCanonicalModelId: input.canonicalModelId,
      selectedProviderId: input.providerId,
      ...(input.deterministicScore === undefined ? {} : { deterministicScore: input.deterministicScore }),
    },
  });
  const prediction = createSixteenBitShadowPredictor(options.artifact, options.enabled).predict(record);
  return { ...record, shadowRecommendation: prediction.recommendation };
}
