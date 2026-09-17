/**
 * CodeForgeBench R1 is a frozen, solution-neutral benchmark manifest for autonomous
 * engineering. Execution and grading remain external so a model's self-report is never
 * treated as a successful benchmark outcome.
 */
export const CODEFORGE_BENCH_R1_VERSION = "CodeForgeBench-R1" as const;

export type CodeForgeBenchCategory =
  | "repository_understanding"
  | "small_coding_fix"
  | "multi_file_engineering"
  | "debugging"
  | "test_repair"
  | "regression_prevention"
  | "large_repository"
  | "context_pressure"
  | "verification_resistance"
  | "recovery"
  | "tool_efficiency"
  | "routing_difficulty";

export type CodeForgeBenchDifficulty = "trivial" | "easy" | "medium" | "hard" | "very_hard";

export interface CodeForgeBenchCase {
  id: string;
  category: CodeForgeBenchCategory;
  difficulty: CodeForgeBenchDifficulty;
  fixture: "codeforge" | "synthetic";
  instructions: string;
  allowedTools: readonly string[];
  expectedBehavior: string;
  acceptance: readonly string[];
  expectedAffectedAreas: readonly string[];
  failureTraps: readonly string[];
}

export interface CodeForgeBenchAttempt {
  caseId: string;
  status: "completed" | "blocked" | "failed" | "cancelled" | "not_run";
  verified: boolean;
  hiddenAcceptance?: "passed" | "failed" | "not_run";
  model?: { providerId: string; modelId: string };
  topology?: string;
  metrics?: {
    inputTokens?: number;
    outputTokens?: number;
    contextTokens?: number;
    providerCalls?: number;
    toolCalls?: number;
    fileReads?: number;
    searches?: number;
    repeatedSearches?: number;
    retries?: number;
    wallTimeMs?: number;
    timeToFirstUsefulActionMs?: number;
    timeToFirstEditMs?: number;
    verificationMs?: number;
    estimatedCostUsd?: number;
  };
  reason?: string;
}

export interface CodeForgeBenchSummary {
  version: typeof CODEFORGE_BENCH_R1_VERSION;
  cases: number;
  attempts: number;
  verifiedSuccesses: number;
  successRate: number | null;
  unrun: number;
  byCategory: Record<CodeForgeBenchCategory, { attempts: number; verifiedSuccesses: number; successRate: number | null }>;
}

const tools = ["read_file", "search_files", "list_files", "edit_file", "run_command"] as const;

function benchCase(
  id: string,
  category: CodeForgeBenchCategory,
  difficulty: CodeForgeBenchDifficulty,
  instructions: string,
  expectedBehavior: string,
  acceptance: readonly string[],
  expectedAffectedAreas: readonly string[],
  failureTraps: readonly string[],
  fixture: "codeforge" | "synthetic" = "codeforge",
): CodeForgeBenchCase {
  return { id, category, difficulty, fixture, instructions, allowedTools: tools, expectedBehavior, acceptance, expectedAffectedAreas, failureTraps };
}

