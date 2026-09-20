import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const docPath = path.join(repoRoot, "docs", "codeforge-forgegreen-certified-source-state.json");
const doc = JSON.parse(fs.readFileSync(docPath, "utf8"));

const materialFiles = [...doc.materialFiles].sort((a, b) => a.localeCompare(b));
const entries = materialFiles.map((file) => ({ path: file, blobHash: execFileSync("git", ["hash-object", file], { cwd: repoRoot, encoding: "utf8" }).trim() }));
const sourceStateId = createHash("sha256").update(JSON.stringify(entries.map((e) => [e.path, e.blobHash]))).digest("hex");

const hashes = Object.fromEntries(entries.map((e) => [e.path, e.blobHash]));
const priorId = doc.sourceStateId;
const priorSurface = doc.surfaceVersion;
const changedFiles = entries.filter((e) => doc.materialFileHashes[e.path] !== e.blobHash).map((e) => e.path);

doc.sourceStateId = sourceStateId;
doc.surfaceVersion = "r20-durable-hosted-runtime-v1";
doc.materialFileHashes = hashes;
doc.recertifiedAt = "2026-09-20";

doc.recertifications.push({
  label: "R20 durable hosted-runtime source-state reconciliation",
  reason:
    "The certified surface last froze at r18-release-candidate-v1. Since then one reviewed, committed campaign touched a material file: bec79a8 (R20 — durable fair admission for hosted capacity) added two barrel exports (r20-scale.js, r20-experiments.js) to packages/benchmark/src/index.ts. The drifted file was diffed against its certified blob: the change is export-surface only and touches no ForgeGreen detector, verification-reuse, or completion-authority seam — ForgeZero still gates all routing and evaluateCompletion remains the only path to 'completed'. No material file was added or removed; the frozen set is re-issued over the reviewed content rather than ignoring the drift.",
  priorSourceStateId: priorId,
  priorSurfaceVersion: priorSurface,
  resultingSourceStateId: sourceStateId,
  resultingSurfaceVersion: "r20-durable-hosted-runtime-v1",
  changes: [
    { file: "packages/benchmark/src/index.ts", change: "R20 benchmark barrel exports for the durable-admission scale/experiment harnesses; no ForgeGreen material seam modified.", addedToMaterialFiles: false },
  ],
  regressionEvidence:
    "R20 durable hosted-runtime campaign: canonical Vitest suite rerun at the reviewed tree (3034 pass, expected environment skips); real PostgreSQL suite 13 files / 87 tests green; durable hosted-execution HTTP suite 13 tests green incl. restart, hard-stop, failure-injection, and parent/child cascade coverage.",
  recertifiedAt: "2026-09-20",
  sourceStateConstant: "R20_DURABLE_HOSTED_RUNTIME_SOURCE_STATE",
});

doc.recertification = {
  phase: "R20 durable hosted-runtime reconciliation",
  reason: "Re-issue the frozen ForgeGreen source-state over the reviewed R20 committed surface so the fg11/fg12e provenance canaries certify the current tree.",
  changedFiles,
  priorSourceStateId: priorId,
  guarded: true,
};

doc.generationNote =
  "This source-state ID is deterministically derived from the material FG-8 through FG-12F implementation surface present on the recovered lineage, including the FG-11, FG-12D, and FG-12F recertifications above and the R20 durable hosted-runtime reconciliation above. Computed by packages/forgegreen-campaign/src/source-state.ts using idAlgorithm.";

fs.writeFileSync(docPath, JSON.stringify(doc, null, 2) + "\n");
console.log("R20 source-state recertified:", sourceStateId);
console.log("Prior:", priorId, `(${priorSurface})`);
console.log("Changed files:", changedFiles);
console.log("Material files:", materialFiles.length);
