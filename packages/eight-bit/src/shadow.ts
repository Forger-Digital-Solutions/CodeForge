import {
  createEightBitShadowPredictor,
  sanitizeIntelligenceRecord,
  type IntelligenceRecord,
  type ShadowHealthCollector,
  type ShadowModelArtifact,
} from "@codeforge/intelligence";
import type { EightBitRole } from "./types.js";

export interface EightBitShadowObservation {
  sessionId: string;
  role: EightBitRole;
  workstreamId?: string;
  policyMode: "adaptive" | "byok" | "premium";
  taskType?: string;
  estimatedContextTokens?: number;
  providerId: string;
  modelId: string;
  deterministicScore: number;
}

/** Narrow observer interface. It has no return value that a router could consume. */
export interface EightBitShadowObserver {
  observe(observation: EightBitShadowObservation): void;
}

export class EightBitShadowRecorder implements EightBitShadowObserver {
  private readonly predictor;
  private readonly records: IntelligenceRecord[] = [];

  constructor(options: { enabled: boolean; artifact?: ShadowModelArtifact; health?: ShadowHealthCollector }) {
    this.predictor = createEightBitShadowPredictor(options.artifact, options.enabled);
    this.health = options.health;
  }

  private readonly health?: ShadowHealthCollector;

  observe(observation: EightBitShadowObservation): void {
    try {
      const base = sanitizeIntelligenceRecord({
        domain: "8BIT",
        lineage: {
          taskId: `${observation.role}:${observation.taskType ?? "unknown"}`,
          runId: `${observation.sessionId}:${observation.workstreamId ?? "default"}`,
          tenantId: observation.sessionId,
          observedAt: new Date().toISOString(),
          policyVersion: "eight-bit-r13",
          sourceClassification: "R13",
          provenance: "OBSERVED_PRODUCTION",
          taskFamilyHash: observation.taskType ?? observation.role,
        },
        task: {
          taskClass: "UNKNOWN",
          role: observation.role,
          requestedOperation: "UNKNOWN",
          longContextNeed: (observation.estimatedContextTokens ?? 0) >= 100_000,
        },
        route: {
          routeClass: "MANAGED_FREE",
          deterministicRouteIdHash: "unused-before-sanitization",
          canonicalModelId: observation.modelId,
          providerId: observation.providerId,
          providerHealthState: "UNKNOWN",
          routeHealthState: "UNKNOWN",
          quotaRemainingBand: "UNKNOWN",
          rateLimitRisk: "UNKNOWN",
          providerLatencyBand: "UNKNOWN",
          contextLimitBand: "UNKNOWN",
        },
        topology: {},
        context: { initialContextTokens: observation.estimatedContextTokens },
        tools: {},
        economics: {},
        productionDecision: {
          routeId: `${observation.providerId}:${observation.modelId}`,
          routeClass: "MANAGED_FREE",
          selectedCanonicalModelId: observation.modelId,
          selectedProviderId: observation.providerId,
          deterministicScore: observation.deterministicScore,
        },
      });
      const prediction = this.predictor.predict(base);
      this.health?.record({ status: prediction.artifactStatus, latencyMs: prediction.latencyMs });
      this.records.push({ ...base, shadowRecommendation: prediction.recommendation });
    } catch {
      // Shadow observation cannot disturb deterministic selection, including a bad artifact.
    }
  }

  snapshot(): IntelligenceRecord[] { return this.records.map((record) => structuredClone(record)); }
}

export function createEightBitShadowRecorder(options: { enabled: boolean; artifact?: ShadowModelArtifact; health?: ShadowHealthCollector }): EightBitShadowRecorder {
  return new EightBitShadowRecorder(options);
}
