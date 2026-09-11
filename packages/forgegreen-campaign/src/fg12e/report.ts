import os from "node:os";
import { characterizeBreakEven, classifyRollout, summarizeWorkload, type BreakEvenCharacterization, type RolloutClassification, type WorkloadSummary } from "./break-even.js";
import type { ComponentProfile } from "./component-profile.js";
import type { Fg12eIdentity } from "./harness-identity.js";
import type { PairReceipt } from "./pair-runner.js";
import type { FallbackBenchResult, RestartBenchResult } from "./restart-fallback-bench.js";
import { round, summarize, type SummaryStats } from "./timing.js";
import type { CompositionResult, InvalidationResult, WorkloadResult } from "./workload-runner.js";

export type Fg12eVerdict = "CODEFORGE_FORGEGREEN_FG12E_PERFORMANCE_CHARACTERIZED" | "CODEFORGE_FORGEGREEN_FG12E_BLOCKED";

export interface SafetyAggregate {
  totalScoredPairs: number;
  totalUnscoredPairs: number;
  pairsFailingSafety: number;
  staleEvidenceReused: number;
  failedEvidenceReused: number;
  coverageDivergences: number;
  outcomeDivergences: number;
  actualVerifierExecutionsAvoided: number;
  actualChildProcessesAvoided: number;
  freshExecutionsPerformedInTreatment: number;
  certified: boolean;
}

export interface Fg12eArtifact {
  schemaVersion: "fg12e-performance-trial-artifact-1";
  generatedAt: string;
  verdict: Fg12eVerdict;
  verdictReasons: string[];
  identity: Fg12eIdentity & { fg12dCheckpointCommit?: string };
  environment: { node: string; platform: string; arch: string; cpus: number; cpuModel: string };
  costUsd: 0;
  energyCarbon: "INSUFFICIENT_DATA";
  safety: SafetyAggregate;
  workloads: WorkloadSummary[];
  breakEven: BreakEvenCharacterization;
  rollout: RolloutClassification;
  componentProfiles: ComponentProfile[];
  compositions: Array<{
    scenarioId: string;
    label: string;
    plannedCount: number;
    reusableCount: number;
    countShareReusable: number;
    weightedRuntimeShareReusable: number;
    valid: boolean;
    invalidReasons: string[];
    control: SummaryStats;
    treatment: SummaryStats;
    net: SummaryStats;
    reuseCheckMs: SummaryStats;
    verificationSavedReferenceMs: SummaryStats;
    actualVerifierExecutionsAvoided: number;
    freshExecutions: number;
  }>;
  invalidations: Array<{
    scenarioId: string;
    category: string;
    label: string;
    valid: boolean;
    freshVerificationAlwaysExecuted: boolean;
    control: SummaryStats;
    treatment: SummaryStats;
    /** treatment - control: the added cost of a REJECTED reuse attempt. */
    rejectedReuseOverheadMs: SummaryStats;
    advisoryDifferentialMs: SummaryStats;
  }>;
  restart: Array<{
    id: string;
    passed: boolean;
    durableEvidenceLoadMs: number;
    loadedEvidenceCount: number;
    baselinePersistenceWriteMs: number;
    treatmentPersistenceWriteMs: number;
    controlPersistenceWriteMs: number;
    expensiveVerifierActuallySkipped: boolean;
    scoredControlWallMs: number[];
    scoredTreatmentWallMs: number[];
    scoredNetMs: number[];
    historicalElapsedMsFromPersistedEvidence: number[];
    freshControlElapsedMs: number[];
    failureReasons: string[];
  }>;
  fallback: {
    passed: boolean;
    freshVerificationAlwaysExecuted: boolean;
    scoredControlWallMs: number[];
    scoredTreatmentWallMs: number[];
    /** treatment - control: fallback overhead when the advisor throws. */
    fallbackOverheadMs: SummaryStats;
    fallbackReasons: string[];
  };
  historicalCostEstimation: {
    verifierDurationRecordedToday: boolean;
    where: string;
    durable: boolean;
    couldFeedPerformanceAdvisory: boolean;
    separationNote: string;
  };
  globalGraduationRegistryUnchanged: true;
  productionCallSitesModified: [];
  rawPairReceipts: PairReceipt[];
}

