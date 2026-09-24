#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const docPath = path.join(repoRoot, "docs", "codeforge-forgegreen-certified-source-state.json");
const doc = JSON.parse(fs.readFileSync(docPath, "utf8"));
const priorSourceStateId = "5314df384678807aed7ca06d63c921cc35c2996e6ec2592fee479c2b97be0056";
const priorSurfaceVersion = "r32-autonomy-perfection-v1";
const changes = [
  {
    file: "packages/server/src/workflow-service.ts",
    change: "R32 follow-on: checkStatedContracts scans the raw task message in addition to extracted goals — a contract stated anywhere in the task binds even when goal extraction slices the message (live evidence showed .ts extensions shredding goals and hiding the stated ValidationResult contract).",
    addedToMaterialFiles: false,
  },
];

if (doc.sourceStateId !== priorSourceStateId || doc.surfaceVersion !== priorSurfaceVersion) {
  throw new Error("R32 recertification refused: the certified predecessor changed.");
}
if (!Array.isArray(doc.materialFiles) || !Array.isArray(doc.recertifications)) {
  throw new Error("R32 recertification refused: source-state document shape is invalid.");
}
const materialFiles = [...doc.materialFiles].sort((a, b) => a.localeCompare(b));
if (new Set(materialFiles).size !== materialFiles.length) {
  throw new Error("R32 recertification refused: duplicate material files.");
}
const entries = materialFiles.map((file) => ({
  path: file,
  blobHash: execFileSync("git", ["hash-object", file], { cwd: repoRoot, encoding: "utf8" }).trim(),
}));
const changedFiles = entries.filter((entry) => doc.materialFileHashes?.[entry.path] !== entry.blobHash).map((entry) => entry.path);
const expectedFiles = changes.map((change) => change.file).sort((a, b) => a.localeCompare(b));
if (JSON.stringify(changedFiles) !== JSON.stringify(expectedFiles)) {
  throw new Error(`R32 recertification refused: unreviewed drift ${JSON.stringify(changedFiles)}.`);
}
const uncommittedMaterial = execFileSync("git", ["status", "--porcelain", "--", ...materialFiles], { cwd: repoRoot, encoding: "utf8" }).trim();
if (uncommittedMaterial) {
  throw new Error(`R32 recertification refused: material source has uncommitted edits: ${uncommittedMaterial}`);
}

const sourceStateId = createHash("sha256").update(JSON.stringify(entries.map((entry) => [entry.path, entry.blobHash]))).digest("hex");
const surfaceVersion = "r32-autonomy-perfection-v2";
const recertifiedAt = new Date().toISOString();
const recertification = {
  label: "R32 follow-on — stated-contract source widened to raw task text",
  reason: "Re-issue the R32 source-state after a live-evidence-driven amendment: checkStatedContracts now scans intent.rawMessage so stated contracts bind regardless of goal-slicing. Companion fix in packages/workflow/src/task-intelligence.ts (non-material) stops sentence-splitting on file-extension dots. No gate relaxed.",
  priorSourceStateId,
  priorSurfaceVersion,
  resultingSourceStateId: sourceStateId,
  resultingSurfaceVersion: surfaceVersion,
  changes,
  regressionEvidence: "R32 live acceptance batch receipts under docs/evidence/r32-autonomy-perfection/10-live-acceptance; deterministic starvation/contract matrix green in workflow-goal-review.test.ts; packaged live-provider proof in 30-packaged-live-proof. Final post-recertification regression is recorded in the R32 certification document.",
  recertifiedAt: recertifiedAt.slice(0, 10),
  sourceStateConstant: "CODEFORGE_R32_AUTONOMY_PERFECTION_V2_SOURCE_STATE",
};

doc.sourceStateId = sourceStateId;
doc.surfaceVersion = surfaceVersion;
doc.materialFiles = materialFiles;
doc.materialFileHashes = Object.fromEntries(entries.map((entry) => [entry.path, entry.blobHash]));
doc.recertifications.push(recertification);
doc.recertifiedAt = recertifiedAt;
doc.recertification = {
  phase: recertification.label,
  reason: recertification.reason,
  changedFiles,
  priorSourceStateId,
  guarded: true,
};
doc.recertificationReason = recertification.reason;
doc.generationNote = "This source-state ID is deterministically derived from the reviewed FG-8 through R32 material implementation surface by packages/forgegreen-campaign/src/source-state.ts using idAlgorithm. Historical campaign evidence remains bound to its recorded source-state identity.";

const temporaryPath = `${docPath}.r32-recertification.tmp`;
fs.writeFileSync(temporaryPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
fs.renameSync(temporaryPath, docPath);
console.log(JSON.stringify({ sourceStateId, surfaceVersion, changedFiles, materialFileCount: materialFiles.length }));
