// R11.3 definitive POST 40-case aggregate builder.
// Combines the 28 valid original definitive attempts (reconstructed from compact
// telemetry bound to raw per-attempt artifacts) with the clean post-reset
// continuation attempts for cases 29-40, then scores the full public set.
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";

const here = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const root = path.resolve(here, "..", "..", "..", "..");
const telemetry = JSON.parse(await fs.readFile(path.join(here, "definitive-post-partial-telemetry.json"), "utf8"));
const continuationFiles = (process.argv.slice(2).length > 0 ? process.argv.slice(2) : ["definitive-post-continuation-29-40.json"])
  .map((value) => path.resolve(value));
const continuationAttempts = [];
for (const continuationPath of continuationFiles) {
  const parsed = JSON.parse(await fs.readFile(continuationPath, "utf8"));
  if (!Array.isArray(parsed.attempts)) throw new Error(`${continuationPath} does not contain an attempts array`);
  continuationAttempts.push(...parsed.attempts);
}
const benchmark = await import(pathToFileURL(path.join(root, "packages/benchmark/dist/index.js")).href);

const CASE_ORDER = benchmark.CODEFORGE_BENCH_R2_PUBLIC_CASES;
const FROZEN_COMMIT = telemetry.frozenCommit;
const CONFIG_DIGEST = telemetry.configDigest;

function ordinalOf(caseId) {
  return CASE_ORDER.findIndex((item) => item.id === caseId) + 1;
}

const first28 = telemetry.attempts
  .filter((row) => !row[10])
  .map((row) => {
    const [, caseId, runId, status, providerCalls, inputTokens, outputTokens, toolCalls, fileReads, searches] = row;
    return { caseId, runId, status, providerCalls, inputTokens, outputTokens, toolCalls, fileReads, searches };
  });

const reconstructed = [];
for (const row of first28) {
  const rawPath = path.join(here, "raw", row.caseId, row.runId, "attempt.json");
  const raw = JSON.parse(await fs.readFile(rawPath, "utf8"));
  const rawStat = await fs.stat(rawPath);
  const verified = raw.terminalStatus === "completed" && raw.visible.passed && raw.hidden.passed && raw.forgeVerifyPassed;
  const providerFailure = /429|rate.?limit|quota/i.test(raw.terminalError ?? "");
  reconstructed.push({
    caseId: row.caseId,
    runId: row.runId,
    attemptNumber: 1,
    recordedAt: rawStat.mtime.toISOString(),
    repositoryCommit: FROZEN_COMMIT,
    codeforgeCommit: FROZEN_COMMIT,
    mode: "fixed_route",
    configDigest: CONFIG_DIGEST,
    status: raw.terminalStatus,
    verified,
    hiddenAcceptance: raw.hidden.passed ? "passed" : "failed",
    model: { providerId: "openrouter", modelId: "cohere/north-mini-code:free" },
    reason: verified
      ? "Production workflow and independent verifier passed."
      : `terminal=${raw.terminalStatus}; visible=${raw.visible.passed}; hidden=${raw.hidden.passed}; forgeVerify=${raw.forgeVerifyPassed}`,
    routing: { requestedMode: "exact", selectedProviderId: "openrouter", selectedModelId: "cohere/north-mini-code:free", alternativesConsidered: 0, fallbackCount: 0, topology: "solo" },
    verification: {
      verifierId: "r11-r2-independent-fixture-verifier",
      visibleAcceptance: raw.visible.passed ? "passed" : "failed",
      protectedAcceptance: "not_run",
      forgeVerify: raw.forgeVerifyPassed ? "passed" : raw.terminalStatus === "completed" ? "failed" : "blocked",
    },
    metrics: {
      providerCalls: row.providerCalls,
      contextTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      toolCalls: row.toolCalls,
      fileReads: row.fileReads,
      searches: row.searches,
      capacityWaitMs: null,
      wallTimeMs: raw.wallTimeMs,
      estimatedCostUsd: 0,
    },
    ...(verified ? {} : { failure: {
      failureMode: providerFailure ? "provider_rate_limited"
        : !raw.hidden.passed ? "hidden_verifier_failure"
        : !raw.forgeVerifyPassed ? "forgeverify_or_completion_gate"
        : "visible_verifier_failure",
      verifierFindings: raw.hidden.findings,
      hypothesizedLayer: providerFailure ? "provider" : raw.fixtureFamily,
    } }),
    provenance: { source: "original-definitive-attempt", ordinal: ordinalOf(row.caseId), rawArtifact: `r2/raw/${row.caseId}/${row.runId}/attempt.json` },
  });
}

