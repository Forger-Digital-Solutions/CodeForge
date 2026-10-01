import { describe, expect, it, vi } from "vitest";
import { applyInferenceAutoscalingDecision, decideInferenceCapacity, type AutoscalingConfig, type AutoscalingObservation } from "../src/autoscaling.js";

const config: AutoscalingConfig = {
  minWorkers: 1,
  maxWorkers: 6,
  targetQueueLatencyMs: 2_000,
  scaleOutThreshold: 0.75,
  scaleInIdleDurationMs: 10 * 60_000,
  workerWarmupTimeMs: 90_000,
};

function observation(overrides: Partial<AutoscalingObservation> = {}): AutoscalingObservation {
  return {
    workers: [{ workerId: "worker-a", state: "READY", activeSequences: 4, maxConcurrentSequences: 4, idleForMs: 0 }],
    queueDepth: 0,
    oldestQueuedRequestMs: 0,
    tokensPerSecond: 120,
    gpuUtilizationPct: 88,
    vramUtilizationPct: 92,
    timeToFirstTokenMs: 650,
    p95TimeToFirstTokenMs: 1_200,
    requestsPerMinute: 7,
    predictedDemand: { concurrentSequences: 5, requestsPerMinute: 9, tokensPerSecond: 200 },
    observedAt: "2026-10-01T13:00:00.000Z",
    ...overrides,
  };
}

describe("inference autoscaling decision seam", () => {
  it("scales out under measured sequence saturation and exposes a reason", () => {
    const decision = decideInferenceCapacity(config, observation());
    expect(decision).toMatchObject({ action: "SCALE_OUT", desiredWorkerCount: 2, scaleOutReason: "measured_sequence_capacity_pressure" });
    expect(decision.metrics).toMatchObject({ gpuUtilizationPct: 88, vramUtilizationPct: 92, requestsPerMinute: 7 });
  });

  it("scales out when the oldest queued request exceeds the latency target", () => {
    const decision = decideInferenceCapacity(config, observation({
      workers: [{ workerId: "worker-a", state: "READY", activeSequences: 1, maxConcurrentSequences: 4, idleForMs: 0 }],
      oldestQueuedRequestMs: 2_500,
      queueDepth: 2,
    }));
    expect(decision.scaleOutReason).toBe("oldest_queued_request_exceeds_target_latency");
  });

  it("waits for a worker already inside its configured warmup window", () => {
    const decision = decideInferenceCapacity(config, observation({
      workers: [
        { workerId: "worker-a", state: "READY", activeSequences: 4, maxConcurrentSequences: 4, idleForMs: 0 },
        { workerId: "worker-b", state: "STARTING", activeSequences: 0, maxConcurrentSequences: 4, idleForMs: 0, stateDurationMs: 30_000 },
      ],
    }));
    expect(decision).toMatchObject({ action: "HOLD", desiredWorkerCount: 2, metrics: { startingWorkers: 1 } });
  });

  it("drains only idle workers and respects the warm-pool minimum", () => {
    const decision = decideInferenceCapacity(config, observation({
      workers: [
        { workerId: "worker-a", state: "READY", activeSequences: 0, maxConcurrentSequences: 4, idleForMs: 900_000 },
        { workerId: "worker-b", state: "READY", activeSequences: 0, maxConcurrentSequences: 4, idleForMs: 700_000 },
      ],
      gpuUtilizationPct: 2,
      vramUtilizationPct: 20,
      predictedDemand: {},
    }));
    expect(decision).toMatchObject({ action: "SCALE_IN", desiredWorkerCount: 1, workerIdsToDrain: ["worker-a"] });
  });

  it("uses the injected provider-neutral orchestrator for an actionable reconcile request", async () => {
    const decision = decideInferenceCapacity(config, observation());
    const orchestrator = { reconcile: vi.fn(async () => ({ startedWorkerIds: ["worker-b"], drainedWorkerIds: [], terminatedWorkerIds: [] })) };
    await expect(applyInferenceAutoscalingDecision(orchestrator, decision)).resolves.toMatchObject({ startedWorkerIds: ["worker-b"] });
    expect(orchestrator.reconcile).toHaveBeenCalledWith(2, "measured_sequence_capacity_pressure", { workerIdsToDrain: [] }, undefined);
  });
});
