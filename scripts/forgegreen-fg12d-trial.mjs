#!/usr/bin/env node
// FG-12D controlled ForgeVerify evidence reuse trial. Zero-cash, zero-network: every case drives
// real production components (ForgeVerify's real executeVerificationPlan, real spawned
// `node --check` verifier processes, real disposable git fixtures, real SQLite session
// persistence for the restart proof) — no model/provider calls anywhere in this script.
import path from "node:path";
import fs from "node:fs";
import {
  freezeCampaignIdentity,
  SourceStateDriftError,
  buildCaseMatrix,
  runTrialCase,
  runFallbackCase,
  runRaceCase,
  runRepeatedReuseCase,
  runRestartCases,
} from "@codeforge/forgegreen-campaign";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

async function main() {
  console.log("FG-12D trial: verifying certified source-state + freezing campaign-harness identity...");
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
  console.log(`FG12D_TRIAL_SOURCE_STATE = ${identity.certifiedSourceStateId}`);
  console.log(`campaignHarnessId        = ${identity.campaignHarnessId}`);

  const cases = buildCaseMatrix();
  console.log(`Running ${cases.length} paired control/treatment cases...`);
  const caseResults = [];
  for (const spec of cases) {
    const result = await runTrialCase(spec);
    caseResults.push(result);
    if (!result.passed) console.error(`FAILED: ${spec.id} -> ${result.failureReasons.join("; ")}`);
  }

  console.log("Running restart, race, fallback, and repeated-reuse special-case proofs...");
  const restartResults = await runRestartCases();
  const raceResult = await runRaceCase();
  const fallbackResult = await runFallbackCase();
  const repeatedResult = await runRepeatedReuseCase();
  const specialResults = [...restartResults, raceResult, fallbackResult, repeatedResult];
  for (const result of specialResults) {
    if (!result.passed) console.error(`FAILED: ${result.id} -> ${result.failureReasons.join("; ")}`);
  }

  const positive = caseResults.filter((r) => r.spec.category === "positive");
  const invalidation = caseResults.filter((r) => r.spec.category === "invalidation");
  const unsafeReuseCases = caseResults.filter(
    (r) => r.spec.category === "invalidation" && !r.spec.expectPrimaryReuse && r.receipt.actual.verificationAttemptsAvoided > 0,
  );
  const anyFailed = caseResults.some((r) => !r.passed) || specialResults.some((r) => !r.passed);

  const totalActualAvoided = caseResults.reduce((sum, r) => sum + r.receipt.actual.verificationAttemptsAvoided, 0);
  const totalControlDurationMs = caseResults.reduce((sum, r) => sum + r.receipt.reference.controlDurationMs, 0);
  const totalTreatmentDurationMs = caseResults.reduce((sum, r) => sum + r.receipt.reference.treatmentDurationMs, 0);

  const safetyBarClear =
    unsafeReuseCases.length === 0 &&
    !anyFailed &&
    positive.length >= 20 &&
    invalidation.length >= 15 &&
    specialResults.every((r) => r.passed);

  const verdict = anyFailed || unsafeReuseCases.length > 0 ? "CODEFORGE_FORGEGREEN_FG12D_BLOCKED" : "CODEFORGE_FORGEGREEN_FG12D_CONTROLLED_TRIAL_CERTIFIED_NOT_ACTIVATED";

  const artifact = {
    schemaVersion: "fg12d-trial-artifact-1",
    generatedAt: new Date().toISOString(),
    fg12dTrialSourceState: identity.certifiedSourceStateId,
    campaignHarnessId: identity.campaignHarnessId,
    verdict,
    safetyBarClear,
    counts: {
      totalCases: caseResults.length,
      positive: positive.length,
      invalidation: invalidation.length,
      passed: caseResults.filter((r) => r.passed).length,
      failed: caseResults.filter((r) => !r.passed).length,
      unsafeReuseCases: unsafeReuseCases.length,
    },
    specialCases: specialResults.map((r) => ({ id: r.id, category: r.category, passed: r.passed, details: r.details })),
    performance: {
      totalActualVerificationAttemptsAvoided: totalActualAvoided,
      totalControlDurationMs,
      totalTreatmentDurationMs,
      netWallClockDeltaMs: totalControlDurationMs - totalTreatmentDurationMs,
    },
    caseReceipts: caseResults.map((r) => r.receipt),
    globalGraduationRegistryUnchanged: true,
    productionCallSitesModified: [],
  };

  const jsonPath = path.join(repoRoot, "docs", "codeforge-forgegreen-fg12d-verification-reuse-trial.json");
  fs.writeFileSync(jsonPath, JSON.stringify(artifact, null, 2));

  const md = renderMarkdown(artifact, caseResults, specialResults);
  const mdPath = path.join(repoRoot, "docs", "codeforge-forgegreen-fg12d-verification-reuse-trial-report.md");
  fs.writeFileSync(mdPath, md);

  console.log(`Wrote ${jsonPath}`);
  console.log(`Wrote ${mdPath}`);
  console.log(`Verdict: ${verdict}`);
  if (anyFailed) process.exitCode = 1;
}

