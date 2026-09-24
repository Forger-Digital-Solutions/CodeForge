#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const docPath = path.join(repoRoot, "docs", "codeforge-forgegreen-certified-source-state.json");
const doc = JSON.parse(fs.readFileSync(docPath, "utf8"));
const priorSourceStateId = "7f059ffee8ef5e27829ee92fede825f8ebc3452112befb1f3365c6775a9e5d11";
const priorSurfaceVersion = "r33-free-capacity-fabric-interim-v2";
const changedFilesExpected = ["packages/server/src/agent-runtime.ts"];

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
const surfaceVersion = "r33-free-capacity-fabric-interim-v3";
const recertifiedAt = new Date().toISOString();
const reason = "Record the reviewed guard on AgentRuntime.updateCapacityWait so cancellation of a parked turn cannot crash when a persistence surface lacks work-item support. Capacity-wait semantics, completion-gate, ForgeVerify, and ForgeZero authority are unchanged. This is an interim source identity, not final R33 release certification.";
const recertification = {
  label: "R33 capacity-wait cancel-path guard",
  reason,
  priorSourceStateId,
  priorSurfaceVersion,
  resultingSourceStateId: sourceStateId,
  resultingSurfaceVersion: surfaceVersion,
  changes: [{
    file: "packages/server/src/agent-runtime.ts",
    change: "updateCapacityWait returns early when the persistence surface has no work-item API; the wait record could not exist there, so the bookkeeping write must never break cancellation.",
    addedToMaterialFiles: false,
  }],
  regressionEvidence: "docs/evidence/r33-free-capacity-fabric/INTERIM-CERTIFICATION.md; canonical vitest run recorded there.",
  recertifiedAt: recertifiedAt.slice(0, 10),
  sourceStateConstant: "CODEFORGE_R33_INTERIM_FREE_CAPACITY_SOURCE_STATE_V3",
};

doc.sourceStateId = sourceStateId;
doc.surfaceVersion = surfaceVersion;
doc.materialFiles = materialFiles;
doc.materialFileHashes = Object.fromEntries(entries.map((entry) => [entry.path, entry.blobHash]));
doc.recertifications.push(recertification);
doc.recertifiedAt = recertifiedAt;
doc.recertification = { phase: recertification.label, reason, changedFiles, priorSourceStateId, guarded: true };
doc.recertificationReason = reason;
doc.generationNote = "This interim source-state ID is derived from the reviewed FG-8 through R33 material implementation surface by packages/forgegreen-campaign/src/source-state.ts. Historical R32, interim-v1, and interim-v2 identities remain bound to their prior states; this is not final R33 release certification.";

const temporaryPath = `${docPath}.r33-recertification.tmp`;
fs.writeFileSync(temporaryPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
fs.renameSync(temporaryPath, docPath);
console.log(JSON.stringify({ sourceStateId, surfaceVersion, changedFiles, materialFileCount: materialFiles.length }));