export interface ArtifactInputs {
  identity: Fg12eIdentity & { fg12dCheckpointCommit?: string };
  workloadResults: WorkloadResult[];
  componentProfiles: ComponentProfile[];
  compositions: CompositionResult[];
  invalidations: InvalidationResult[];
  restart: RestartBenchResult[];
  fallback: FallbackBenchResult;
  generatedAt?: string;
}

function collectReceipts(inputs: ArtifactInputs): PairReceipt[] {
  return [
    ...inputs.workloadResults.flatMap((r) => [...r.warmupReceipts, ...r.scoredReceipts]),
    ...inputs.compositions.flatMap((r) => [...r.warmupReceipts, ...r.scoredReceipts]),
    ...inputs.invalidations.flatMap((r) => [...r.warmupReceipts, ...r.scoredReceipts]),
    ...inputs.restart.flatMap((r) => r.receipts),
    ...inputs.fallback.receipts,
  ];
}

export function aggregateSafety(receipts: PairReceipt[], extraFailures: string[]): SafetyAggregate {
  const failing = receipts.filter((r) => !r.safety.passed);
  return {
    totalScoredPairs: receipts.filter((r) => r.scored).length,
    totalUnscoredPairs: receipts.filter((r) => !r.scored).length,
    pairsFailingSafety: failing.length,
    staleEvidenceReused: receipts.filter((r) => !r.safety.everyReusedEvidenceCanonicallyValid).length,
    failedEvidenceReused: receipts.filter((r) => !r.safety.noFailedEvidenceReused).length,
    coverageDivergences: receipts.filter((r) => !r.safety.coverageEquivalent).length,
    outcomeDivergences: receipts.filter((r) => !r.safety.outcomeEquivalent).length,
    actualVerifierExecutionsAvoided: receipts.reduce((s, r) => s + r.actualVerifierExecutionsAvoided, 0),
    actualChildProcessesAvoided: receipts.reduce((s, r) => s + r.actualChildProcessesAvoided, 0),
    freshExecutionsPerformedInTreatment: receipts.reduce((s, r) => s + r.treatment.freshAttempts, 0),
    certified: failing.length === 0 && extraFailures.length === 0,
  };
}

