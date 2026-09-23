#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const docPath = path.join(repoRoot, "docs", "codeforge-forgegreen-certified-source-state.json");
const doc = JSON.parse(fs.readFileSync(docPath, "utf8"));
const priorSourceStateId = "58625fae351122f3306af0dfe13ede522f419766de1621597464106546574964";
const priorSurfaceVersion = "r26-release-readiness-v1";
const changes = [
  {
    file: "packages/agent/src/index.ts",
    change: "R27 Planner accepts a separately validated semantic-steps protocol and canonicalizes it to the existing task graph; malformed or mixed protocols remain rejected.",
    addedToMaterialFiles: false,
  },
  {
    file: "packages/server/src/agent-runtime.ts",
    change: "R27 runtime refreshes or invalidates stale repository context after successful mutations, accounts for no-progress tool loops, applies runtime-owned read-only command classification, and canonicalizes recoverable streamed tool arguments for both execution and provider transcript continuity. Completion authority remains in evaluateCompletion.",
    addedToMaterialFiles: false,
  },
  {
    file: "packages/server/src/duplicate-suppression.ts",
    change: "R27 duplicate supervisor accepts a runtime-classified read-only identity for safe command reuse and records no-progress interruptions; mutating actions remain executable.",
    addedToMaterialFiles: false,
  },
  {
    file: "packages/tools/src/index.ts",
    change: "R27 command tool treats a nonzero child exit as a failed execution, preserving the exit code and output for the agent instead of reporting tool success.",
    addedToMaterialFiles: false,
  },
];

if (doc.sourceStateId !== priorSourceStateId || doc.surfaceVersion !== priorSurfaceVersion) {
  throw new Error("R27 recertification refused: the certified predecessor changed.");
}
if (!Array.isArray(doc.materialFiles) || !Array.isArray(doc.recertifications)) {
  throw new Error("R27 recertification refused: source-state document shape is invalid.");
}
const materialFiles = [...doc.materialFiles].sort((a, b) => a.localeCompare(b));
if (new Set(materialFiles).size !== materialFiles.length) {
  throw new Error("R27 recertification refused: duplicate material files.");
}
const entries = materialFiles.map((file) => ({
  path: file,
  blobHash: execFileSync("git", ["hash-object", file], { cwd: repoRoot, encoding: "utf8" }).trim(),
}));
const changedFiles = entries.filter((entry) => doc.materialFileHashes?.[entry.path] !== entry.blobHash).map((entry) => entry.path);
const expectedFiles = changes.map((change) => change.file).sort((a, b) => a.localeCompare(b));
if (JSON.stringify(changedFiles) !== JSON.stringify(expectedFiles)) {
  throw new Error(`R27 recertification refused: unreviewed drift ${JSON.stringify(changedFiles)}.`);
}
const uncommittedMaterial = execFileSync("git", ["status", "--porcelain", "--", ...materialFiles], { cwd: repoRoot, encoding: "utf8" }).trim();
if (uncommittedMaterial) {
  throw new Error(`R27 recertification refused: material source has uncommitted edits: ${uncommittedMaterial}`);
}

const sourceStateId = createHash("sha256").update(JSON.stringify(entries.map((entry) => [entry.path, entry.blobHash]))).digest("hex");
const surfaceVersion = "r27-single-user-runtime-v1";
const recertifiedAt = new Date().toISOString();
const recertification = {
  label: "R27 single-user runtime and live-proof repairs",
  reason: "Re-issue the frozen ForgeGreen source-state over four reviewed R27 material files. Earlier ForgeGreen observations retain their historical source identities; this new identity covers current Planner, runtime/context/tool, and duplicate-suppression behavior without relaxing ForgeZero or the completion gate.",
  priorSourceStateId,
  priorSurfaceVersion,
  resultingSourceStateId: sourceStateId,
  resultingSurfaceVersion: surfaceVersion,
  changes,
  regressionEvidence: "R27 bounded live runtime receipts and focused 25/25 runtime/release/catalog tests passed. The pre-recertification canonical suite had 3533 passed, 48 skipped, and five failures: two expected source-state canaries and three scripted parallel-provider classifiers corrected without timeout or assertion relaxation; affected files passed alone. Final post-recertification regression is recorded in R27-FINAL-INTELLIGENCE-CERTIFICATION.md.",
  recertifiedAt: recertifiedAt.slice(0, 10),
  sourceStateConstant: "CODEFORGE_R27_SINGLE_USER_RUNTIME_SOURCE_STATE",
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
doc.generationNote = "This source-state ID is deterministically derived from the reviewed FG-8 through R27 material implementation surface by packages/forgegreen-campaign/src/source-state.ts using idAlgorithm. Historical campaign evidence remains bound to its recorded source-state identity.";

const temporaryPath = `${docPath}.r27-recertification.tmp`;
fs.writeFileSync(temporaryPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
fs.renameSync(temporaryPath, docPath);
console.log(JSON.stringify({ sourceStateId, surfaceVersion, changedFiles, materialFileCount: materialFiles.length }));
