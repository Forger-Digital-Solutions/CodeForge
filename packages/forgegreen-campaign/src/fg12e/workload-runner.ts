import type { Verifier } from "@codeforge/workflow";
import { alternatingOrder, asGeneric, currentInputStateHash, produceBaselineEvidence, runPair, type PairReceipt } from "./pair-runner.js";
import { round } from "./timing.js";
import {
  benchVerifiers,
  disposeBenchWorkspace,
  materializeBenchWorkspace,
  mutateBenchWorkspace,
  readBenchWorkspaceFile,
  toVerifier,
  type BenchVerifier,
  type BenchWorkload,
  type BenchWorkspace,
  type CostTier,
} from "./workloads.js";

export interface StateDriftCheck {
  controlBefore: string;
  controlAfter: string;
  treatmentBefore: string;
  treatmentAfter: string;
  drifted: boolean;
}

export interface WorkloadResult {
  workload: BenchWorkload;
  /** The unscored run that produced the prior evidence; its verifier elapsed time is the only
   * genuinely COLD verifier observation for this workload and is recorded as such. */
  baseline: { wallMs: number; coldVerifierElapsedMs: number; evidenceIds: string[] };
  warmupReceipts: PairReceipt[];
  scoredReceipts: PairReceipt[];
  stateDrift: StateDriftCheck;
  /** False when any scored pair failed a safety check or the workspace drifted — such a workload
   * contributes NO performance numbers to the break-even model. */
  valid: boolean;
  invalidReasons: string[];
}

function resolveWorkspaces(workload: { workspace: BenchWorkload["workspace"] }, repoRoot: string): { control: BenchWorkspace; treatment: BenchWorkspace; dispose: () => void } {
  if (workload.workspace === "repo-root") {
    const repo: BenchWorkspace = { root: repoRoot, kind: "repo-root" };
    return { control: repo, treatment: repo, dispose: () => undefined };
  }
  const control = materializeBenchWorkspace();
  const treatment = materializeBenchWorkspace();
  return {
    control,
    treatment,
    dispose: () => {
      disposeBenchWorkspace(control);
      disposeBenchWorkspace(treatment);
    },
  };
}

export interface PairedSeriesParams {
  workloadId: string;
  expectedTier: CostTier;
  control: BenchWorkspace;
  treatment: BenchWorkspace;
  /** Verifiers whose evidence the treatment arm is offered (produced fresh on `treatment`). */
  baselineVerifiers: Verifier[];
  /** Verifiers both arms plan against. */
  planVerifiers: Verifier[];
  expectedReusedVerifierIds: string[];
  warmupRepetitions: number;
  scoredRepetitions: number;
  /** Applied to the treatment workspace AFTER baseline evidence exists and BEFORE any pair runs. */
  mutateTreatmentAfterBaseline?: (treatment: BenchWorkspace) => void;
  /** Transform the baseline evidence before offering it (e.g. tamper a field, drop a field). */
  transformPriorEvidence?: (evidence: ReturnType<typeof asGeneric>) => ReturnType<typeof asGeneric>;
  allowFailedOutcome?: boolean;
}

export interface PairedSeriesResult {
  baseline: WorkloadResult["baseline"];
  warmupReceipts: PairReceipt[];
  scoredReceipts: PairReceipt[];
  stateDrift: StateDriftCheck;
}

/** Baseline -> optional mutation -> warmups -> scored pairs in alternating order, with a state
 * hash captured before and after so any drift invalidates the series (spec §6-§8). */
export async function runPairedSeries(params: PairedSeriesParams): Promise<PairedSeriesResult> {
  const baseline = await produceBaselineEvidence(params.treatment, params.baselineVerifiers, `fg12e-baseline-${params.workloadId}`);
  const coldVerifierElapsedMs = round(baseline.evidence.reduce((s, e) => s + e.elapsedMs, 0));
  params.mutateTreatmentAfterBaseline?.(params.treatment);
  const priorEvidence = params.transformPriorEvidence ? params.transformPriorEvidence(asGeneric(baseline.evidence)) : asGeneric(baseline.evidence);

  const controlBefore = currentInputStateHash(params.control);
  const treatmentBefore = currentInputStateHash(params.treatment);

  const common = {
    workloadId: params.workloadId,
    expectedTier: params.expectedTier,
    controlWorkspace: params.control,
    treatmentWorkspace: params.treatment,
    planVerifiers: params.planVerifiers,
    priorEvidence,
    expectedReusedVerifierIds: params.expectedReusedVerifierIds,
    allowFailedOutcome: params.allowFailedOutcome,
  };

  const warmupReceipts: PairReceipt[] = [];
  for (let i = 0; i < params.warmupRepetitions; i += 1) {
    warmupReceipts.push(await runPair({ ...common, pairIndex: i, scored: false, warm: "cold", order: alternatingOrder(i) }));
  }
  const scoredReceipts: PairReceipt[] = [];
  for (let i = 0; i < params.scoredRepetitions; i += 1) {
    scoredReceipts.push(await runPair({ ...common, pairIndex: i, scored: true, warm: "warm", order: alternatingOrder(i + params.warmupRepetitions) }));
  }

  const controlAfter = currentInputStateHash(params.control);
  const treatmentAfter = currentInputStateHash(params.treatment);
  return {
    baseline: { wallMs: baseline.wallMs, coldVerifierElapsedMs, evidenceIds: baseline.evidence.map((e) => e.evidenceId) },
    warmupReceipts,
    scoredReceipts,
    stateDrift: { controlBefore, controlAfter, treatmentBefore, treatmentAfter, drifted: controlBefore !== controlAfter || treatmentBefore !== treatmentAfter },
  };
}

