import {
  createForgeGreenShadowPredictor,
  sanitizeIntelligenceRecord,
  type IntelligenceRecord,
  type ShadowModelArtifact,
} from "@codeforge/intelligence";

export interface ForgeGreenShadowInput {
  sessionId: string;
  runId: string;
  requestedTopology: 1 | 2 | 4;
  deterministicRecommendedTopology: 1 | 2 | 4;
  initialContextTokens?: number;
  finalContextTokens?: number;
  toolCallCount?: number;
  noProgressSignals?: number;
  providerConcentration?: "NONE" | "LOW" | "MEDIUM" | "HIGH" | "EXHAUSTED" | "UNKNOWN";
}

/** Returns an advisory record only; callers retain topology/execution authority. */
export function observeForgeGreenShadow(input: ForgeGreenShadowInput, options: { enabled: boolean; artifact?: ShadowModelArtifact }): IntelligenceRecord {
  const record = sanitizeIntelligenceRecord({
    domain: "FORGEGREEN",
    lineage: {
      taskId: input.runId,
      runId: input.runId,
      tenantId: input.sessionId,
      observedAt: new Date().toISOString(),
      policyVersion: "forgegreen-r13",
      forgeGreenVersion: "forgegreen-topology-v1",
      sourceClassification: "TOPOLOGY_ABLATION",
      provenance: "SIMULATED",
      taskFamilyHash: "forgegreen-topology",
    },
    task: { taskClass: "UNKNOWN", requestedOperation: "UNKNOWN" },
    route: {
      routeClass: "MANAGED_FREE",
      deterministicRouteIdHash: "unused-before-sanitization",
      providerHealthState: "UNKNOWN",
      routeHealthState: "UNKNOWN",
      quotaRemainingBand: "UNKNOWN",
      rateLimitRisk: "UNKNOWN",
      providerLatencyBand: "UNKNOWN",
      contextLimitBand: "UNKNOWN",
      ...(input.providerConcentration === undefined ? {} : { providerConcentration: input.providerConcentration }),
    },
    topology: {
      topologyRequested: input.requestedTopology,
      topologyRecommended: input.deterministicRecommendedTopology,
      ...(input.providerConcentration === undefined ? {} : { providerConcentration: input.providerConcentration }),
    },
    context: {
      ...(input.initialContextTokens === undefined ? {} : { initialContextTokens: input.initialContextTokens }),
      ...(input.finalContextTokens === undefined ? {} : { finalContextTokens: input.finalContextTokens }),
    },
    tools: {
      ...(input.toolCallCount === undefined ? {} : { toolCallCount: input.toolCallCount }),
      ...(input.noProgressSignals === undefined ? {} : { noProgressSignals: input.noProgressSignals }),
    },
    economics: {},
    productionDecision: { routeId: `topology:${input.requestedTopology}`, routeClass: "MANAGED_FREE" },
  });
  const prediction = createForgeGreenShadowPredictor(options.artifact, options.enabled).predict(record);
  return { ...record, shadowRecommendation: prediction.recommendation };
}
