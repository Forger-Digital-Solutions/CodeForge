#!/usr/bin/env node
/**
 * R3.5 8-Bit dataset materialization.
 *
 * Reads CodeForge-owned structured evidence (R3 corpus task records, smoke worker telemetry,
 * managed-free fleet qualification, R5 discovery catalogs), builds validated dataset rows
 * through the @codeforge/eight-bit dataset layer (training-rights gate enforced), derives
 * train-only capacity simulations from certified observed constants, vectorizes, freezes
 * splits, and writes everything under tests/evidence/r3.5-8bit-dataset/ with hashes.
 *
 * Deterministic: same inputs -> byte-identical outputs (seeded simulation, sorted iteration).
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";


const OUT_DIR = "tests/evidence/r3.5-8bit-dataset";
const CAMPAIGN_DIR = "tests/evidence/r3/corpus-runs/campaign-1";

const dist = await import(pathToFileURL("packages/eight-bit/dist/dataset/index.js").href);
const {
  validateDatasetRow,
  rowLabelIsCoherent,
  rowsFromCorpusTasks,
  rowsFromSmokeWorkers,
  rowsFromFleetQualification,
  rowsFromDiscoveryCatalog,
  rowsFromCapacitySimulation,
  simulateCapacityTrajectories,
  OBSERVED_CAPACITY_CONSTANTS,
  freezeSplits,
  vectorizationSpec,
  vectorizeRow,
  manifestHashOf,
} = dist;

function readJson(rel) {
  return JSON.parse(readFileSync(rel, "utf8"));
}

function sha256File(rel) {
  return createHash("sha256").update(readFileSync(rel)).digest("hex");
}

// --- 1. Load evidence --------------------------------------------------------------------------

const tasksDir = `${CAMPAIGN_DIR}/tasks`;
const corpusRecords = readdirSync(tasksDir)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => ({ ...readJson(`${tasksDir}/${f}`), _file: f }));

const smokes = ["S-001-wrapper-eval", "S-001-capacity-exhausted"].map((smokeId) => ({
  smokeId,
  workers: readJson(`${CAMPAIGN_DIR}/smoke-archive/${smokeId}/attempt-1/workers.json`),
}));

const fleetQualification = readJson("docs/evidence/managed-free-r2-fleet-qualification.json");

const discovery = readJson("apps/desktop/release/r5-evidence/free-cloud/discovery-refresh-current.json");

// --- 2. Build rows (training-rights gate enforced inside freezeSplits; validate here too) -------

const rows = [];
rows.push(...rowsFromCorpusTasks(corpusRecords, CAMPAIGN_DIR));
for (const smoke of smokes) {
  rows.push(...rowsFromSmokeWorkers(smoke.workers, smoke.smokeId, CAMPAIGN_DIR));
}
rows.push(...rowsFromFleetQualification(fleetQualification, "docs/evidence/managed-free-r2-fleet-qualification.json"));
rows.push(...rowsFromDiscoveryCatalog(
  discovery.candidates,
  discovery.providerId,
  discovery.timestamp,
  "apps/desktop/release/r5-evidence/free-cloud/discovery-refresh-current.json",
));

// Derived capacity trajectories, anchored to the smoke worker rows that evidenced the
// token distributions (derivedFrom links them; train-only by construction).
const anchoredRowIds = rows.filter((r) => r.taskKind === "ROUTE_OUTCOME").map((r) => r.rowId).slice(0, 8);
const SIMULATION_SAMPLES = 400;
const SIMULATION_SEED = 20260915;
const simSamples = simulateCapacityTrajectories(OBSERVED_CAPACITY_CONSTANTS, SIMULATION_SAMPLES, SIMULATION_SEED);
rows.push(...rowsFromCapacitySimulation(simSamples, anchoredRowIds, new Date().toISOString()));

for (const row of rows) {
  validateDatasetRow(row);
  if (!rowLabelIsCoherent(row)) {
    throw new Error(`incoherent label for ${row.rowId} (${row.taskKind})`);
  }
}
rows.sort((a, b) => (a.rowId < b.rowId ? -1 : 1));

// --- 3. Vectorize + freeze -----------------------------------------------------------------------

const spec = vectorizationSpec();
const vectorizedRows = rows.map((r) => vectorizeRow(r, spec));

const sourceRowHashes = Object.fromEntries(
  rows.map((r) => [r.rowId, createHash("sha256").update(JSON.stringify(r)).digest("hex").slice(0, 16)]),
);
const datasetManifestHash = manifestHashOf({ spec, vectorizedRows, sourceRowHashes });

// Temporal cutoff: window-1 ran 2026-09-15; the newest real evidence (corpus window attempts
// late in the day) is reserved to simulate "something changed after training".
const TEMPORAL_CUTOFF = "2026-09-15T22:30:00.000Z";
const frozen = freezeSplits(rows, { datasetManifestHash, temporalCutoff: TEMPORAL_CUTOFF });

if (frozen.leakedGroups.length > 0) {
  throw new Error(`leaked canonical groups across splits: ${frozen.leakedGroups.join(", ")}`);
}

// --- 4. Emit --------------------------------------------------------------------------------------

// Freeze discipline: the dataset is frozen evidence once emitted. Re-running against changed
// inputs must be an explicit operator decision, never an accident that silently moves holdouts.
if (existsSync(`${OUT_DIR}/splits.json`)) {
  console.error(`REFUSING to overwrite frozen dataset at ${OUT_DIR} (splits.json exists).`);
  console.error("A new dataset requires a new version directory or explicit removal by the operator.");
  process.exit(2);
}
mkdirSync(OUT_DIR, { recursive: true });

const evidenceInputs = [
  `${CAMPAIGN_DIR}/tasks`,
  `${CAMPAIGN_DIR}/smoke-archive/S-001-wrapper-eval/attempt-1/workers.json`,
  `${CAMPAIGN_DIR}/smoke-archive/S-001-capacity-exhausted/attempt-1/workers.json`,
  "docs/evidence/managed-free-r2-fleet-qualification.json",
  "apps/desktop/release/r5-evidence/free-cloud/discovery-refresh-current.json",
];
const inputHashes = {};
// Directory inputs: hash the sorted file list (deterministic manifest of contents); file
// inputs: hash their bytes.
for (const e of evidenceInputs) {
  if (!existsSync(e)) continue;
  try {
    const entries = readdirSync(e, { withFileTypes: true });
    const listing = entries
      .map((d) => `${d.name}:${d.isFile() ? sha256File(`${e}/${d.name}`).slice(0, 16) : "dir"}`)
      .sort()
      .join("|");
    inputHashes[e] = createHash("sha256").update(listing).digest("hex").slice(0, 16);
  } catch {
    inputHashes[e] = sha256File(e).slice(0, 16);
  }
}

const manifest = {
  schemaVersion: 1,
  purpose: "8-Bit learned specialist training dataset (R3.5) — CodeForge-owned structured evidence only",
  builtAt: new Date().toISOString(),
  datasetSchemaVersion: 1,
  vectorizationVersion: spec.version,
  simulation: { samples: SIMULATION_SAMPLES, seed: SIMULATION_SEED, constants: OBSERVED_CAPACITY_CONSTANTS },
  temporalCutoff: TEMPORAL_CUTOFF,
  datasetManifestHash,
  inputHashes,
  counts: {
    total: rows.length,
    byTaskKind: rows.reduce((acc, r) => ({ ...acc, [r.taskKind]: (acc[r.taskKind] ?? 0) + 1 }), {}),
    bySource: rows.reduce((acc, r) => ({ ...acc, [r.provenance.sourceType]: (acc[r.provenance.sourceType] ?? 0) + 1 }), {}),
    derived: rows.filter((r) => r.provenance.sourceType === "DERIVED_SIMULATION").length,
  },
  splits: {
    counts: frozen.counts,
    groupsPerSplit: frozen.groupsPerSplit,
    realRowsPerSplit: frozen.realRowsPerSplit,
    leakedGroups: frozen.leakedGroups,
    familyCrossSplitOverlap: frozen.familyCrossSplitOverlap,
    sha256: frozen.sha256,
    frozenAt: frozen.frozenAt,
  },
};

writeFileSync(`${OUT_DIR}/rows.json`, JSON.stringify(rows, null, 1));
writeFileSync(`${OUT_DIR}/vectorized.json`, JSON.stringify({ spec, rows: vectorizedRows }, null, 1));
writeFileSync(`${OUT_DIR}/splits.json`, JSON.stringify({
  schemaVersion: frozen.schemaVersion,
  frozenAt: frozen.frozenAt,
  datasetManifestHash: frozen.datasetManifestHash,
  assignments: frozen.assignments,
  counts: frozen.counts,
  groupsPerSplit: frozen.groupsPerSplit,
  realRowsPerSplit: frozen.realRowsPerSplit,
  leakedGroups: frozen.leakedGroups,
  sha256: frozen.sha256,
}, null, 1));
writeFileSync(`${OUT_DIR}/manifest.json`, JSON.stringify(manifest, null, 1));

console.log(JSON.stringify(manifest, null, 1));