export const CODEFORGE_BENCH_R1_CASES: readonly CodeForgeBenchCase[] = [
  benchCase("CBR1-RU-01", "repository_understanding", "trivial", "Identify the authority that may transition a workflow run to completed.", "Reports the single completion authority with evidence.", ["Independent source assertion matches the reported authority."], ["packages/workflow/src"], ["Confusing a UI state update with completion authority."]),
  benchCase("CBR1-RU-02", "repository_understanding", "medium", "Trace the managed-free route selection path from eligibility through execution.", "Produces an ordered call chain and identifies every cost-boundary check.", ["Reviewer validates the chain against source.", "No paid or BYOK path is claimed to be managed-free."], ["packages/eight-bit/src", "packages/forge-zero/src", "packages/server/src"], ["Skipping the route qualification or adapter gate."]),
  benchCase("CBR1-SF-01", "small_coding_fix", "easy", "Repair a seeded serialization edge case while preserving the public schema.", "Makes the focused regression test pass with a minimal implementation change.", ["Focused test passes.", "Typecheck passes."], ["synthetic/serialization"], ["Changing the test or widening the schema."] , "synthetic"),
  benchCase("CBR1-SF-02", "small_coding_fix", "medium", "Repair a seeded provider error classification defect.", "Maps the provider response to the documented failure class.", ["Focused failure-matrix test passes.", "Existing unrelated classifications remain unchanged."], ["packages/providers/src", "packages/forge-zero/test"], ["Masking the error as unknown."]),
  benchCase("CBR1-MF-01", "multi_file_engineering", "hard", "Add a capability field that must remain consistent across a protocol schema, registry adapter, and receipt.", "Changes all required layers without a wire-format mismatch.", ["Typecheck passes.", "Contract test passes.", "Receipt test proves the field is recorded."], ["packages/protocol", "packages/model-registry", "packages/server"], ["Updating only the UI or only the provider adapter."]),
  benchCase("CBR1-MF-02", "multi_file_engineering", "very_hard", "Implement a seeded cross-package persistence change with restart behavior.", "Persists the requested state and restores it safely after restart.", ["Integration test passes.", "Restart test passes.", "No unauthorised migration bypass."], ["packages/sessions", "packages/server", "packages/workflow"], ["Passing in memory while losing state after restart."]),
  benchCase("CBR1-DB-01", "debugging", "medium", "Given a failing integration symptom, locate the earliest causal failure and propose a minimal repair.", "Finds the root cause and fixes it without changing the acceptance test.", ["Targeted regression test passes.", "Patch is reviewed for scope."], ["synthetic/debugging"], ["Treating the final error as the root cause."], "synthetic"),
  benchCase("CBR1-DB-02", "debugging", "hard", "Diagnose a failure that only appears after a provider failover.", "Preserves route receipts and repairs the actual failover transition.", ["Failover scenario passes.", "Receipt consistency assertion passes."], ["packages/eight-bit/src", "packages/server/src"], ["Retrying the original route indefinitely."]),
  benchCase("CBR1-TR-01", "test_repair", "easy", "Repair an implementation failure exposed by a protected test.", "Fixes production behavior without editing the protected test.", ["Protected test passes.", "Diff contains no test modification."], ["synthetic/test-repair"], ["Deleting or weakening the assertion."], "synthetic"),
  benchCase("CBR1-TR-02", "test_repair", "hard", "Repair a completion-gate defect exposed by a negative-path test.", "Keeps failed or unverified work terminally non-successful.", ["Negative-path suite passes.", "No route reaches completed without the gate."], ["packages/workflow/src", "packages/workflow/test"], ["Relaxing the gate to satisfy a happy-path test."]),
  benchCase("CBR1-RP-01", "regression_prevention", "medium", "Implement a small provider parsing repair and add a regression test that distinguishes the prior defect.", "Adds a focused, non-tautological test with the implementation fix.", ["New test fails before the fix and passes after it.", "Existing tests pass."], ["packages/providers/src", "packages/providers/test"], ["Writing a test that only restates implementation internals."]),
  benchCase("CBR1-RP-02", "regression_prevention", "hard", "Add coverage for a forged routing receipt while preserving receipt authority boundaries.", "Rejects a receipt that names a route different from the executor route.", ["Adversarial test passes.", "Valid receipts still pass."], ["packages/eight-bit/src", "packages/server/src"], ["Trusting user-provided receipt fields."]),
  benchCase("CBR1-LR-01", "large_repository", "hard", "Find the implementation owner for a narrow behavior in a large fixture without loading unrelated source.", "Uses targeted retrieval and identifies the correct owner.", ["Owner is independently validated.", "Context budget is recorded."], ["synthetic/large-repository"], ["Reading the entire fixture tree."], "synthetic"),
  benchCase("CBR1-LR-02", "large_repository", "very_hard", "Apply a one-file repair in a large fixture with duplicate symbols and generated files.", "Edits only the executable owner and verifies the repair.", ["Hidden acceptance passes.", "Generated files are untouched."], ["synthetic/large-repository"], ["Editing a generated or duplicate-name file."], "synthetic"),
  benchCase("CBR1-CP-01", "context_pressure", "hard", "Explain a behavior requiring evidence from distributed routing, persistence, and workflow modules under a context limit.", "Returns an evidence-backed explanation with bounded retrieval.", ["Source review validates each claim.", "Context usage is recorded."], ["packages/eight-bit", "packages/sessions", "packages/workflow"], ["Hallucinating relationships after truncation."]),
  benchCase("CBR1-CP-02", "context_pressure", "very_hard", "Plan a safe cross-package repair from a constrained capsule and retrieve only missing evidence.", "Produces a minimal executable plan that identifies uncertainty.", ["Plan review passes.", "No unsupported assumptions."], ["packages/server", "packages/workflow", "packages/protocol"], ["Treating the capsule as complete repository context."]),
  benchCase("CBR1-VR-01", "verification_resistance", "medium", "Repair a seeded defect where a plausible implementation makes a superficial test pass but violates a hidden requirement.", "Satisfies both visible and protected behavior.", ["Visible test passes.", "Hidden acceptance passes."], ["synthetic/verification-resistance"], ["Gaming the visible assertion."], "synthetic"),
  benchCase("CBR1-VR-02", "verification_resistance", "hard", "Complete a requested change whose claimed edit is absent from the final diff.", "Remains blocked rather than claiming completion.", ["Completion gate blocks the run.", "No completed state is emitted."], ["packages/workflow/src"], ["Claiming success based solely on passing tests."]),
  benchCase("CBR1-RC-01", "recovery", "medium", "Recover from an interruption before the first model call.", "Resumes only safe work and records recovery evidence.", ["Recovery test passes.", "No duplicate provider call."], ["packages/server/src", "packages/server/test"], ["Treating all interrupted work as safe to replay."]),
  benchCase("CBR1-RC-02", "recovery", "very_hard", "Recover from an ambiguous write after restart.", "Fails closed or replans without repeating the write.", ["Durable recovery test passes.", "No duplicate write."], ["packages/server/src", "packages/sessions/src"], ["Re-executing an unobserved mutation."]),
  benchCase("CBR1-TE-01", "tool_efficiency", "easy", "Locate a named symbol and its direct test using the fewest evidence-preserving tool calls.", "Finds both locations without redundant searches.", ["Locations are correct.", "Tool metrics are recorded."], ["packages/*"], ["Repeated identical searches."]),
  benchCase("CBR1-TE-02", "tool_efficiency", "hard", "Investigate a distributed bug while avoiding duplicate file reads and searches.", "Builds on prior observations and keeps a traceable tool ledger.", ["Root cause is correct.", "Repeated-search count is recorded."], ["packages/eight-bit", "packages/forge-zero", "packages/server"], ["Re-reading unchanged files without reason."]),
  benchCase("CBR1-RD-01", "routing_difficulty", "medium", "Select a managed-free route for a tool-using coding task from capability and health evidence.", "Selects only a qualified free route or returns no eligible route.", ["Zero-billing policy assertion passes.", "Selection receipt is consistent."], ["packages/eight-bit/src", "packages/forge-zero/src"], ["Choosing paid or BYOK as a free fallback."]),
  benchCase("CBR1-RD-02", "routing_difficulty", "hard", "Select a heterogeneous topology for a high-context repair under one degraded provider.", "Matches roles to eligible capability profiles and records failover rationale.", ["Synthetic router oracle passes.", "Unfinished GEMS profiles remain non-production."], ["packages/eight-bit/src", "packages/gems/src", "packages/paid-auto/src"], ["Treating a synthetic GEMS profile as executable."]),
];

