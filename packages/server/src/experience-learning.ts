import { createHash } from "node:crypto";
import type { AutonomousRun } from "./autonomous-orchestrator.js";

export type ExperienceLabel = "VERIFIED_SUCCESS" | "VERIFIED_FAILURE" | "BLOCKED_EXTERNAL" | "PROVIDER_FAILURE" | "STRATEGY_EXHAUSTED" | "USER_ABORT" | "INFRA_FAILURE" | "UNKNOWN";

export interface ExperienceWorker {
  kind: "subagent_run";
  id: string;
  sessionId: string;
  parentRunId: string;
  role: string;
  status: string;
  model?: { providerId: string; modelId: string };
  telemetry?: { wallTimeMs?: number; modelRequests?: number; inputTokens?: number; outputTokens?: number; toolCalls?: number; retryCount?: number; providerFailures?: number };
}

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const count = (value: number | undefined): number => Number.isSafeInteger(value) && value! >= 0 ? value! : 0;
const bucket = (value: number): string => value === 0 ? "0" : value <= 10 ? "1-10" : value <= 100 ? "11-100" : value <= 1_000 ? "101-1000" : "1000+";

export function experienceLabel(run: AutonomousRun): ExperienceLabel {
  if (run.status === "completed" && run.result?.completion?.outcome === "completed" && run.result.integration.status === "integrated") return "VERIFIED_SUCCESS";
  if (run.status === "cancelled") return "USER_ABORT";
  if (run.error === "VERIFICATION_FAILED" || run.error?.startsWith("COMPLETION_GATE_")) return "VERIFIED_FAILURE";
  if (run.error === "STRATEGY_EXHAUSTED") return "STRATEGY_EXHAUSTED";
  if (/NO_ELIGIBLE_ROUTE|ROSTER_NO_ADMITTED_ROUTE|CAPACITY/i.test(run.error ?? "")) return "BLOCKED_EXTERNAL";
  if (/PROVIDER_|RATE_LIMITED|QUOTA_/i.test(run.error ?? "")) return "PROVIDER_FAILURE";
  if (run.status === "failed") return "INFRA_FAILURE";
  return "UNKNOWN";
}

/** Only enumerated and numeric values cross into generalized learning. No prompt, path,
 * transcript, model name, endpoint, finding text, or owner identifier can enter this object. */
export function buildExperienceReceipt(run: AutonomousRun, workers: readonly ExperienceWorker[]): {
  local: Record<string, unknown>;
  generalized: Record<string, unknown>;
} {
  const scoped = workers.filter((worker) => worker.kind === "subagent_run" && worker.parentRunId === run.id && worker.sessionId === run.sessionId);
  const totals = scoped.reduce((sum, worker) => ({
    modelRequests: sum.modelRequests + count(worker.telemetry?.modelRequests),
    toolCalls: sum.toolCalls + count(worker.telemetry?.toolCalls),
    retries: sum.retries + count(worker.telemetry?.retryCount),
    inputTokens: sum.inputTokens + count(worker.telemetry?.inputTokens),
    outputTokens: sum.outputTokens + count(worker.telemetry?.outputTokens),
    providerFailures: sum.providerFailures + count(worker.telemetry?.providerFailures),
  }), { modelRequests: 0, toolCalls: 0, retries: 0, inputTokens: 0, outputTokens: 0, providerFailures: 0 });
  const label = experienceLabel(run);
  const generalized = {
    schemaVersion: "r57-experience-signal/v1",
    label,
    taskClass: run.topology?.complexity.tier ?? "unknown",
    repositorySizeBucket: bucket(count(run.topology?.repositoryFileCount)),
    changeSizeBucket: bucket(run.result?.changedFiles.length ?? 0),
    reviewRounds: count(run.reviewRounds),
    verificationAttempts: count(run.result?.counters.verificationAttempts),
    verificationPassed: label === "VERIFIED_SUCCESS",
    ...totals,
    workerCount: scoped.length,
    roles: scoped.map((worker) => ["explorer", "planner", "coder", "reviewer"].includes(worker.role) ? worker.role : "other"),
  };
  return {
    local: {
      schemaVersion: "r57-experience-receipt/v1",
      runId: run.id,
      sessionRef: digest(run.sessionId),
      workItemId: run.id,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      status: run.status,
      label,
      completionOutcome: run.result?.completion?.outcome ?? null,
      integrationStatus: run.result?.integration.status ?? null,
      workers: scoped.map((worker) => ({
        id: worker.id,
        role: ["explorer", "planner", "coder", "reviewer"].includes(worker.role) ? worker.role : "other",
        status: ["completed", "blocked", "failed", "cancelled"].includes(worker.status) ? worker.status : "unknown",
        routeRef: worker.model ? digest(`${worker.model.providerId}/${worker.model.modelId}`) : null,
        telemetry: {
          wallTimeMs: count(worker.telemetry?.wallTimeMs),
          modelRequests: count(worker.telemetry?.modelRequests),
          inputTokens: count(worker.telemetry?.inputTokens),
          outputTokens: count(worker.telemetry?.outputTokens),
          toolCalls: count(worker.telemetry?.toolCalls),
          retries: count(worker.telemetry?.retryCount),
          providerFailures: count(worker.telemetry?.providerFailures),
        },
      })),
      signal: generalized,
    },
    generalized,
  };
}

export interface RecoveryAdvice {
  action: "STANDARD" | "INDEPENDENT_DIAGNOSIS";
  supportingSamples: number;
  confidence: number;
  reason: string;
}

/** Bounded, reconstructable advice from abstract outcomes. It cannot select a route or
 * change admission, verification, money, or source authority. One outlier has no effect. */
export function adviseFromExperience(signals: readonly Record<string, unknown>[], taskClass: string): RecoveryAdvice {
  const comparable = signals.filter((signal) => signal.schemaVersion === "r57-experience-signal/v1" && signal.taskClass === taskClass).slice(-100);
  const exhausted = comparable.filter((signal) => signal.label === "STRATEGY_EXHAUSTED").length;
  const verified = comparable.filter((signal) => signal.label === "VERIFIED_SUCCESS").length;
  if (exhausted >= 2 && exhausted > verified) {
    return { action: "INDEPENDENT_DIAGNOSIS", supportingSamples: comparable.length, confidence: Math.min(0.75, exhausted / (exhausted + verified + 4)), reason: "Repeated strategy exhaustion on comparable task classes" };
  }
  return { action: "STANDARD", supportingSamples: comparable.length, confidence: Math.min(0.75, comparable.length / (comparable.length + 8)), reason: "Insufficient repeated exhaustion evidence" };
}
