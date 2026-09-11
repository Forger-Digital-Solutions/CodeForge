#!/usr/bin/env node
// FG-11 real shadow-evidence campaign orchestration. Zero-cash, zero-network: every task drives
// real production components (ContextPlanner, RepositoryIntelligence, ForgeVerify,
// DuplicateActionSupervisor) against small disposable local git fixtures with deterministic
// verifier commands (`node --check`) — no model/provider calls anywhere in this script.
import path from "node:path";
import fs from "node:fs";
import {
  freezeCampaignIdentity,
  SourceStateDriftError,
  createObservationStore,
  buildCampaignAggregateReport,
  runAllTasks,
} from "@codeforge/forgegreen-campaign";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const observationsDir = path.join(repoRoot, "docs", "fg11", "observations");

function readinessFor(kind, aggregate, thresholds) {
  if (aggregate.unsafeFalsePositives > 0) return "BLOCKED_BY_FALSE_POSITIVES";
  const meetsFloor = aggregate.eligible >= thresholds.minEligible && aggregate.controlCases >= thresholds.minControls;
  if (!meetsFloor) return "NOT_ENOUGH_EVIDENCE";
  const hasMeaningfulSignal = kind === "D" ? aggregate.validated > 0 : aggregate.validated > 0;
  if (!hasMeaningfulSignal) return "NOT_ELIGIBLE";
  return "READY_FOR_CONTROLLED_ACTIVE_TRIAL";
}

async function main() {
  console.log("FG-11 campaign: verifying certified source-state + freezing campaign-harness identity...");
  let identity;
  try {
    identity = freezeCampaignIdentity(repoRoot);
  } catch (error) {
    if (error instanceof SourceStateDriftError) {
      console.error("FG11_SOURCE_STATE_DRIFT");
      console.error(JSON.stringify(error.detail, null, 2));
      process.exitCode = 1;
      return;
    }
    throw error;
  }
  console.log(`FG11_CAMPAIGN_SOURCE_STATE = ${identity.certifiedSourceStateId}`);
  console.log(`campaignHarnessId          = ${identity.campaignHarnessId}`);

  const storeFactory = () => createObservationStore(observationsDir);
  const store = storeFactory();
  const ctx = { store, identity };

  console.log("Running the FG-11 task corpus (real production components, deterministic, $0.00)...");
  const results = await runAllTasks(ctx, storeFactory);
  const totalInserted = results.reduce((sum, r) => sum + r.observationsInserted, 0);
  console.log(`Task corpus complete: ${results.length} task-runs, ${totalInserted} new observations ingested.`);

  const allObservations = [
    ...store.all("A"),
    ...store.all("B"),
    ...store.all("C"),
    ...store.all("D"),
  ];
  const report = buildCampaignAggregateReport(allObservations, identity);

  const thresholds = {
    A: { minEligible: 0, minControls: 0 },
    B: { minEligible: 25, minControls: 5 },
    C: { minEligible: 25, minControls: 5 },
    D: { minEligible: 20, minControls: 5 },
  };
  const readiness = {
    B: readinessFor("B", report.candidates.B, thresholds.B),
    C: readinessFor("C", report.candidates.C, thresholds.C),
    D: readinessFor("D", report.candidates.D, thresholds.D),
  };

  const artifact = {
    schemaVersion: "fg11-campaign-artifact-1",
    generatedAt: report.generatedAt,
    certifiedSourceStateId: identity.certifiedSourceStateId,
    campaignHarnessId: identity.campaignHarnessId,
    taskRuns: results.length,
    observationsInsertedThisRun: totalInserted,
    thresholds,
    readiness,
    excludedBuckets: report.excludedBuckets,
    candidates: report.candidates,
  };

  const jsonPath = path.join(repoRoot, "docs", "codeforge-forgegreen-fg11-shadow-campaign.json");
  fs.writeFileSync(jsonPath, JSON.stringify(artifact, null, 2));

  const md = renderMarkdownReport(artifact);
  const mdPath = path.join(repoRoot, "docs", "codeforge-forgegreen-fg11-shadow-campaign-report.md");
  fs.writeFileSync(mdPath, md);

  console.log(`Wrote ${jsonPath}`);
  console.log(`Wrote ${mdPath}`);
  console.log("Readiness:", JSON.stringify(readiness));
}

function candidateSection(kind, label, agg, extra = "") {
  return `## Candidate ${kind} — ${label}

- total: ${agg.total}
- eligible: ${agg.eligible}
- validated: ${agg.validated}
- invalidated: ${agg.invalidated}
- incomplete: ${agg.incomplete}
- insufficientEvidence: ${agg.insufficientEvidence}
- uniqueRuns: ${agg.uniqueRuns}
- uniqueFingerprints: ${agg.uniqueFingerprints}
- controlCases: ${agg.controlCases}
- unsafeFalsePositives: ${agg.unsafeFalsePositives}
- observerOverhead: total ${agg.observerOverhead.totalMs}ms, mean ${agg.observerOverhead.meanMs.toFixed(2)}ms, median ${agg.observerOverhead.medianMs}ms, max ${agg.observerOverhead.maxMs}ms (n=${agg.observerOverhead.callCount})
- diversity dimensions: ${JSON.stringify(agg.diversityDimensions)}
- invalidation reasons: ${JSON.stringify(agg.invalidationReasonDistribution)}
${kind === "A" ? `- ACTUAL avoided work (never combined with B/C/D projections): ${JSON.stringify(agg.actualTotals)}` : `- PROJECTED avoided work (label is always PROJECTED, never ACTUAL): ${JSON.stringify(agg.projectedTotals)}`}
${extra}
`;
}

function renderMarkdownReport(artifact) {
  const { candidates, readiness } = artifact;
  return `# ForgeGreen FG-11 Real Shadow Evidence Campaign Report

Generated: ${artifact.generatedAt}

- certifiedSourceStateId (FG11_CAMPAIGN_SOURCE_STATE): \`${artifact.certifiedSourceStateId}\`
- campaignHarnessId: \`${artifact.campaignHarnessId}\`
- task-runs executed this invocation: ${artifact.taskRuns}
- observations newly inserted this invocation: ${artifact.observationsInsertedThisRun}
- excluded buckets (different source-state/harness identity, never aggregated in): ${JSON.stringify(artifact.excludedBuckets)}

${candidateSection("A", "DUPLICATE_READ_ONLY_TOOL_REUSE (ACTIVE_SAFE positive control)", candidates.A)}
${candidateSection("B", "DUPLICATE_CONTEXT_PAGE_TRANSMISSION (SHADOW)", candidates.B, `- readiness: **${readiness.B}**`)}
${candidateSection("C", "OPTIONAL_PREFETCH_SUPPRESSION (SHADOW)", candidates.C, `- readiness: **${readiness.C}**`)}
${candidateSection("D", "VERIFICATION_EVIDENCE_REUSE (SHADOW)", candidates.D, `- readiness: **${readiness.D}**`)}

## Notes

- B/C/D remained SHADOW throughout — zero intervention, zero execution change.
- Fresh ForgeVerify evidence was always produced for every Candidate D observation (no reuse-short-circuit was ever taken during observation collection).
- Energy/Carbon: \`INSUFFICIENT_DATA\` — no new hardware telemetry was introduced by this campaign.
`;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