const continued = continuationAttempts.map((attempt) => ({
  ...attempt,
  provenance: { source: "post-reset-clean-continuation", ordinal: ordinalOf(attempt.caseId) },
}));

const merged = [...reconstructed, ...continued].sort((a, b) => ordinalOf(a.caseId) - ordinalOf(b.caseId));
benchmark.validateCodeForgeBenchR2Attempts(merged);

const totals = merged.reduce((acc, attempt) => {
  acc.toolCalls += attempt.metrics?.toolCalls ?? 0;
  acc.providerCalls += attempt.metrics?.providerCalls ?? 0;
  acc.inputTokens += attempt.metrics?.contextTokens ?? 0;
  acc.outputTokens += attempt.metrics?.outputTokens ?? 0;
  acc.wallTimeMs += attempt.metrics?.wallTimeMs ?? 0;
  return acc;
}, { toolCalls: 0, providerCalls: 0, inputTokens: 0, outputTokens: 0, wallTimeMs: 0 });

const falseCompletions = merged.filter((a) => a.status === "completed" && !a.verified);
const providerFailures = merged.filter((a) => a.failure?.failureMode?.startsWith("provider"));
const modelFailures = merged.filter((a) => !a.verified && !a.failure?.failureMode?.startsWith("provider"));
const verifiedSuccesses = merged.filter((a) => a.verified);

const output = {
  schemaVersion: 3,
  benchmarkVersion: benchmark.CODEFORGE_BENCH_R2_VERSION,
  generatedAt: new Date().toISOString(),
  phase: "CODEFORGE_R9_POST_CAPABILITY_BENCHMARK_DEFINITIVE",
  campaign: "r11-definitive-post-final-40",
  frozenCommit: FROZEN_COMMIT,
  configDigest: CONFIG_DIGEST,
  route: { providerId: "openrouter", modelId: "cohere/north-mini-code:free", routingMode: "fixed_route" },
  aggregationPolicy: [
    "Ordinals 1-28 reuse the valid original definitive attempts; quota-contaminated attempts (r2/live-post-continuation.json) are excluded from scoring and preserved separately as infrastructure evidence.",
    "Ordinals 29-40 are clean post-reset attempts executed after the 2026-09-18 daily-quota reset under the same frozen commit, adapter, route, governor, and verifier policy.",
    "Every attempt traces to r2/raw/<case>/<runId>/attempt.json.",
  ],
  summary: benchmark.summarizeCodeForgeBenchR2(merged, CASE_ORDER),
  definitiveMetrics: {
    totalCases: merged.length,
    verifiedSuccesses: verifiedSuccesses.length,
    failures: merged.length - verifiedSuccesses.length,
    passAt1: verifiedSuccesses.length / merged.length,
    falseCompletions: falseCompletions.length,
    falseCompletionCaseIds: falseCompletions.map((a) => a.caseId),
    modelFailures: modelFailures.length,
    providerFailures: providerFailures.length,
    infrastructureFailures: providerFailures.length,
    manualInterventions: 0,
    totals,
    perCase: merged.map((a) => ({
      ordinal: ordinalOf(a.caseId),
      caseId: a.caseId,
      status: a.status,
      verified: a.verified,
      hiddenAcceptance: a.hiddenAcceptance,
      toolCalls: a.metrics?.toolCalls ?? null,
      providerCalls: a.metrics?.providerCalls ?? null,
      inputTokens: a.metrics?.contextTokens ?? null,
      outputTokens: a.metrics?.outputTokens ?? null,
      wallTimeMs: a.metrics?.wallTimeMs ?? null,
      failureMode: a.failure?.failureMode ?? null,
      provenance: a.provenance.source,
    })),
  },
  attempts: merged,
};

const outPath = path.join(here, "definitive-post-final-40.json");
await fs.writeFile(outPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
console.log(`wrote ${outPath}`);
console.log(JSON.stringify({
  total: output.definitiveMetrics.totalCases,
  verified: output.definitiveMetrics.verifiedSuccesses,
  passAt1: output.definitiveMetrics.passAt1,
  falseCompletions: output.definitiveMetrics.falseCompletions,
  providerFailures: output.definitiveMetrics.providerFailures,
}, null, 1));