export function buildArtifact(inputs: ArtifactInputs): Fg12eArtifact {
  const receipts = collectReceipts(inputs);
  const extraFailures = [
    ...inputs.restart.filter((r) => !r.passed).map((r) => `${r.id}: ${r.failureReasons.join("; ")}`),
    ...(inputs.fallback.passed ? [] : [`fallback: ${inputs.fallback.failureReasons.join("; ")}`]),
    ...inputs.invalidations.filter((r) => !r.valid).map((r) => `${r.scenario.id}: ${r.invalidReasons.join("; ") || "fresh verification not always executed"}`),
    ...inputs.compositions.filter((r) => !r.valid).map((r) => `${r.scenario.id}: ${r.invalidReasons.join("; ")}`),
  ];
  const safety = aggregateSafety(receipts, extraFailures);

  const breakEven = characterizeBreakEven(inputs.workloadResults);
  const workloads = inputs.workloadResults.map((r) => summarizeWorkload(r, Number.isFinite(breakEven.estimate.overallMs) ? breakEven.estimate.overallMs : undefined));
  const rollout = classifyRollout(workloads, breakEven, safety.certified);

  const verdictReasons: string[] = [];
  if (!safety.certified) verdictReasons.push("safety regressed or a proof case failed");
  if (workloads.filter((w) => w.valid).length < 4) verdictReasons.push("fewer than 4 valid workloads — break-even not measurable");
  if (!Number.isFinite(breakEven.estimate.overallMs) || breakEven.reuseCheckMsOverall.n < 10) verdictReasons.push("reuse overhead could not be distinguished from verifier work");
  if (safety.actualVerifierExecutionsAvoided === 0) verdictReasons.push("no actual verifier executions were avoided");
  const verdict: Fg12eVerdict = verdictReasons.length === 0 ? "CODEFORGE_FORGEGREEN_FG12E_PERFORMANCE_CHARACTERIZED" : "CODEFORGE_FORGEGREEN_FG12E_BLOCKED";

  const stats = (values: number[]) => summarize(values);
  const cpus = os.cpus();
  return {
    schemaVersion: "fg12e-performance-trial-artifact-1",
    generatedAt: inputs.generatedAt ?? new Date().toISOString(),
    verdict,
    verdictReasons,
    identity: inputs.identity,
    environment: { node: process.version, platform: process.platform, arch: process.arch, cpus: cpus.length, cpuModel: cpus[0]?.model ?? "unknown" },
    costUsd: 0,
    energyCarbon: "INSUFFICIENT_DATA",
    safety,
    workloads,
    breakEven,
    rollout,
    componentProfiles: inputs.componentProfiles,
    compositions: inputs.compositions.map((c) => ({
      scenarioId: c.scenario.id,
      label: c.scenario.label,
      plannedCount: c.plannedCount,
      reusableCount: c.reusableCount,
      countShareReusable: c.countShareReusable,
      weightedRuntimeShareReusable: c.weightedRuntimeShareReusable,
      valid: c.valid,
      invalidReasons: c.invalidReasons,
      control: stats(c.scoredReceipts.map((r) => r.control.wallMs)),
      treatment: stats(c.scoredReceipts.map((r) => r.treatment.wallMs)),
      net: stats(c.scoredReceipts.map((r) => r.netWallClockDeltaMs)),
      reuseCheckMs: stats(c.scoredReceipts.map((r) => r.reuseCheckMs)),
      verificationSavedReferenceMs: stats(c.scoredReceipts.map((r) => r.verificationSavedReferenceMs)),
      actualVerifierExecutionsAvoided: c.scoredReceipts.reduce((s, r) => s + r.actualVerifierExecutionsAvoided, 0),
      freshExecutions: c.scoredReceipts.reduce((s, r) => s + r.treatment.freshAttempts, 0),
    })),
    invalidations: inputs.invalidations.map((i) => ({
      scenarioId: i.scenario.id,
      category: i.scenario.category,
      label: i.scenario.label,
      valid: i.valid,
      freshVerificationAlwaysExecuted: i.freshVerificationAlwaysExecuted,
      control: stats(i.scoredReceipts.map((r) => r.control.wallMs)),
      treatment: stats(i.scoredReceipts.map((r) => r.treatment.wallMs)),
      rejectedReuseOverheadMs: stats(i.scoredReceipts.map((r) => round(r.treatment.wallMs - r.control.wallMs))),
      advisoryDifferentialMs: stats(i.scoredReceipts.map((r) => r.advisoryDifferentialMs)),
    })),
    restart: inputs.restart.map((r) => ({
      id: r.id,
      passed: r.passed,
      durableEvidenceLoadMs: r.durableEvidenceLoadMs,
      loadedEvidenceCount: r.loadedEvidenceCount,
      baselinePersistenceWriteMs: r.baselinePersistenceWriteMs,
      treatmentPersistenceWriteMs: r.treatmentPersistenceWriteMs,
      controlPersistenceWriteMs: r.controlPersistenceWriteMs,
      expensiveVerifierActuallySkipped: r.expensiveVerifierActuallySkipped,
      scoredControlWallMs: r.receipts.filter((p) => p.scored).map((p) => p.control.wallMs),
      scoredTreatmentWallMs: r.receipts.filter((p) => p.scored).map((p) => p.treatment.wallMs),
      scoredNetMs: r.receipts.filter((p) => p.scored).map((p) => p.netWallClockDeltaMs),
      historicalElapsedMsFromPersistedEvidence: r.historicalElapsedMsFromPersistedEvidence,
      freshControlElapsedMs: r.freshControlElapsedMs,
      failureReasons: r.failureReasons,
    })),
    fallback: {
      passed: inputs.fallback.passed,
      freshVerificationAlwaysExecuted: inputs.fallback.freshVerificationAlwaysExecuted,
      scoredControlWallMs: inputs.fallback.receipts.filter((p) => p.scored).map((p) => p.control.wallMs),
      scoredTreatmentWallMs: inputs.fallback.receipts.filter((p) => p.scored).map((p) => p.treatment.wallMs),
      fallbackOverheadMs: stats(inputs.fallback.receipts.filter((p) => p.scored).map((p) => round(p.treatment.wallMs - p.control.wallMs))),
      fallbackReasons: inputs.fallback.fallbackReasons,
    },
    historicalCostEstimation: {
      verifierDurationRecordedToday: true,
      where: "VerificationEvidence.elapsedMs (ForgeVerify child-process wall time), persisted verbatim inside the 'evidence' work-item payload by createForgeVerifyPersistenceObserver and returned by loadForgeVerifyEvidence; also surfaced as VerifierRunResult.durationMs and VerificationReceipt.durationMs.",
      durable: true,
      couldFeedPerformanceAdvisory: true,
      separationNote: "Duration must only ever inform a ForgeGreen cost policy (e.g. a future gate deciding whether to spend reuse_check_ms at all). It never participates in validity: ForgeVerify's isEvidenceCurrentlyValid remains the sole authority and takes no duration input.",
    },
    globalGraduationRegistryUnchanged: true,
    productionCallSitesModified: [],
    rawPairReceipts: receipts,
  };
}

