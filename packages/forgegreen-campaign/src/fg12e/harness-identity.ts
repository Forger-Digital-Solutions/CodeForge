import { computeCampaignHarnessId, computeContentStateId, loadCertifiedSourceState, SourceStateDriftError, verifyCertifiedSourceState, type ContentStateId } from "../source-state.js";

/**
 * FG-12E benchmark-harness identity (spec §30/§31). Deliberately SEPARATE from
 * `CAMPAIGN_HARNESS_FILES` (the FG-11/FG-12D harness id, which stays byte-stable) and from the
 * certified Candidate D source-state (which FG-12E does not touch). Covers benchmark
 * definitions, pairing, timing, statistics, orchestration, and report generation.
 */
export const FG12E_BENCHMARK_HARNESS_FILES: readonly string[] = [
  "packages/forgegreen-campaign/src/fg12e/timing.ts",
  "packages/forgegreen-campaign/src/fg12e/workloads.ts",
  "packages/forgegreen-campaign/src/fg12e/pair-runner.ts",
  "packages/forgegreen-campaign/src/fg12e/workload-runner.ts",
  "packages/forgegreen-campaign/src/fg12e/component-profile.ts",
  "packages/forgegreen-campaign/src/fg12e/restart-fallback-bench.ts",
  "packages/forgegreen-campaign/src/fg12e/break-even.ts",
  "packages/forgegreen-campaign/src/fg12e/harness-identity.ts",
  "packages/forgegreen-campaign/src/fg12e/report.ts",
  "scripts/forgegreen-fg12e-performance-trial.mjs",
];

export function computeFg12eHarnessId(repoRoot: string): ContentStateId {
  return computeContentStateId(repoRoot, FG12E_BENCHMARK_HARNESS_FILES);
}

export interface Fg12eIdentity {
  /** The certified Candidate D implementation surface — must equal the FG-12D id; drift blocks. */
  certifiedSourceStateId: string;
  /** The FG-11/FG-12D campaign harness id — recorded so the FG-12D lineage is traceable. */
  fg12dCampaignHarnessId: string;
  fg12eHarnessId: string;
}

export function freezeFg12eIdentity(repoRoot: string): Fg12eIdentity {
  const certified = loadCertifiedSourceState(repoRoot);
  const check = verifyCertifiedSourceState(repoRoot, certified);
  if (!check.stable) throw new SourceStateDriftError("FG12E_SOURCE_STATE_DRIFT", check);
  return {
    certifiedSourceStateId: check.currentId,
    fg12dCampaignHarnessId: computeCampaignHarnessId(repoRoot).id,
    fg12eHarnessId: computeFg12eHarnessId(repoRoot).id,
  };
}
