export interface AutoscalingConfig {
  minWorkers: number;
  maxWorkers: number;
  targetQueueLatencyMs: number;
  scaleOutThreshold: number;
  scaleInIdleDurationMs: number;
  workerWarmupTimeMs: number;
}

export interface AutoscalingWorkerState {
  workerId: string;
  state: "READY" | "STARTING" | "DRAINING";
  activeSequences: number;
  maxConcurrentSequences: number;
  idleForMs: number;
  stateDurationMs?: number;
}

export interface AutoscalingObservation {
  workers: AutoscalingWorkerState[];
  queueDepth: number;
  oldestQueuedRequestMs: number;
  tokensPerSecond: number;
  gpuUtilizationPct: number | null;
  vramUtilizationPct: number | null;
  timeToFirstTokenMs: number | null;
  p95TimeToFirstTokenMs: number | null;
  requestsPerMinute: number;
  predictedDemand: {
    concurrentSequences?: number;
    requestsPerMinute?: number;
    tokensPerSecond?: number;
  };
  observedAt: string;
}

export interface AutoscalingDecision {
  observedAt: string;
  action: "HOLD" | "SCALE_OUT" | "SCALE_IN";
  desiredWorkerCount: number;
  scaleOutReason?: string;
  scaleInReason?: string;
  workerIdsToDrain: string[];
  metrics: {
    readyWorkers: number;
    startingWorkers: number;
    activeSequences: number;
    queueDepth: number;
    oldestQueuedRequestMs: number;
    tokensPerSecond: number;
    gpuUtilizationPct: number | null;
    vramUtilizationPct: number | null;
    timeToFirstTokenMs: number | null;
    p95TimeToFirstTokenMs: number | null;
    requestsPerMinute: number;
    predictedDemand: AutoscalingObservation["predictedDemand"];
  };
}

export interface InferenceWorkerOrchestrator {
  reconcile(desiredWorkerCount: number, reason: string, options: { workerIdsToDrain: string[] }, signal?: AbortSignal): Promise<{
    startedWorkerIds: string[];
    drainedWorkerIds: string[];
    terminatedWorkerIds: string[];
  }>;
}

