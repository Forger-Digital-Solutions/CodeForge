// Aggregates the R21 ForgeVerify evidence (suite JSONL from `R21_EVIDENCE_DIR` + chaos sweeps)
// into the campaign's primary safety metrics: false-positive completions, false blocking,
// stale-evidence detections, integrity rejections, classification counts, and the corpus
// verdict table. Usage: node scripts/r21-forgeverify-metrics.mjs [evidenceDir]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = process.argv[2] ?? path.join(here, "..", "docs", "evidence", "r21-intelligence-closure", "01-forgeverify");
const suiteDir = path.join(dir, "suite");

function readJsonl(name) {
  const file = path.join(suiteDir, `${name}.jsonl`);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}
function readJson(name) {
  const file = path.join(dir, name);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}

const corpus = readJsonl("forgeverify-malicious-corpus");
const stale = readJsonl("forgeverify-stale-evidence-matrix");
const integrity = readJsonl("forgeverify-integrity");
const gate = readJsonl("completion-gate-binding");
const chaosSqlite = readJson("forgeverify-chaos-sqlite.json");
const chaosPg = readJson("forgeverify-chaos-multi-instance-postgres.json");

// Corpus: the latest record per case wins (suites may run more than once).
const latestByCase = new Map();
for (const record of corpus) latestByCase.set(record.case, record);
const corpusCases = [...latestByCase.values()];
const caught = corpusCases.filter((record) => record.expected !== "BOUNDARY" && !String(record.expected).startsWith("BOUNDARY_") && !record.falseCompletion);
const boundary = corpusCases.filter((record) => record.expected === "BOUNDARY" || String(record.expected).startsWith("BOUNDARY_"));
const falseCompletions = corpusCases.filter((record) => record.falseCompletion === true);
const genuine = corpusCases.find((record) => record.case === "genuine-runner-summaries");

const staleByScenario = new Map();
for (const record of stale) staleByScenario.set(record.scenario, record);
const staleScenarios = [...staleByScenario.values()];

const chaos = [chaosSqlite, chaosPg].filter(Boolean);

const metrics = {
  schemaVersion: 1,
  campaign: "R21 ForgeVerify recertification — primary safety metrics",
  recordedAt: new Date().toISOString(),
  primary: {
    falsePositiveCompletions: {
      corpus: falseCompletions.length,
      staleMatrix: staleScenarios.filter((record) => record.falseCompletion === true).length,
      chaos: chaos.reduce((sum, sweep) => sum + sweep.falseCompletions, 0),
      total: falseCompletions.length + staleScenarios.filter((record) => record.falseCompletion === true).length + chaos.reduce((sum, sweep) => sum + sweep.falseCompletions, 0),
    },
    falseBlocking: {
      genuineRunnerSummariesSampled: genuine?.samples ?? 0,
      genuineRunnerSummariesBlocked: genuine?.falseBlocking ?? null,
      staleMatrixUnchangedWorkspaceCompleted: staleScenarios.filter((record) => ["baseline_unchanged", "restored_file_after_restore"].includes(record.scenario)).every((record) => record.outcome === "completed"),
      chaosLegitimateCompletions: chaos.map((sweep) => ({ backend: sweep.backend, legitimateCompletions: sweep.legitimateCompletions })),
    },
  },
  classification: {
    corpusCases: corpusCases.length,
    caughtAsRequired: caught.length,
    documentedBoundaries: boundary.map((record) => ({ case: record.case, boundary: record.boundary })),
    noTestsDiscoveredDetected: corpusCases.filter((record) => record.noTestsDiscovered === true).map((record) => record.case),
    contradictoryOutputDetected: corpusCases.filter((record) => record.contradictoryOutput === true).map((record) => record.case),
    timedOut: corpusCases.filter((record) => record.verifierStatus === "timed_out").map((record) => record.case),
    infraOrKilled: corpusCases.filter((record) => ["infra_error", "failed"].includes(record.verifierStatus) && ["missing-executable", "killed-process"].includes(record.case)).map((record) => ({ case: record.case, status: record.verifierStatus, exitCode: record.exitCode })),
  },
  staleEvidence: {
    scenarios: staleScenarios.length,
    detections: staleScenarios.filter((record) => (record.blockers ?? []).includes("verification_not_current")).length,
    byScenario: Object.fromEntries(staleScenarios.map((record) => [record.scenario, record.outcome])),
  },
  integrity: {
    cases: integrity.length,
    singleFieldMutationsCovered: integrity.find((record) => record.case === "single_field_mutations")?.fieldsCovered ?? 0,
    allMutationsRejected: integrity.find((record) => record.case === "single_field_mutations")?.allRejected ?? null,
    malformedVariantsRejected: integrity.find((record) => record.case === "malformed_records")?.variants ?? 0,
    remintedForgeryBoundary: integrity.find((record) => record.case === "reminted_forgery_boundary") ?? null,
  },
  gateBinding: { cases: gate.length, outcomes: gate.map((record) => ({ case: record.case, outcome: record.outcome ?? record.structured })) },
  chaos: chaos.map((sweep) => ({ backend: sweep.backend, cases: sweep.cases, killed: sweep.killedCases, falseCompletions: sweep.falseCompletions, legitimateCompletions: sweep.legitimateCompletions, gateProcessFailures: sweep.gateProcessFailures, killPoints: [...new Set(sweep.results.map((r) => r.killPoint))] })),
  verificationLatency: chaos.length
    ? { workerWallMsMedianUnkilled: median(chaos.flatMap((sweep) => sweep.results.filter((r) => !r.worker.killed).map((r) => r.worker.durationMs))), note: "worker wall time includes a deliberate 1.5 s sleep inside the verifier fixture; see FG-12E for the ~140 ms input-state-hash cost measured separately" }
    : null,
};

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

fs.writeFileSync(path.join(dir, "forgeverify-metrics.json"), `${JSON.stringify(metrics, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(metrics.primary, null, 2)}\n→ ${path.join(dir, "forgeverify-metrics.json")}\n`);
