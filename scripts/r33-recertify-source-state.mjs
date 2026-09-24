#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const docPath = path.join(repoRoot, "docs", "codeforge-forgegreen-certified-source-state.json");
const doc = JSON.parse(fs.readFileSync(docPath, "utf8"));
const priorSourceStateId = "acec20dffe5b0f856ca6b8165474ba3424be27a266e2451b85e32eaedacb6274";
const priorSurfaceVersion = "r32-autonomy-perfection-v2";
const changedFilesExpected = ["packages/server/src/workflow-service.ts"];

if (doc.sourceStateId !== priorSourceStateId || doc.surfaceVersion !== priorSurfaceVersion) {
  throw new Error("R33 recertification refused: certified predecessor changed.");
}
if (!Array.isArray(doc.materialFiles) || !Array.isArray(doc.recertifications)) {
  throw new Error("R33 recertification refused: source-state document shape is invalid.");
}
const materialFiles = [...doc.materialFiles].sort((a, b) => a.localeCompare(b));
if (new Set(materialFiles).size !== materialFiles.length) {
  throw new Error("R33 recertification refused: duplicate material files.");
}
const entries = materialFiles.map((file) => ({
  path: file,
  blobHash: execFileSync("git", ["hash-object", file], { cwd: repoRoot, encoding: "utf8" }).trim(),
}));
const changedFiles = entries.filter((entry) => doc.materialFileHashes?.[entry.path] !== entry.blobHash).map((entry) => entry.path);
if (JSON.stringify(changedFiles) !== JSON.stringify(changedFilesExpected)) {
  throw new Error(`R33 recertification refused: unreviewed drift ${JSON.stringify(changedFiles)}.`);
}
const uncommittedMaterial = execFileSync("git", ["status", "--porcelain", "--", ...materialFiles], { cwd: repoRoot, encoding: "utf8" }).trim();
if (uncommittedMaterial) {
  throw new Error(`R33 recertification refused: material source has uncommitted edits: ${uncommittedMaterial}`);
}

const sourceStateId = createHash("sha256").update(JSON.stringify(entries.map((entry) => [entry.path, entry.blobHash]))).digest("hex");
const surfaceVersion = "r33-free-capacity-fabric-interim-v1";
const recertifiedAt = new Date().toISOString();
const reason = "Record the reviewed R33 removal of the default fixed workflow inference-request envelope. Explicit diagnostic envelopes remain, and fail-closed goal review, ForgeVerify, and evaluateCompletion authority are unchanged. This is an interim source identity, not final R33 release certification.";
const recertification = {
  label: "R33 interim free-capacity workflow change",
  reason,
  priorSourceStateId,
  priorSurfaceVersion,
  resultingSourceStateId: sourceStateId,
  resultingSurfaceVersion: surfaceVersion,
  changes: [{
    file: "packages/server/src/workflow-service.ts",
    change: "Normal runs no longer construct a fixed total/reserve inference-request envelope; an envelope is created only when explicitly configured for a controlled test or operator diagnostic. Review remains fail-closed on an inconclusive verdict.",
    addedToMaterialFiles: false,
  }],
  regressionEvidence: "docs/evidence/r33-free-capacity-fabric/INTERIM-CERTIFICATION.md; focused workflow goal-review suite, full TypeScript build, and current canonical regression status recorded there.",
  recertifiedAt: recertifiedAt.slice(0, 10),
  sourceStateConstant: "CODEFORGE_R33_INTERIM_FREE_CAPACITY_SOURCE_STATE",
};

doc.sourceStateId = sourceStateId;
doc.surfaceVersion = surfaceVersion;
doc.materialFiles = materialFiles;
doc.materialFileHashes = Object.fromEntries(entries.map((entry) => [entry.path, entry.blobHash]));
doc.recertifications.push(recertification);
doc.recertifiedAt = recertifiedAt;
doc.recertification = { phase: recertification.label, reason, changedFiles, priorSourceStateId, guarded: true };
doc.recertificationReason = reason;
doc.generationNote = "This interim source-state ID is derived from the reviewed FG-8 through R33 material implementation surface by packages/forgegreen-campaign/src/source-state.ts. Historical R32 evidence remains bound to its prior identity; this is not final R33 release certification.";

const temporaryPath = `${docPath}.r33-recertification.tmp`;
fs.writeFileSync(temporaryPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
fs.renameSync(temporaryPath, docPath);
console.log(JSON.stringify({ sourceStateId, surfaceVersion, changedFiles, materialFileCount: materialFiles.length }));