export async function runBreakEvenWorkload(workload: BenchWorkload, repoRoot: string): Promise<WorkloadResult> {
  const workspaces = resolveWorkspaces(workload, repoRoot);
  try {
    const verifiers = workload.verifiers.map((v) => toVerifier(v));
    const series = await runPairedSeries({
      workloadId: workload.id,
      expectedTier: workload.expectedTier,
      control: workspaces.control,
      treatment: workspaces.treatment,
      baselineVerifiers: verifiers,
      planVerifiers: verifiers,
      expectedReusedVerifierIds: verifiers.map((v) => v.id),
      warmupRepetitions: workload.warmupRepetitions,
      scoredRepetitions: workload.scoredRepetitions,
    });
    const invalidReasons: string[] = [];
    for (const receipt of series.scoredReceipts) if (!receipt.safety.passed) invalidReasons.push(`pair ${receipt.pairIndex}: ${receipt.safety.failureReasons.join("; ")}`);
    if (series.stateDrift.drifted) invalidReasons.push("workspace input-state hash drifted during the series");
    return { workload, ...series, valid: invalidReasons.length === 0, invalidReasons };
  } finally {
    workspaces.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// Multi-verifier compositions with partial reuse (spec §15/§16).
// ---------------------------------------------------------------------------------------------

export interface CompositionScenario {
  id: string;
  label: string;
  verifiers: BenchVerifier[];
  /** Verifier ids whose prior evidence is deliberately invalidated by a real definition change
   * (a different but equivalent-output command) so they must execute fresh. */
  invalidatedVerifierIds: string[];
  scoredRepetitions: number;
  warmupRepetitions: number;
}

export interface CompositionResult extends PairedSeriesResult {
  scenario: CompositionScenario;
  plannedCount: number;
  reusableCount: number;
  /** Count share of verifiers reusable (0, 0.25, 0.5, 0.75, 1 for the 4-verifier ladder). */
  countShareReusable: number;
  /** Runtime-weighted share: control child-process time of the reusable verifiers over control
   * child-process time of all verifiers (median across scored pairs). */
  weightedRuntimeShareReusable: number;
  valid: boolean;
  invalidReasons: string[];
}

/** The non-reusable verifiers get a real definition change: node's `--test-reporter=tap` (output
 * format only — the test work is identical). Their evidence is therefore invalid by definition
 * digest and must execute fresh, exactly like a changed verifier definition in production. */
export function definitionChangedCommand(command: string): string {
  if (command.startsWith("node --test ")) return command.replace("node --test ", "node --test --test-reporter=tap ");
  if (command.includes("/bin/tsc ")) return `${command} --pretty false`;
  if (command.startsWith("node --check ")) return command.replace("node --check ", "node --stack-trace-limit=64 --check ");
  throw new Error(`no equivalent-output definition change known for: ${command}`);
}

export function buildCompositionScenarios(repoRoot: string): CompositionScenario[] {
  const v = benchVerifiers(repoRoot);
  const groups = [v.testGroupA!, v.testGroupB!, v.testGroupC!, v.testGroupD!];
  const ladder: CompositionScenario[] = [0, 1, 2, 3, 4].map((reusable) => ({
    id: `composition-equal-cost-${reusable * 25}pct`,
    label: `4 equal-cost node:test groups, ${reusable * 25}% reusable`,
    verifiers: groups,
    invalidatedVerifierIds: groups.slice(reusable).map((g) => g.id),
    scoredRepetitions: 5,
    warmupRepetitions: 1,
  }));
  const mixed = [v.typecheck!, v.testGroupA!, v.syntaxCheck!];
  const mixedScenarios: CompositionScenario[] = [
    { id: "composition-mixed-reuse-expensive-only", label: "mixed cost [tsc, 4-file tests, syntax]: only tsc reusable", verifiers: mixed, invalidatedVerifierIds: [v.testGroupA!.id, v.syntaxCheck!.id], scoredRepetitions: 5, warmupRepetitions: 1 },
    { id: "composition-mixed-reuse-cheap-only", label: "mixed cost [tsc, 4-file tests, syntax]: only syntax check reusable", verifiers: mixed, invalidatedVerifierIds: [v.typecheck!.id, v.testGroupA!.id], scoredRepetitions: 5, warmupRepetitions: 1 },
    { id: "composition-mixed-reuse-all", label: "mixed cost [tsc, 4-file tests, syntax]: all reusable", verifiers: mixed, invalidatedVerifierIds: [], scoredRepetitions: 5, warmupRepetitions: 1 },
  ];
  return [...ladder, ...mixedScenarios];
}

export async function runCompositionScenario(scenario: CompositionScenario): Promise<CompositionResult> {
  const control = materializeBenchWorkspace();
  const treatment = materializeBenchWorkspace();
  try {
    const baselineVerifiers = scenario.verifiers.map((v) => toVerifier(v));
    const planVerifiers = scenario.verifiers.map((v) => (scenario.invalidatedVerifierIds.includes(v.id) ? toVerifier({ ...v, command: definitionChangedCommand(v.command) }) : toVerifier(v)));
    const expectedReused = scenario.verifiers.filter((v) => !scenario.invalidatedVerifierIds.includes(v.id)).map((v) => v.id);
    const series = await runPairedSeries({
      workloadId: scenario.id,
      expectedTier: "MODERATE",
      control,
      treatment,
      baselineVerifiers,
      planVerifiers,
      expectedReusedVerifierIds: expectedReused,
      warmupRepetitions: scenario.warmupRepetitions,
      scoredRepetitions: scenario.scoredRepetitions,
    });
    const invalidReasons: string[] = [];
    for (const receipt of series.scoredReceipts) if (!receipt.safety.passed) invalidReasons.push(`pair ${receipt.pairIndex}: ${receipt.safety.failureReasons.join("; ")}`);
    if (series.stateDrift.drifted) invalidReasons.push("workspace input-state hash drifted during the series");
    const shares = series.scoredReceipts.map((r) => {
      const total = r.control.verifierExecutionMs;
      return total > 0 ? r.verificationSavedReferenceMs / total : 0;
    });
    const sortedShares = [...shares].sort((a, b) => a - b);
    const weighted = sortedShares.length > 0 ? sortedShares[Math.floor(sortedShares.length / 2)]! : 0;
    return {
      scenario,
      ...series,
      plannedCount: scenario.verifiers.length,
      reusableCount: expectedReused.length,
      countShareReusable: round(expectedReused.length / scenario.verifiers.length, 4),
      weightedRuntimeShareReusable: round(weighted, 4),
      valid: invalidReasons.length === 0,
      invalidReasons,
    };
  } finally {
    disposeBenchWorkspace(control);
    disposeBenchWorkspace(treatment);
  }
}

// ---------------------------------------------------------------------------------------------
// Invalidation performance with an expensive verifier (spec §17/§22).
// ---------------------------------------------------------------------------------------------

export type InvalidationCategory =
  | "source_changed"
  | "definition_changed"
  | "command_changed"
  | "new_obligation_added"
  | "prior_failed_evidence"
  | "input_state_hash_mismatch"
  | "workspace_path_mismatch"
  | "incomplete_evidence_metadata";

export interface InvalidationScenario {
  id: string;
  category: InvalidationCategory;
  label: string;
  scoredRepetitions: number;
  warmupRepetitions: number;
}

export interface InvalidationResult extends PairedSeriesResult {
  scenario: InvalidationScenario;
  /** Every scored treatment executed the expensive verifier fresh (no reuse). */
  freshVerificationAlwaysExecuted: boolean;
  valid: boolean;
  invalidReasons: string[];
}

export function buildInvalidationScenarios(): InvalidationScenario[] {
  const base = { scoredRepetitions: 3, warmupRepetitions: 1 };
  return [
    { id: "inv-source-changed", category: "source_changed", label: "tracked source file edited + committed after evidence", ...base },
    { id: "inv-definition-changed", category: "definition_changed", label: "verifier definition changed (timeout budget) after evidence", ...base },
    { id: "inv-command-changed", category: "command_changed", label: "verifier command changed (equivalent output) after evidence", ...base },
    { id: "inv-new-obligation", category: "new_obligation_added", label: "a second required expensive verifier added to the plan", ...base },
    { id: "inv-prior-failed", category: "prior_failed_evidence", label: "prior evidence is a real FAILED typecheck", ...base },
    { id: "inv-input-state-mismatch", category: "input_state_hash_mismatch", label: "evidence inputStateHash does not match current state", ...base },
    { id: "inv-workspace-path-mismatch", category: "workspace_path_mismatch", label: "evidence produced in a different workspace path", ...base },
    { id: "inv-incomplete-metadata", category: "incomplete_evidence_metadata", label: "evidence missing a required identity field", ...base },
  ];
}

const BROKEN_TYPE_SOURCE = 'export const broken: number = "not a number";\n';

export async function runInvalidationScenario(scenario: InvalidationScenario, repoRoot: string): Promise<InvalidationResult> {
  const v = benchVerifiers(repoRoot);
  const expensive = v.typecheck!;
  const control = materializeBenchWorkspace();
  const treatment = materializeBenchWorkspace();
  try {
    let baselineVerifiers: Verifier[] = [toVerifier(expensive)];
    let planVerifiers: Verifier[] = [toVerifier(expensive)];
    let expectedReused: string[] = [];
    let mutate: ((ws: BenchWorkspace) => void) | undefined;
    let transform: ((e: ReturnType<typeof asGeneric>) => ReturnType<typeof asGeneric>) | undefined;
    let allowFailedOutcome = false;

    switch (scenario.category) {
      case "source_changed":
        mutate = (ws) => mutateBenchWorkspace(ws, "src/mod-0.ts", `${readBenchWorkspaceFile(ws, "src/mod-0.ts")}\n// fg12e source edit\n`);
        break;
      case "definition_changed":
        planVerifiers = [{ ...toVerifier(expensive), timeoutMs: 123_000 }];
        break;
      case "command_changed":
        planVerifiers = [toVerifier({ ...expensive, command: definitionChangedCommand(expensive.command) })];
        break;
      case "new_obligation_added":
        planVerifiers = [toVerifier(expensive), toVerifier({ ...v.typecheck!, id: "fx.typecheck-second-obligation", command: definitionChangedCommand(expensive.command) })];
        expectedReused = [expensive.id];
        break;
      case "prior_failed_evidence":
        // Real failed evidence: the bench project is broken BEFORE baseline, so the baseline
        // typecheck genuinely fails; control runs on the same broken state.
        mutateBenchWorkspace(treatment, "src/mod-0.ts", `${readBenchWorkspaceFile(treatment, "src/mod-0.ts")}${BROKEN_TYPE_SOURCE}`);
        mutateBenchWorkspace(control, "src/mod-0.ts", `${readBenchWorkspaceFile(control, "src/mod-0.ts")}${BROKEN_TYPE_SOURCE}`);
        allowFailedOutcome = true;
        break;
      case "input_state_hash_mismatch":
        transform = (evidence) => evidence.map((e) => ({ ...e, inputStateHash: `${String(e.inputStateHash).slice(0, 8)}-tampered` }));
        break;
      case "workspace_path_mismatch":
        transform = (evidence) => evidence.map((e) => ({ ...e, workspacePath: control.root }));
        break;
      case "incomplete_evidence_metadata":
        transform = (evidence) =>
          evidence.map((e) => {
            const { definitionDigest: _dropped, ...rest } = e as unknown as Record<string, unknown>;
            return rest as unknown as (typeof evidence)[number];
          });
        break;
    }

    const series = await runPairedSeries({
      workloadId: scenario.id,
      expectedTier: "EXPENSIVE",
      control,
      treatment,
      baselineVerifiers,
      planVerifiers,
      expectedReusedVerifierIds: expectedReused,
      warmupRepetitions: scenario.warmupRepetitions,
      scoredRepetitions: scenario.scoredRepetitions,
      mutateTreatmentAfterBaseline: mutate,
      transformPriorEvidence: transform,
      allowFailedOutcome,
    });
    const invalidReasons: string[] = [];
    for (const receipt of series.scoredReceipts) if (!receipt.safety.passed) invalidReasons.push(`pair ${receipt.pairIndex}: ${receipt.safety.failureReasons.join("; ")}`);
    if (series.stateDrift.drifted) invalidReasons.push("workspace input-state hash drifted during the series");
    const freshVerificationAlwaysExecuted = series.scoredReceipts.every((r) => !r.treatment.reusedVerifierIds.includes(expensive.id) || scenario.category === "new_obligation_added");
    if (scenario.category === "prior_failed_evidence") {
      const baselineFailed = series.scoredReceipts.every((r) => r.treatment.freshAttempts === 1 && r.treatment.overallStatus === "failed" && r.control.overallStatus === "failed");
      if (!baselineFailed) invalidReasons.push("prior-failed-evidence scenario did not produce a real failed control/treatment pair");
    }
    return { scenario, ...series, freshVerificationAlwaysExecuted, valid: invalidReasons.length === 0 && freshVerificationAlwaysExecuted, invalidReasons };
  } finally {
    disposeBenchWorkspace(control);
    disposeBenchWorkspace(treatment);
  }
}