export function summarizeCodeForgeBenchR1(attempts: readonly CodeForgeBenchAttempt[]): CodeForgeBenchSummary {
  const byCategory = Object.fromEntries(
    [...new Set(CODEFORGE_BENCH_R1_CASES.map((item) => item.category))].map((category) => [category, { attempts: 0, verifiedSuccesses: 0, successRate: null }]),
  ) as CodeForgeBenchSummary["byCategory"];
  const knownCases = new Map(CODEFORGE_BENCH_R1_CASES.map((item) => [item.id, item]));
  let verifiedSuccesses = 0;
  let unrun = 0;
  for (const attempt of attempts) {
    const benchmarkCase = knownCases.get(attempt.caseId);
    if (!benchmarkCase) throw new Error(`Unknown CodeForgeBench R1 case: ${attempt.caseId}`);
    if (attempt.status === "not_run") {
      unrun += 1;
      continue;
    }
    const bucket = byCategory[benchmarkCase.category];
    bucket.attempts += 1;
    if (attempt.verified && attempt.hiddenAcceptance !== "failed") {
      bucket.verifiedSuccesses += 1;
      verifiedSuccesses += 1;
    }
  }
  for (const bucket of Object.values(byCategory)) {
    bucket.successRate = bucket.attempts === 0 ? null : bucket.verifiedSuccesses / bucket.attempts;
  }
  const executed = attempts.length - unrun;
  return {
    version: CODEFORGE_BENCH_R1_VERSION,
    cases: CODEFORGE_BENCH_R1_CASES.length,
    attempts: attempts.length,
    verifiedSuccesses,
    successRate: executed === 0 ? null : verifiedSuccesses / executed,
    unrun,
    byCategory,
  };
}
