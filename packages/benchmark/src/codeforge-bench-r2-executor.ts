import { randomUUID } from "node:crypto";
import {
  CODEFORGE_BENCH_R2_CASES,
  CODEFORGE_BENCH_R2_PUBLIC_CASES,
  type CodeForgeBenchR2Attempt,
  type CodeForgeBenchR2Case,
  type CodeForgeBenchR2Split,
} from "./codeforge-bench-r2.js";

export interface CodeForgeBenchR2ExecutionContext {
  case: CodeForgeBenchR2Case;
  runId: string;
  attemptNumber: number;
  repositoryCommit: string;
  codeforgeCommit: string;
  configDigest: string;
  mode: CodeForgeBenchR2Attempt["mode"];
}

export type CodeForgeBenchR2ExecutionResult = Omit<CodeForgeBenchR2Attempt,
  "caseId" | "runId" | "attemptNumber" | "recordedAt" | "repositoryCommit" | "codeforgeCommit" | "configDigest" | "mode"
>;

/**
 * The adapter owns fixture provisioning, agent invocation, and independent verification. The
 * benchmark runner owns case selection, immutable traceability fields, and failure recording so
 * an adapter cannot silently omit a scheduled case.
 */
export interface CodeForgeBenchR2Executor {
  executeCase(context: CodeForgeBenchR2ExecutionContext): Promise<CodeForgeBenchR2ExecutionResult>;
}

export interface RunCodeForgeBenchR2CampaignInput {
  executor: CodeForgeBenchR2Executor;
  repositoryCommit: string;
  codeforgeCommit: string;
  configDigest: string;
  mode: CodeForgeBenchR2Attempt["mode"];
  split?: CodeForgeBenchR2Split | "ALL";
  includeProtected?: boolean;
  attemptNumber?: number;
  now?: () => Date;
  newRunId?: () => string;
}

function selectedCases(input: RunCodeForgeBenchR2CampaignInput): readonly CodeForgeBenchR2Case[] {
  if (input.split && input.split !== "ALL") return CODEFORGE_BENCH_R2_CASES.filter((item) => item.split === input.split);
  return input.includeProtected ? CODEFORGE_BENCH_R2_CASES : CODEFORGE_BENCH_R2_PUBLIC_CASES;
}

function assertTraceability(input: RunCodeForgeBenchR2CampaignInput): void {
  if (!input.repositoryCommit.trim()) throw new Error("repositoryCommit is required");
  if (!input.codeforgeCommit.trim()) throw new Error("codeforgeCommit is required");
  if (!input.configDigest.trim()) throw new Error("configDigest is required");
}

export async function runCodeForgeBenchR2Campaign(input: RunCodeForgeBenchR2CampaignInput): Promise<CodeForgeBenchR2Attempt[]> {
  assertTraceability(input);
  const now = input.now ?? (() => new Date());
  const newRunId = input.newRunId ?? randomUUID;
  const attemptNumber = input.attemptNumber ?? 1;
  if (!Number.isInteger(attemptNumber) || attemptNumber < 1) throw new Error("attemptNumber must be a positive integer");

  const attempts: CodeForgeBenchR2Attempt[] = [];
  for (const benchmarkCase of selectedCases(input)) {
    const context: CodeForgeBenchR2ExecutionContext = {
      case: benchmarkCase,
      runId: newRunId(),
      attemptNumber,
      repositoryCommit: input.repositoryCommit,
      codeforgeCommit: input.codeforgeCommit,
      configDigest: input.configDigest,
      mode: input.mode,
    };
    try {
      const result = await input.executor.executeCase(context);
      attempts.push({ ...result, ...context, caseId: benchmarkCase.id, recordedAt: now().toISOString() });
    } catch (error) {
      attempts.push({
        caseId: benchmarkCase.id,
        runId: context.runId,
        attemptNumber,
        recordedAt: now().toISOString(),
        repositoryCommit: input.repositoryCommit,
        codeforgeCommit: input.codeforgeCommit,
        mode: input.mode,
        configDigest: input.configDigest,
        status: "failed",
        verified: false,
        hiddenAcceptance: "not_run",
        reason: "Benchmark executor threw before independent verification completed.",
        failure: { failureMode: "executor_error", verifierFindings: [error instanceof Error ? error.message : String(error)] },
        verification: { verifierId: "not_run", visibleAcceptance: "not_run", protectedAcceptance: "not_run", forgeVerify: "not_run" },
      });
    }
  }
  return attempts;
}
