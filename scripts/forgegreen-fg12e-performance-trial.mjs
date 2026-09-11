#!/usr/bin/env node
// FG-12E expensive-verifier performance & break-even trial for ForgeGreen Candidate D
// (VERIFICATION_EVIDENCE_REUSE). Zero-cash, zero-network: every measurement drives the real,
// unmodified FG-12D reuse path (runVerificationWithControlledReuse -> runVerification ->
// executeVerificationPlan) against REAL verifier commands — node --check, node --test, real
// non-incremental tsc typechecks, real Vitest runs of actual CodeForge packages. No sleep, busy
// loop, or fake timer anywhere in the primary evidence path. No model/provider calls.
//
// Candidate D's safety model is not touched. Nothing here activates Candidate D or wires a
// production caller; the global graduation registry entry stays SHADOW.
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";
import {
  SourceStateDriftError,
  freezeFg12eIdentity,
  buildBreakEvenWorkloads,
  runBreakEvenWorkload,
  buildCompositionScenarios,
  runCompositionScenario,
  buildInvalidationScenarios,
  runInvalidationScenario,
  runRestartBenchmarks,
  runFallbackBenchmark,
  profileReusePathComponents,
  produceBaselineEvidence,
  runPair,
  materializeBenchWorkspace,
  disposeBenchWorkspace,
  benchVerifiers,
  toVerifier,
  buildArtifact,
  renderMarkdown,
} from "@codeforge/forgegreen-campaign";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

function log(message) {
  console.log(`[fg12e ${new Date().toISOString()}] ${message}`);
}

