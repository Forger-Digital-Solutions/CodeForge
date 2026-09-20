export type EightBitMeasuredHealthState = "HEALTHY" | "DEGRADED" | "UNAVAILABLE" | "PROBING" | "RECOVERED" | "QUARANTINED";

export interface EightBitRouteMeasurement {
  providerId: string;
  modelId: string;
  observedAt: string;
  sampleSize: number;
  successes: number;
  failures: number;
  rateLimits: number;
  timeouts: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  capacityUtilization: number;
  qualityScore?: number;
  toolCallScore?: number;
  policyCertainty: "verified" | "unknown" | "rejected";
  costCertainty: "verified_free" | "unknown" | "paid";
  availableCapacity?: number;
}

export interface EightBitMeasuredHealthRecord {
  providerId: string;
  modelId: string;
  state: EightBitMeasuredHealthState;
  availabilityScore: number;
  latencyScore: number;
  capacityScore: number | null;
  qualityScore: number | null;
  toolCallScore: number | null;
  policyCertainty: EightBitRouteMeasurement["policyCertainty"];
  costCertainty: EightBitRouteMeasurement["costCertainty"];
  recentFailureRate: number;
  recentRateLimitRate: number;
  lastVerified: string;
  healthyProbeStreak: number;
  reasonCodes: string[];
}

export interface EightBitMeasuredHealthPolicy {
  minimumSamples: number;
  degradedFailureRate: number;
  unavailableFailureRate: number;
  degradedRateLimitRate: number;
  unavailableRateLimitRate: number;
  latencyTargetMs: number;
  recoveryProbeSuccesses: number;
  minimumQualityScore: number;
}

export const DEFAULT_MEASURED_HEALTH_POLICY: EightBitMeasuredHealthPolicy = {
  minimumSamples: 5,
  degradedFailureRate: 0.1,
  unavailableFailureRate: 0.5,
  degradedRateLimitRate: 0.1,
  unavailableRateLimitRate: 0.4,
  latencyTargetMs: 10_000,
  recoveryProbeSuccesses: 2,
  minimumQualityScore: 0.6,
};

function bounded(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export class EightBitMeasuredHealthTracker {
  private readonly records = new Map<string, EightBitMeasuredHealthRecord>();

  constructor(private readonly policy: EightBitMeasuredHealthPolicy = DEFAULT_MEASURED_HEALTH_POLICY) {}

  ingest(measurement: EightBitRouteMeasurement): EightBitMeasuredHealthRecord {
    const key = `${measurement.providerId}::${measurement.modelId}`;
    const prior = this.records.get(key);
    const failureRate = measurement.sampleSize === 0 ? 0 : measurement.failures / measurement.sampleSize;
    const rateLimitRate = measurement.sampleSize === 0 ? 0 : measurement.rateLimits / measurement.sampleSize;
    const availabilityScore = measurement.sampleSize === 0 ? 0 : bounded(measurement.successes / measurement.sampleSize);
    const latencyScore = measurement.latencyP95Ms <= 0 ? 0 : bounded(this.policy.latencyTargetMs / measurement.latencyP95Ms);
    const capacityScore = measurement.availableCapacity === undefined ? null : bounded(1 - measurement.capacityUtilization);
    const reasonCodes: string[] = [];
    let state: EightBitMeasuredHealthState;

    if (measurement.costCertainty !== "verified_free") {
      state = "QUARANTINED";
      reasonCodes.push(measurement.costCertainty === "paid" ? "KNOWN_PAID" : "COST_UNCERTAIN");
    } else if (measurement.policyCertainty !== "verified") {
      state = "QUARANTINED";
      reasonCodes.push(measurement.policyCertainty === "rejected" ? "POLICY_REJECTED" : "POLICY_UNCERTAIN");
    } else if (measurement.qualityScore !== undefined && measurement.qualityScore < this.policy.minimumQualityScore) {
      state = "QUARANTINED";
      reasonCodes.push("QUALITY_BELOW_FLOOR");
    } else if (measurement.sampleSize < this.policy.minimumSamples) {
      state = prior?.state === "UNAVAILABLE" || prior?.state === "PROBING" ? "PROBING" : "DEGRADED";
      reasonCodes.push("INSUFFICIENT_SAMPLES");
    } else if (failureRate >= this.policy.unavailableFailureRate || rateLimitRate >= this.policy.unavailableRateLimitRate) {
      state = "UNAVAILABLE";
      reasonCodes.push(failureRate >= this.policy.unavailableFailureRate ? "FAILURE_RATE_UNAVAILABLE" : "RATE_LIMIT_UNAVAILABLE");
    } else if (failureRate >= this.policy.degradedFailureRate || rateLimitRate >= this.policy.degradedRateLimitRate || availabilityScore < 0.9) {
      state = "DEGRADED";
      reasonCodes.push(failureRate >= this.policy.degradedFailureRate ? "FAILURE_RATE_DEGRADED" : rateLimitRate >= this.policy.degradedRateLimitRate ? "RATE_LIMIT_DEGRADED" : "AVAILABILITY_DEGRADED");
    } else if (prior?.state === "UNAVAILABLE" || prior?.state === "PROBING") {
      const streak = (prior.healthyProbeStreak ?? 0) + 1;
      state = streak >= this.policy.recoveryProbeSuccesses ? "RECOVERED" : "PROBING";
      reasonCodes.push(state === "RECOVERED" ? "RECOVERY_PROVEN" : "RECOVERY_PROBING");
    } else {
      state = "HEALTHY";
      reasonCodes.push("MEASURED_HEALTHY");
    }

    const healthyProbeStreak = state === "PROBING" ? (prior?.healthyProbeStreak ?? 0) + 1 : state === "RECOVERED" ? this.policy.recoveryProbeSuccesses : 0;
    const record: EightBitMeasuredHealthRecord = {
      providerId: measurement.providerId,
      modelId: measurement.modelId,
      state,
      availabilityScore,
      latencyScore,
      capacityScore,
      qualityScore: measurement.qualityScore ?? null,
      toolCallScore: measurement.toolCallScore ?? null,
      policyCertainty: measurement.policyCertainty,
      costCertainty: measurement.costCertainty,
      recentFailureRate: failureRate,
      recentRateLimitRate: rateLimitRate,
      lastVerified: measurement.observedAt,
      healthyProbeStreak,
      reasonCodes,
    };
    this.records.set(key, record);
    return record;
  }

  get(providerId: string, modelId: string): EightBitMeasuredHealthRecord | undefined {
    return this.records.get(`${providerId}::${modelId}`);
  }

  snapshot(): EightBitMeasuredHealthRecord[] {
    return [...this.records.values()].map((record) => ({ ...record, reasonCodes: [...record.reasonCodes] }));
  }
}