export function decideInferenceCapacity(
  config: AutoscalingConfig,
  observation: AutoscalingObservation,
): AutoscalingDecision {
  validateConfig(config);
  validateObservation(observation);

  const ready = observation.workers.filter((worker) => worker.state === "READY");
  const startingWorkers = observation.workers.filter((worker) => worker.state === "STARTING");
  const starting = startingWorkers.length;
  const activeSequences = ready.reduce((sum, worker) => sum + worker.activeSequences, 0);
  const sequenceCapacity = ready.reduce((sum, worker) => sum + worker.maxConcurrentSequences, 0);
  const fallbackSequencesPerWorker = Math.max(1, Math.floor(
    ready.reduce((sum, worker) => sum + worker.maxConcurrentSequences, 0) / Math.max(1, ready.length),
  ));
  const sequenceDemand = Math.max(
    activeSequences + observation.queueDepth,
    observation.predictedDemand.concurrentSequences ?? 0,
  );
  const demandFromSequences = Math.ceil(sequenceDemand / fallbackSequencesPerWorker);
  const measuredTokensPerWorker = ready.length > 0 ? observation.tokensPerSecond / ready.length : 0;
  const predictedTokensPerSecond = observation.predictedDemand.tokensPerSecond ?? 0;
  const demandFromTokens = measuredTokensPerWorker > 0
    ? Math.ceil(predictedTokensPerSecond / measuredTokensPerWorker)
    : 0;
  const minimum = config.minWorkers;
  const current = ready.length + starting;
  let desiredWorkerCount = Math.max(minimum, Math.min(config.maxWorkers, demandFromSequences, demandFromTokens || config.maxWorkers));
  const readyUtilization = sequenceCapacity > 0 ? activeSequences / sequenceCapacity : 0;
  const capacityPressure = ready.length === 0 ||
    (sequenceCapacity > 0 && readyUtilization >= config.scaleOutThreshold) ||
    (sequenceCapacity > 0 && sequenceDemand >= sequenceCapacity * config.scaleOutThreshold) ||
    observation.oldestQueuedRequestMs >= config.targetQueueLatencyMs ||
    (observation.queueDepth > 0 && (observation.p95TimeToFirstTokenMs ?? 0) >= config.targetQueueLatencyMs);

  let action: AutoscalingDecision["action"] = "HOLD";
  let scaleOutReason: string | undefined;
  let scaleInReason: string | undefined;
  const workerIdsToDrain: string[] = [];

  const warmupInFlight = startingWorkers.some((worker) => (worker.stateDurationMs ?? 0) < config.workerWarmupTimeMs);
  if (capacityPressure && current < config.maxWorkers && !warmupInFlight) {
    desiredWorkerCount = Math.min(config.maxWorkers, Math.max(current + 1, desiredWorkerCount));
    action = "SCALE_OUT";
    scaleOutReason = observation.oldestQueuedRequestMs >= config.targetQueueLatencyMs
      ? "oldest_queued_request_exceeds_target_latency"
      : ready.length === 0
        ? "no_ready_workers"
        : observation.queueDepth > 0
          ? "queue_and_capacity_pressure"
          : "measured_sequence_capacity_pressure";
  } else if (
    ready.length > minimum &&
    observation.queueDepth === 0 &&
    activeSequences === 0 &&
    ready.some((worker) => worker.idleForMs >= config.scaleInIdleDurationMs)
  ) {
    const eligible = ready
      .filter((worker) => worker.activeSequences === 0 && worker.idleForMs >= config.scaleInIdleDurationMs)
      .sort((a, b) => b.idleForMs - a.idleForMs);
    const removable = Math.min(eligible.length, ready.length - minimum);
    workerIdsToDrain.push(...eligible.slice(0, removable).map((worker) => worker.workerId));
    desiredWorkerCount = Math.max(minimum, current - workerIdsToDrain.length);
    action = "SCALE_IN";
    scaleInReason = "idle_workers_exceed_configured_scale_in_duration";
  }
  if (action === "HOLD") desiredWorkerCount = Math.max(minimum, Math.min(config.maxWorkers, current));

  return {
    observedAt: observation.observedAt,
    action,
    desiredWorkerCount,
    ...(scaleOutReason ? { scaleOutReason } : {}),
    ...(scaleInReason ? { scaleInReason } : {}),
    workerIdsToDrain,
    metrics: {
      readyWorkers: ready.length,
      startingWorkers: starting,
      activeSequences,
      queueDepth: observation.queueDepth,
      oldestQueuedRequestMs: observation.oldestQueuedRequestMs,
      tokensPerSecond: observation.tokensPerSecond,
      gpuUtilizationPct: observation.gpuUtilizationPct,
      vramUtilizationPct: observation.vramUtilizationPct,
      timeToFirstTokenMs: observation.timeToFirstTokenMs,
      p95TimeToFirstTokenMs: observation.p95TimeToFirstTokenMs,
      requestsPerMinute: observation.requestsPerMinute,
      predictedDemand: observation.predictedDemand,
    },
  };
}

export async function applyInferenceAutoscalingDecision(
  orchestrator: InferenceWorkerOrchestrator,
  decision: AutoscalingDecision,
  signal?: AbortSignal,
): Promise<Awaited<ReturnType<InferenceWorkerOrchestrator["reconcile"]>> | undefined> {
  if (decision.action === "HOLD") return undefined;
  const reason = decision.action === "SCALE_OUT" ? decision.scaleOutReason! : decision.scaleInReason!;
  return orchestrator.reconcile(decision.desiredWorkerCount, reason, { workerIdsToDrain: decision.workerIdsToDrain }, signal);
}

function validateConfig(config: AutoscalingConfig): void {
  if (!Number.isInteger(config.minWorkers) || !Number.isInteger(config.maxWorkers) || config.minWorkers < 0 || config.maxWorkers < config.minWorkers) {
    throw new Error("Autoscaling worker bounds are invalid");
  }
  if (config.targetQueueLatencyMs <= 0 || config.scaleInIdleDurationMs < 0 || config.workerWarmupTimeMs < 0) {
    throw new Error("Autoscaling durations must be non-negative and target latency must be positive");
  }
  if (config.scaleOutThreshold < 0 || config.scaleOutThreshold > 1) throw new Error("scaleOutThreshold must be in [0, 1]");
}

function validateObservation(observation: AutoscalingObservation): void {
  const nonNegative = [observation.queueDepth, observation.oldestQueuedRequestMs, observation.tokensPerSecond, observation.requestsPerMinute];
  if (nonNegative.some((value) => !Number.isFinite(value) || value < 0)) throw new Error("Autoscaling metrics must be finite and non-negative");
  for (const worker of observation.workers) {
    if (!Number.isInteger(worker.activeSequences) || worker.activeSequences < 0 || !Number.isInteger(worker.maxConcurrentSequences) || worker.maxConcurrentSequences < 1 || worker.idleForMs < 0) {
      throw new Error("Autoscaling worker capacity metrics are invalid");
    }
  }
}
