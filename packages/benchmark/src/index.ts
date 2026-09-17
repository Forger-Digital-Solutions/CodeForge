import crypto from "node:crypto";
import {
  ForgeEvalOutcomeSchema,
  ForgeEvalTopologySchema,
  TaskCapsuleSchema,
  type ForgeEvalExperimentWorkItem,
  type ForgeEvalOutcome,
  type ForgeEvalTopology,
  type TaskCapsule,
} from "@codeforge/protocol";

export interface TaskOutcome {
  taskId: string;
  modelId: string;
  taskType: string;
  result: string;
  retryCount: number;
  elapsedMs: number;
  topology?: ForgeEvalTopology;
  verified?: boolean;
  tokenCount?: number;
  toolCalls?: number;
  workerCount?: number;
}

export interface ForgeEvalOracle {
  id: string;
  tier: ForgeEvalOutcome["tier"];
  grade(input: { taskId: string; candidate: ForgeEvalCandidateResult }): Promise<Pick<ForgeEvalOutcome, "status" | "verified" | "score" | "reason">>;
}

export interface ForgeEvalCandidateResult {
  status: "completed" | "blocked" | "failed" | "cancelled";
  summary: string;
  modelId?: string;
  elapsedMs: number;
  retryCount: number;
  tokenCount?: number;
  toolCalls?: number;
  workerCount?: number;
  environmentalDifferences?: string[];
}

export interface MatchedExperimentInput {
  experimentId: string;
  sessionId?: string;
  taskId: string;
  taskType: string;
  capsule: TaskCapsule;
  startingStateDigest: string;
  control: { topology: ForgeEvalTopology; execute: () => Promise<ForgeEvalCandidateResult> };
  treatment: { topology: ForgeEvalTopology; execute: () => Promise<ForgeEvalCandidateResult> };
  oracle: ForgeEvalOracle;
  environmentalDifferences?: string[];
}

export interface MatchedExperimentResult {
  experimentId: string;
  taskId: string;
  taskType: string;
  capsuleDigest: string;
  startingStateDigest: string;
  controlTopology: ForgeEvalTopology;
  treatmentTopology: ForgeEvalTopology;
  control: ForgeEvalOutcome;
  treatment: ForgeEvalOutcome;
  environmentalDifferences: string[];
  experiment: ForgeEvalExperimentWorkItem;
  status: "graded";
}

function digest(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export class BenchmarkStore {
  private readonly outcomes: TaskOutcome[] = [];
  private readonly experiments: ForgeEvalExperimentWorkItem[] = [];

  constructor(private readonly maxRecords = 5_000) {}

  record(outcome: TaskOutcome): void {
    this.outcomes.push({ ...outcome });
    if (this.outcomes.length > this.maxRecords) this.outcomes.splice(0, this.outcomes.length - this.maxRecords);
  }

  list(): TaskOutcome[] {
    return this.outcomes.map((outcome) => ({ ...outcome }));
  }

  recordExperiment(experiment: ForgeEvalExperimentWorkItem): void {
    this.experiments.push({ ...experiment });
    if (this.experiments.length > this.maxRecords) this.experiments.splice(0, this.experiments.length - this.maxRecords);
  }

  listExperiments(): ForgeEvalExperimentWorkItem[] {
    return this.experiments.map((experiment) => ({ ...experiment }));
  }

  scoreFor(modelId: string, taskType: string): number {
    const matching = this.outcomes.filter((outcome) => outcome.modelId === modelId && outcome.taskType === taskType);
    if (matching.length === 0) return 0;
    return matching.filter((outcome) => outcome.verified === true).length / matching.length;
  }
}

/**
 * Runs a sampled matched comparison. The caller supplies independent execution and oracle
 * functions; this harness records outcomes but never treats execution completion as correctness.
 */
export class ForgeEvalHarness {
  constructor(private readonly store = new BenchmarkStore()) {}

  get benchmarkStore(): BenchmarkStore {
    return this.store;
  }

  async runMatchedExperiment(input: MatchedExperimentInput): Promise<MatchedExperimentResult> {
    const capsule = TaskCapsuleSchema.parse(input.capsule);
    const controlTopology = ForgeEvalTopologySchema.parse(input.control.topology);
    const treatmentTopology = ForgeEvalTopologySchema.parse(input.treatment.topology);
    const [controlResult, treatmentResult] = await Promise.all([
      input.control.execute(),
      input.treatment.execute(),
    ]);
    const [controlGrade, treatmentGrade] = await Promise.all([
      input.oracle.grade({ taskId: input.taskId, candidate: controlResult }),
      input.oracle.grade({ taskId: input.taskId, candidate: treatmentResult }),
    ]);
    const control = ForgeEvalOutcomeSchema.parse({ ...controlGrade, oracleId: input.oracle.id, tier: input.oracle.tier });
    const treatment = ForgeEvalOutcomeSchema.parse({ ...treatmentGrade, oracleId: input.oracle.id, tier: input.oracle.tier });
    const environmentalDifferences = [
      ...(input.environmentalDifferences ?? []),
      ...(controlResult.environmentalDifferences ?? []),
      ...(treatmentResult.environmentalDifferences ?? []),
    ];
    const uniqueEnvironmentalDifferences = [...new Set(environmentalDifferences)];
    const capsuleDigest = digest(capsule);
    const now = new Date().toISOString();

    this.store.record({
      taskId: input.taskId,
      modelId: controlResult.modelId ?? "unknown",
      taskType: input.taskType,
      result: controlResult.summary,
      retryCount: controlResult.retryCount,
      elapsedMs: controlResult.elapsedMs,
      topology: controlTopology,
      verified: control.verified,
      ...(controlResult.tokenCount !== undefined ? { tokenCount: controlResult.tokenCount } : {}),
      ...(controlResult.toolCalls !== undefined ? { toolCalls: controlResult.toolCalls } : {}),
      ...(controlResult.workerCount !== undefined ? { workerCount: controlResult.workerCount } : {}),
    });
    this.store.record({
      taskId: input.taskId,
      modelId: treatmentResult.modelId ?? "unknown",
      taskType: input.taskType,
      result: treatmentResult.summary,
      retryCount: treatmentResult.retryCount,
      elapsedMs: treatmentResult.elapsedMs,
      topology: treatmentTopology,
      verified: treatment.verified,
      ...(treatmentResult.tokenCount !== undefined ? { tokenCount: treatmentResult.tokenCount } : {}),
      ...(treatmentResult.toolCalls !== undefined ? { toolCalls: treatmentResult.toolCalls } : {}),
      ...(treatmentResult.workerCount !== undefined ? { workerCount: treatmentResult.workerCount } : {}),
    });

    const experiment: ForgeEvalExperimentWorkItem = {
      kind: "forgeeval_experiment",
      id: input.experimentId,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      taskId: input.taskId,
      taskType: input.taskType,
      capsuleDigest,
      startingStateDigest: input.startingStateDigest,
      controlTopology,
      treatmentTopology,
      control,
      treatment,
      environmentalDifferences: uniqueEnvironmentalDifferences,
      status: "graded",
      createdAt: now,
      updatedAt: now,
    };
    this.store.recordExperiment(experiment);

    return {
      experimentId: input.experimentId,
      taskId: input.taskId,
      taskType: input.taskType,
      capsuleDigest,
      startingStateDigest: input.startingStateDigest,
      controlTopology,
      treatmentTopology,
      control,
      treatment,
      environmentalDifferences: uniqueEnvironmentalDifferences,
      experiment,
      status: "graded",
    };
  }
}

export * from "./r3-corpus.js";
export * from "./codeforge-bench-r1.js";
