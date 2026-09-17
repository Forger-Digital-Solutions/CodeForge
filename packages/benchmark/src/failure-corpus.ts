import type { CodeForgeBenchR2Attempt } from "./codeforge-bench-r2.js";

export const FAILURE_CORPUS_SCHEMA_VERSION = 1 as const;

export type FailureCorpusLayer =
  | "prompt"
  | "model"
  | "routing"
  | "context_retrieval"
  | "repository_intelligence"
  | "planning"
  | "tool_selection"
  | "edit_mechanism"
  | "subagent_coordination"
  | "forgegreen"
  | "verification"
  | "persistence_recovery"
  | "provider";

export interface FailureCorpusRecord {
  schemaVersion: typeof FAILURE_CORPUS_SCHEMA_VERSION;
  id: string;
  benchmarkVersion: "CodeForgeBench-R2";
  caseId: string;
  runId: string;
  recordedAt: string;
  repositoryCommit: string;
  model?: { providerId: string; modelId: string };
  route?: { requestedMode: string; selectedProviderId?: string; selectedModelId?: string; topology?: string };
  contextState: {
    filesRetrieved: number;
    contextTokens?: number;
    repeatedRetrievals?: number;
    staleRetrievals?: number;
  };
  tools: {
    totalCalls?: number;
    searches?: number;
    reads?: number;
    writes?: number;
    testCommands?: number;
    duplicateCalls?: number;
  };
  lastCorrectState: string;
  incorrectAction: string;
  verifierFindings: readonly string[];
  externalAgentResult?: "success" | "failure" | "not_tested" | "blocked";
  hypothesizedLayer: FailureCorpusLayer;
  sanitized: true;
  redactionNotes: string;
}

export interface FailureCorpusInput extends Omit<FailureCorpusRecord, "schemaVersion" | "benchmarkVersion" | "sanitized"> {
  sanitized: true;
}

export class FailureCorpusStore {
  private readonly records: FailureCorpusRecord[] = [];

  constructor(private readonly maxRecords = 5_000) {}

  record(input: FailureCorpusInput): FailureCorpusRecord {
    if (!input.id.trim() || !input.caseId.trim() || !input.runId.trim()) throw new Error("Failure corpus records require id, caseId, and runId");
    if (!input.repositoryCommit.trim()) throw new Error("Failure corpus records require repositoryCommit");
    if (!input.redactionNotes.trim()) throw new Error("Failure corpus records require redactionNotes");
    const record: FailureCorpusRecord = {
      ...input,
      schemaVersion: FAILURE_CORPUS_SCHEMA_VERSION,
      benchmarkVersion: "CodeForgeBench-R2",
      sanitized: true,
      verifierFindings: [...input.verifierFindings],
    };
    this.records.push(record);
    if (this.records.length > this.maxRecords) this.records.splice(0, this.records.length - this.maxRecords);
    return { ...record, verifierFindings: [...record.verifierFindings] };
  }

  list(): FailureCorpusRecord[] {
    return this.records.map((record) => ({ ...record, verifierFindings: [...record.verifierFindings] }));
  }
}

/** Converts an attempt into a corpus seed without copying model transcripts or provider text. */
export function failureCorpusSeedFromAttempt(attempt: CodeForgeBenchR2Attempt, layer: FailureCorpusLayer, redactionNotes: string): FailureCorpusInput {
  if (!attempt.failure) throw new Error(`Attempt ${attempt.runId} has no failure details`);
  return {
    id: `${attempt.runId}:${attempt.caseId}`,
    caseId: attempt.caseId,
    runId: attempt.runId,
    recordedAt: attempt.recordedAt,
    repositoryCommit: attempt.repositoryCommit,
    ...(attempt.model ? { model: { ...attempt.model } } : {}),
    ...(attempt.routing ? { route: { ...attempt.routing } } : {}),
    contextState: {
      filesRetrieved: attempt.metrics?.fileReads ?? 0,
      ...(attempt.metrics?.contextTokens !== undefined ? { contextTokens: attempt.metrics.contextTokens } : {}),
      ...(attempt.metrics?.repeatedSearches !== undefined ? { repeatedRetrievals: attempt.metrics.repeatedSearches } : {}),
    },
    tools: {
      ...(attempt.metrics?.toolCalls !== undefined ? { totalCalls: attempt.metrics.toolCalls } : {}),
      ...(attempt.metrics?.searches !== undefined ? { searches: attempt.metrics.searches } : {}),
      ...(attempt.metrics?.fileReads !== undefined ? { reads: attempt.metrics.fileReads } : {}),
    },
    lastCorrectState: attempt.failure.lastCorrectState ?? "unknown",
    incorrectAction: attempt.failure.incorrectAction ?? "unknown",
    verifierFindings: attempt.failure.verifierFindings ?? [],
    hypothesizedLayer: layer,
    sanitized: true,
    redactionNotes,
  };
}