// ---------------------------------------------------------------------------------------------
// Markdown rendering.
// ---------------------------------------------------------------------------------------------

function ms(value: number | null | undefined, digits = 1): string {
  return value === null || value === undefined || !Number.isFinite(value) ? "n/a" : `${round(value, digits)} ms`;
}

function statsRow(label: string, s: SummaryStats): string {
  return `| ${label} | ${s.n} | ${ms(s.median)} | ${ms(s.mean)} | ${ms(s.min)} | ${ms(s.max)} | ${ms(s.p25)} | ${ms(s.p75)} |`;
}

const STATS_HEADER = "| series | n | median | mean | min | max | p25 | p75 |\n|---|---|---|---|---|---|---|---|";

function rawSeries(values: number[]): string {
  return values.map((v) => round(v, 1)).join(", ");
}

export function renderMarkdown(artifact: Fg12eArtifact): string {
  const lines: string[] = [];
  const push = (s = "") => lines.push(s);

  push("# ForgeGreen FG-12E — Expensive Verifier Performance & Break-Even Trial Report");
  push();
  push(`Generated: ${artifact.generatedAt}`);
  push();
  push(`- Verdict: **${artifact.verdict}**${artifact.verdictReasons.length ? ` — ${artifact.verdictReasons.join("; ")}` : ""}`);
  push(`- Certified Candidate D source-state (unchanged from FG-12D): \`${artifact.identity.certifiedSourceStateId}\``);
  if (artifact.identity.fg12dCheckpointCommit) push(`- FG-12D checkpoint commit: \`${artifact.identity.fg12dCheckpointCommit}\``);
  push(`- FG-12D campaign harness id: \`${artifact.identity.fg12dCampaignHarnessId}\``);
  push(`- FG-12E benchmark harness id: \`${artifact.identity.fg12eHarnessId}\``);
  push(`- Environment: node ${artifact.environment.node}, ${artifact.environment.platform}/${artifact.environment.arch}, ${artifact.environment.cpus} CPUs (${artifact.environment.cpuModel})`);
  push(`- Provider cost: $${artifact.costUsd.toFixed(2)} (all work local; no model, cloud, or GPU involvement)`);
  push(`- Energy/Carbon: \`${artifact.energyCarbon}\``);
  push("- Global `VERIFICATION_EVIDENCE_REUSE` graduation registry entry: unchanged (still `SHADOW`); production call sites modified: none");
  push(`- Rollout recommendation (performance policy, separate from safety): **${artifact.rollout.recommendation}**`);
  push();

  push("## Safety (always first)");
  push();
  const s = artifact.safety;
  push(`- Scored pairs: ${s.totalScoredPairs} (plus ${s.totalUnscoredPairs} unscored warmups)`);
  push(`- Pairs failing any safety check: ${s.pairsFailingSafety}`);
  push(`- Stale evidence reused: ${s.staleEvidenceReused} · Failed evidence reused: ${s.failedEvidenceReused}`);
  push(`- Coverage divergences: ${s.coverageDivergences} · Outcome divergences: ${s.outcomeDivergences}`);
  push(`- Actual verifier executions avoided (real skips): ${s.actualVerifierExecutionsAvoided} · child processes not spawned: ${s.actualChildProcessesAvoided}`);
  push(`- Fresh executions performed inside treatment arms (invalidation/partial/fallback): ${s.freshExecutionsPerformedInTreatment}`);
  push(`- Safety certified for this run: **${s.certified}**`);
  push();

  push("## Workloads (real verifiers)");
  push();
  push("| workload | expected tier | observed class | workspace | verifier | scored pairs | valid |");
  push("|---|---|---|---|---|---|---|");
  for (const w of artifact.workloads) push(`| ${w.workloadId} | ${w.expectedTier} | ${w.observedClass} | ${w.workspaceKind} | ${w.label} | ${w.scoredPairs} | ${w.valid ? "yes" : `NO — ${w.invalidReasons.join("; ")}`} |`);
  push();
  push("Observed class is non-authoritative (spec §20): CHEAP = verifier cost below the measured break-even, MODERATE = 1-5x, EXPENSIVE = >= 5x.");
  push();

  push("## Break-even characterization");
  push();
  push(artifact.breakEven.model);
  push();
  const be = artifact.breakEven;
  push(`- reuse_check_ms overall: median ${ms(be.reuseCheckMsOverall.median)} (p25 ${ms(be.reuseCheckMsOverall.p25)}, p75 ${ms(be.reuseCheckMsOverall.p75)}, n=${be.reuseCheckMsOverall.n})`);
  for (const kind of ["bench-fixture", "repo-root"] as const) {
    const st = be.reuseCheckMsByWorkspace[kind];
    if (st) push(`- reuse_check_ms on ${kind}: median ${ms(st.median)} (p25 ${ms(st.p25)}, p75 ${ms(st.p75)}, n=${st.n})`);
  }
  push(`- **Break-even estimate: verifier cost ≈ ${ms(be.estimate.overallMs)} (range ${ms(be.estimate.rangeMs[0])} – ${ms(be.estimate.rangeMs[1])})**`);
  push(`- Empirical bracket: last net-negative workload = ${be.bracket.lastNegative ? `${be.bracket.lastNegative.workloadId} (verifier ${ms(be.bracket.lastNegative.verifierExecutionMedianMs)}, net ${ms(be.bracket.lastNegative.netMedianMs)})` : "none"}; first net-positive = ${be.bracket.firstPositive ? `${be.bracket.firstPositive.workloadId} (verifier ${ms(be.bracket.firstPositive.verifierExecutionMedianMs)}, net ${ms(be.bracket.firstPositive.netMedianMs)})` : "none"}`);
  push(`- Model/observation sign agreement: ${be.modelAgreement.agreeing.length} agree, ${be.modelAgreement.disagreeing.length} disagree${be.modelAgreement.disagreeing.length ? ` (${be.modelAgreement.disagreeing.join(", ")})` : ""}`);
  push();
  push("| workload (by verifier cost) | workspace | control wall (median) | verifier exec (median) | treatment wall (median) | net (median) | reuse_check (median) | positive-net share |");
  push("|---|---|---|---|---|---|---|---|");
  for (const p of be.points) push(`| ${p.workloadId} | ${p.workspaceKind} | ${ms(p.controlWallMedianMs)} | ${ms(p.verifierExecutionMedianMs)} | ${ms(p.treatmentWallMedianMs)} | ${ms(p.netMedianMs)} | ${ms(p.reuseCheckMedianMs)} | ${(p.positiveNetShare * 100).toFixed(0)}% |`);
  push();
  push("Residuals (net − (verifier exec − reuse_check)); a residual trend with cost would indicate non-linearity:");
  push();
  for (const r of be.residuals) push(`- ${r.workloadId}: ${ms(r.residualMs)}${r.relativeToNet !== null ? ` (${(r.relativeToNet * 100).toFixed(1)}% of |net|)` : ""}`);
  push();

  push("## Per-workload timings (control vs treatment)");
  push();
  for (const w of artifact.workloads) {
    push(`### ${w.workloadId} — ${w.label}`);
    push();
    push(`Workspace: ${w.workspaceKind} · expected ${w.expectedTier} · observed ${w.observedClass} · cold (unscored baseline) verifier elapsed: ${ms(w.coldVerifierElapsedMs)} · actual verifier executions avoided: ${w.actualVerifierExecutionsAvoided}`);
    push();
    push(STATS_HEADER);
    push(statsRow("control wall", w.control.wallMs.withOutliers));
    push(statsRow("control verifier exec (child process)", w.control.verifierExecutionMs));
    push(statsRow("control non-verifier base", w.control.nonVerifierMs));
    push(statsRow("treatment wall (reuse path)", w.treatment.wallMs.withOutliers));
    push(statsRow("net (control − treatment)", w.netWallClockDeltaMs.withOutliers));
    push(statsRow("reuse_check (treatment − control base)", w.reuseCheckMs));
    push(statsRow("advisory differential (pre-plan)", w.advisoryDifferentialMs));
    if (w.netWallClockDeltaMs.flaggedIndices.length > 0) push(statsRow("net without flagged outliers", w.netWallClockDeltaMs.withoutOutliers));
    if (w.control.wallMs.flaggedIndices.length > 0) push(statsRow("control wall without flagged outliers", w.control.wallMs.withoutOutliers));
    push();
    push(`Order balance: control-first n=${w.byOrder.controlFirst.n} median net ${ms(w.byOrder.controlFirst.medianNetMs)}; treatment-first n=${w.byOrder.treatmentFirst.n} median net ${ms(w.byOrder.treatmentFirst.medianNetMs)}. Positive-net share ${(w.positiveNetShare * 100).toFixed(0)}%.`);
    if (w.control.wallMs.flaggedIndices.length || w.treatment.wallMs.flaggedIndices.length || w.netWallClockDeltaMs.flaggedIndices.length) {
      push(`Outliers flagged (retained, rule: ${w.netWallClockDeltaMs.rule}): control ${JSON.stringify(w.control.wallMs.flaggedIndices)}, treatment ${JSON.stringify(w.treatment.wallMs.flaggedIndices)}, net ${JSON.stringify(w.netWallClockDeltaMs.flaggedIndices)}.`);
    }
    push();
  }

  push("## Raw scored timings");
  push();
  for (const w of artifact.workloads) {
    const scored = artifact.rawPairReceipts.filter((r) => r.workloadId === w.workloadId && r.scored);
    push(`- ${w.workloadId} control wall: ${rawSeries(scored.map((r) => r.control.wallMs))}`);
    push(`- ${w.workloadId} treatment wall: ${rawSeries(scored.map((r) => r.treatment.wallMs))}`);
    push(`- ${w.workloadId} order: ${scored.map((r) => (r.order === "control-first" ? "C→T" : "T→C")).join(", ")}`);
  }
  push();

  push("## Reuse overhead components (direct profile of the production functions in wrapper order)");
  push();
  for (const profile of artifact.componentProfiles) {
    push(`### ${profile.workspaceKind} (${profile.iterations} iterations, verifiers: ${profile.verifierIds.join(", ")})`);
    push();
    push(STATS_HEADER);
    for (const [key, st] of Object.entries(profile.stats)) push(statsRow(key, st));
    push();
    push("Tree semantics (no double counting): `advisory.totalMs` = commandAvailability + adaptAndRegistry + preliminaryPlan + advisorTotal; `advisorTotalMs` contains strictNarrowing/canonicalValidity/forgeGreenDecision/killSwitchResolve as sub-spans; `preliminaryPlanMs` and `authoritative.planMs` each contain one `inputStateHashMs`; `executeReuseMatchAndSummarizeMs` contains `summarizeMs` (which contains another input-state hash); `reusePathTotalMs` = advisory.totalMs + authoritative.runVerificationReuseWallMs.");
    push();
  }

  push("## Multi-verifier plans and partial reuse");
  push();
  push("| scenario | planned | reusable | count share | runtime-weighted share | control (median) | treatment (median) | net (median) | reuse_check (median) | avoided | fresh | valid |");
  push("|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const c of artifact.compositions) push(`| ${c.scenarioId} | ${c.plannedCount} | ${c.reusableCount} | ${(c.countShareReusable * 100).toFixed(0)}% | ${(c.weightedRuntimeShareReusable * 100).toFixed(0)}% | ${ms(c.control.median)} | ${ms(c.treatment.median)} | ${ms(c.net.median)} | ${ms(c.reuseCheckMs.median)} | ${c.actualVerifierExecutionsAvoided} | ${c.freshExecutions} | ${c.valid ? "yes" : `NO — ${c.invalidReasons.join("; ")}`} |`);
  push();
  push("Non-reusable verifiers in a composition carry a real definition change (equivalent output, different command digest), so their prior evidence is invalid by definition digest and they execute fresh while the rest reuse — coverage stays complete.");
  push();

  push("## Invalidation cost with an expensive verifier (rejected reuse attempts)");
  push();
  push("| category | fresh verification always executed | control (median) | treatment (median) | rejected-reuse overhead (median) | overhead p25–p75 | advisory differential (median) | valid |");
  push("|---|---|---|---|---|---|---|---|");
  for (const i of artifact.invalidations) push(`| ${i.category} | ${i.freshVerificationAlwaysExecuted} | ${ms(i.control.median)} | ${ms(i.treatment.median)} | ${ms(i.rejectedReuseOverheadMs.median)} | ${ms(i.rejectedReuseOverheadMs.p25)} – ${ms(i.rejectedReuseOverheadMs.p75)} | ${ms(i.advisoryDifferentialMs.median)} | ${i.valid} |`);
  push();

  push("## Restart (durable persistence) with an expensive verifier");
  push();
  for (const r of artifact.restart) {
    push(`- **${r.id}**: ${r.passed ? "PASSED" : `FAILED — ${r.failureReasons.join("; ")}`}; durable evidence load ${ms(r.durableEvidenceLoadMs)} (${r.loadedEvidenceCount} records); persistence writes: baseline ${ms(r.baselinePersistenceWriteMs)}, control ${ms(r.controlPersistenceWriteMs)}/run, treatment ${ms(r.treatmentPersistenceWriteMs)}/run; expensive verifier ${r.id === "restart-valid-reuse" ? "genuinely skipped" : "ran fresh"}: ${r.expensiveVerifierActuallySkipped}`);
    push(`  - scored control wall: ${rawSeries(r.scoredControlWallMs)}; treatment wall: ${rawSeries(r.scoredTreatmentWallMs)}; net: ${rawSeries(r.scoredNetMs)}`);
    push(`  - historical elapsedMs carried by the persisted evidence: ${rawSeries(r.historicalElapsedMsFromPersistedEvidence)}; fresh control elapsedMs: ${rawSeries(r.freshControlElapsedMs)}`);
  }
  push();

  push("## Advisor failure fallback with an expensive verifier");
  push();
  const f = artifact.fallback;
  push(`- ${f.passed ? "PASSED" : "FAILED"}; fresh verification always executed: ${f.freshVerificationAlwaysExecuted}; fallback overhead (treatment − control): median ${ms(f.fallbackOverheadMs.median)} (p25 ${ms(f.fallbackOverheadMs.p25)}, p75 ${ms(f.fallbackOverheadMs.p75)})`);
  push(`- scored control wall: ${rawSeries(f.scoredControlWallMs)}; treatment wall: ${rawSeries(f.scoredTreatmentWallMs)}`);
  push();

  push("## Historical cost estimation (spec §19)");
  push();
  const h = artifact.historicalCostEstimation;
  push(`- Verifier duration recorded today: ${h.verifierDurationRecordedToday} — ${h.where}`);
  push(`- Durable: ${h.durable}; could feed a future ForgeGreen performance advisory: ${h.couldFeedPerformanceAdvisory}`);
  push(`- ${h.separationNote}`);
  push();

  push("## Rollout recommendation");
  push();
  push(`**${artifact.rollout.recommendation}**`);
  push();
  for (const r of artifact.rollout.rationale) push(`- ${r}`);
  push(`- Inputs: ${JSON.stringify(artifact.rollout.inputs)}`);
  push();
  push("This classification is a performance policy statement only. Candidate D remains `CONTROLLED_TRIAL_ONLY`; nothing here activates it or wires a production caller.");
  push();
  return lines.join("\n");
}