function fg12dCheckpointCommit() {
  try {
    return execFileSync("git", ["log", "-1", "--format=%H", "--grep=certify controlled verification reuse trial"], { cwd: repoRoot, encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
}

async function main() {
  log("verifying certified Candidate D source-state and freezing FG-12E harness identity...");
  let identity;
  try {
    identity = freezeFg12eIdentity(repoRoot);
  } catch (error) {
    if (error instanceof SourceStateDriftError) {
      console.error("FG12E_SOURCE_STATE_DRIFT");
      console.error(JSON.stringify(error.detail, null, 2));
      process.exitCode = 1;
      return;
    }
    throw error;
  }
  identity = { ...identity, fg12dCheckpointCommit: fg12dCheckpointCommit() };
  log(`certifiedSourceStateId  = ${identity.certifiedSourceStateId}`);
  log(`fg12dCampaignHarnessId  = ${identity.fg12dCampaignHarnessId}`);
  log(`fg12eHarnessId          = ${identity.fg12eHarnessId}`);

  const only = process.argv.includes("--quick");

  // 0. Whole-pipeline warmup (spec §7): a few unscored control+treatment pairs on a throwaway
  // fixture so the first scored workload does not pay one-time costs (module loading, OS file
  // cache, spawn path resolution) that later workloads would not.
  log("pipeline warmup (unscored)...");
  {
    const v = benchVerifiers(repoRoot);
    const warm = materializeBenchWorkspace();
    try {
      const baseline = await produceBaselineEvidence(warm, [toVerifier(v.syntaxCheck)], "fg12e-pipeline-warmup");
      for (let i = 0; i < 3; i += 1) {
        await runPair({ pairIndex: i, scored: false, warm: "cold", order: i % 2 === 0 ? "control-first" : "treatment-first", workloadId: "pipeline-warmup", expectedTier: "CHEAP", controlWorkspace: warm, treatmentWorkspace: warm, planVerifiers: [toVerifier(v.syntaxCheck)], priorEvidence: baseline.evidence, expectedReusedVerifierIds: [v.syntaxCheck.id] });
      }
    } finally {
      disposeBenchWorkspace(warm);
    }
  }

  // 1. Single-verifier break-even ladder.
  const workloads = buildBreakEvenWorkloads(repoRoot).filter((w) => !only || w.expectedTier === "CHEAP" || w.id === "t2-fixture-typecheck");
  const workloadResults = [];
  for (const workload of workloads) {
    log(`workload ${workload.id} (${workload.expectedTier}, ${workload.workspace}): ${workload.warmupRepetitions} warmup + ${workload.scoredRepetitions} scored pairs...`);
    const result = await runBreakEvenWorkload(workload, repoRoot);
    const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    log(`  control median ${med(result.scoredReceipts.map((r) => r.control.wallMs)).toFixed(1)} ms, treatment median ${med(result.scoredReceipts.map((r) => r.treatment.wallMs)).toFixed(1)} ms, net median ${med(result.scoredReceipts.map((r) => r.netWallClockDeltaMs)).toFixed(1)} ms, valid=${result.valid}${result.valid ? "" : ` (${result.invalidReasons.join("; ")})`}`);
    workloadResults.push(result);
  }

  // 2. Component profile of the reuse path on both workspace kinds.
  log("profiling reuse-path components (bench fixture)...");
  const componentProfiles = [];
  {
    const v = benchVerifiers(repoRoot);
    const fixture = materializeBenchWorkspace();
    try {
      const baseline = await produceBaselineEvidence(fixture, [toVerifier(v.typecheck)], "fg12e-profile-fixture");
      componentProfiles.push(await profileReusePathComponents(fixture, [toVerifier(v.typecheck)], baseline.evidence, only ? 5 : 20));
    } finally {
      disposeBenchWorkspace(fixture);
    }
  }
  if (!only) {
    log("profiling reuse-path components (repo root)...");
    const v = benchVerifiers(repoRoot);
    const repo = { root: repoRoot, kind: "repo-root" };
    const baseline = await produceBaselineEvidence(repo, [toVerifier(v.repoTscForgeGreen)], "fg12e-profile-repo");
    componentProfiles.push(await profileReusePathComponents(repo, [toVerifier(v.repoTscForgeGreen)], baseline.evidence, 20));
  }

  // 3. Multi-verifier compositions with partial reuse.
  const compositions = [];
  for (const scenario of buildCompositionScenarios(repoRoot).filter((s) => !only || s.id.endsWith("50pct"))) {
    log(`composition ${scenario.id}...`);
    const result = await runCompositionScenario(scenario);
    log(`  reusable ${result.reusableCount}/${result.plannedCount}, runtime-weighted share ${(result.weightedRuntimeShareReusable * 100).toFixed(0)}%, valid=${result.valid}${result.valid ? "" : ` (${result.invalidReasons.join("; ")})`}`);
    compositions.push(result);
  }

  // 4. Invalidation cost with an expensive verifier (safety regression matrix, §22).
  const invalidations = [];
  for (const scenario of buildInvalidationScenarios().filter((s) => !only || s.category === "source_changed")) {
    log(`invalidation ${scenario.id} (${scenario.category})...`);
    const result = await runInvalidationScenario(scenario, repoRoot);
    log(`  fresh verification always executed=${result.freshVerificationAlwaysExecuted}, valid=${result.valid}${result.valid ? "" : ` (${result.invalidReasons.join("; ")})`}`);
    invalidations.push(result);
  }

  // 5. Restart + fallback with an expensive verifier.
  log("restart benchmarks (persist -> close -> reopen -> reuse / mutate -> fresh)...");
  const restart = await runRestartBenchmarks(repoRoot, only ? 2 : 4);
  for (const r of restart) log(`  ${r.id}: passed=${r.passed} durableLoad=${r.durableEvidenceLoadMs} ms skipped/fresh-as-expected=${r.expensiveVerifierActuallySkipped}`);
  log("fallback benchmark (advisor throws during expensive verification)...");
  const fallback = await runFallbackBenchmark(repoRoot, only ? 2 : 4);
  log(`  fallback: passed=${fallback.passed} freshAlways=${fallback.freshVerificationAlwaysExecuted}`);

  // 6. Artifacts.
  const artifact = buildArtifact({ identity, workloadResults, componentProfiles, compositions, invalidations, restart, fallback });
  // --quick is a smoke run of the pipeline, never a certified artifact: it writes to a temp dir.
  const outDir = only ? fs.mkdtempSync(path.join(os.tmpdir(), "fg12e-quick-")) : path.join(repoRoot, "docs");
  const jsonPath = path.join(outDir, "codeforge-forgegreen-fg12e-performance-trial.json");
  const mdPath = path.join(outDir, "codeforge-forgegreen-fg12e-performance-trial-report.md");
  fs.writeFileSync(jsonPath, JSON.stringify(artifact, null, 2));
  fs.writeFileSync(mdPath, renderMarkdown(artifact));
  log(`wrote ${jsonPath}`);
  log(`wrote ${mdPath}`);
  log(`safety certified: ${artifact.safety.certified}; actual verifier executions avoided: ${artifact.safety.actualVerifierExecutionsAvoided}`);
  log(`break-even estimate: ${artifact.breakEven.estimate.overallMs} ms (range ${artifact.breakEven.estimate.rangeMs.join("–")})`);
  log(`rollout: ${artifact.rollout.recommendation}`);
  log(`verdict: ${artifact.verdict}${artifact.verdictReasons.length ? ` (${artifact.verdictReasons.join("; ")})` : ""}`);
  if (artifact.verdict !== "CODEFORGE_FORGEGREEN_FG12E_PERFORMANCE_CHARACTERIZED") process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