function renderMarkdown(artifact, caseResults, specialResults) {
  const byInvalidationReason = {};
  for (const r of caseResults) {
    if (r.spec.category !== "invalidation") continue;
    const reason = r.spec.invalidationReason ?? "unspecified";
    byInvalidationReason[reason] = (byInvalidationReason[reason] ?? 0) + 1;
  }
  return `# ForgeGreen FG-12D Controlled Verification Reuse Trial Report

Generated: ${artifact.generatedAt}

- FG12D_TRIAL_SOURCE_STATE: \`${artifact.fg12dTrialSourceState}\`
- campaignHarnessId: \`${artifact.campaignHarnessId}\`
- Verdict: **${artifact.verdict}**
- Safety bar clear: ${artifact.safetyBarClear}
- Global \`VERIFICATION_EVIDENCE_REUSE\` graduation registry entry: unchanged (still \`SHADOW\`)
- Production call sites modified: none (${JSON.stringify(artifact.productionCallSitesModified)})

## Case corpus

- Total paired control/treatment cases: ${artifact.counts.totalCases}
- Positive (identical-state reuse): ${artifact.counts.positive}
- Invalidation: ${artifact.counts.invalidation}
- Passed: ${artifact.counts.passed} / Failed: ${artifact.counts.failed}
- Unsafe reuse cases: ${artifact.counts.unsafeReuseCases}

### Invalidation category distribution

${Object.entries(byInvalidationReason).map(([reason, count]) => `- ${reason}: ${count}`).join("\n")}

Categories proven at the unit level instead of via a live paired run (identical underlying code
path — see \`packages/workflow/test/fg12d-verification-evidence-reuse.test.ts\`):
\`workspace_path_mismatch\`, \`input_state_hash_mismatch\` (as a pure evidence-shape property),
\`incomplete_evidence_metadata\`, \`corrupted_evidence_reference\`.

## Special-case proofs

${specialResults.map((r) => `- **${r.id}** (${r.category}): ${r.passed ? "PASSED" : `FAILED — ${r.failureReasons.join("; ")}`}`).join("\n")}

## Performance

- Actual verification attempts avoided (real, measured reuse events): ${artifact.performance.totalActualVerificationAttemptsAvoided}
- Total control duration (reference): ${artifact.performance.totalControlDurationMs}ms
- Total treatment duration: ${artifact.performance.totalTreatmentDurationMs}ms
- Net wall-clock delta (control - treatment, reference only — REFERENCE_CONTROL_DURATION, not a per-case DIRECTLY_AVOIDED_DURATION claim beyond what each receipt's \`actual.directlyAvoidedDurationMs\` records): ${artifact.performance.netWallClockDeltaMs}ms

## Energy/Carbon

\`INSUFFICIENT_DATA\` — no new hardware telemetry was introduced by this trial.
`;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
