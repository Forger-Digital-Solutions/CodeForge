#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const docPath = path.join(repoRoot, "docs", "codeforge-forgegreen-certified-source-state.json");
const doc = JSON.parse(fs.readFileSync(docPath, "utf8"));
const priorSourceStateId = "c92386e90cbd1bf8dffb5a40f81083db0d53d12fab735ae319f1a221d67595a7";
const priorSurfaceVersion = "r31-release-closure-v1";
const changes = [
  {
    file: "packages/server/src/agent-runtime.ts",
    change: "R32 repair turns and goal-review turns route through the inference budget's reserved partition so semantic review is guaranteed a lane after implementation exhausts its primary partition; review-phase routing is scoped per run.",
    addedToMaterialFiles: false,
  },
  {
    file: "packages/server/src/workflow-service.ts",
    change: "R32 fail-closed semantic review: inconclusive or budget-starved review turns can never produce a met verdict; deterministic stated-contract check compares declared diff signatures against explicitly stated goal contracts and emits blocking goal_not_satisfied findings independent of model verdict, hardened against comment/string-literal spoofing; goal reviewers are told the diff digest is system-captured evidence they may cite directly.",
    addedToMaterialFiles: false,
  },
  {
    file: "packages/workflow/src/diff-review.ts",
    change: "R32 non-git workspace coverage: when the workspace is not a git repository, reviewDiff walks the filesystem with the same snapshot exclusions and timestamp filters so newly created files reach review and deterministic contract checks instead of being invisible.",
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
const surfaceVersion = "r32-autonomy-perfection-v1";
const recertifiedAt = new Date().toISOString();
const recertification = {
  label: "R32 autonomy perfection and false-success closure",
  reason: "Re-issue the frozen ForgeGreen source-state over three reviewed R32 material files. The changes strengthen the semantic-review tail (reserved inference lane, fail-closed inconclusive verdicts, deterministic stated-contract enforcement, non-git created-file coverage). Completion authority remains solely in evaluateCompletion; no gate was relaxed.",
  priorSourceStateId,
  priorSurfaceVersion,
  resultingSourceStateId: sourceStateId,
  resultingSurfaceVersion: surfaceVersion,
  changes,
  regressionEvidence: "R32 live acceptance batch receipts under docs/evidence/r32-autonomy-perfection/10-live-acceptance; deterministic starvation/contract matrix green in workflow-goal-review.test.ts; packaged live-provider proof in 30-packaged-live-proof. Final post-recertification regression is recorded in the R32 certification document.",
  recertifiedAt: recertifiedAt.slice(0, 10),
  sourceStateConstant: "CODEFORGE_R32_AUTONOMY_PERFECTION_SOURCE_STATE",
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
