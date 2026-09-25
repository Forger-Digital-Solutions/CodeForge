#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const docPath = path.join(repoRoot, "docs", "codeforge-forgegreen-certified-source-state.json");
const doc = JSON.parse(fs.readFileSync(docPath, "utf8"));
const priorSourceStateId = "98387a8b3a505c8bf1052c5b192bfeae596fbd8f022329f6c96c362c6e67a3a7";
const priorSurfaceVersion = "r33-free-capacity-fabric-interim-v3";
const changedFilesExpected = ["packages/server/src/agent-runtime.ts"];
const newMaterialFiles = ["packages/server/src/history-compaction.ts"];

if (doc.sourceStateId !== priorSourceStateId || doc.surfaceVersion !== priorSurfaceVersion) {
  throw new Error("R34 recertification refused: certified predecessor changed.");
}
if (!Array.isArray(doc.materialFiles) || !Array.isArray(doc.recertifications)) {
  throw new Error("R34 recertification refused: source-state document shape is invalid.");
}
const priorMaterialFiles = [...doc.materialFiles].sort((a, b) => a.localeCompare(b));
const priorEntries = priorMaterialFiles.map((file) => ({
  path: file,
  blobHash: execFileSync("git", ["hash-object", file], { cwd: repoRoot, encoding: "utf8" }).trim(),
}));
const changedFiles = priorEntries.filter((entry) => doc.materialFileHashes?.[entry.path] !== entry.blobHash).map((entry) => entry.path);
if (JSON.stringify(changedFiles) !== JSON.stringify(changedFilesExpected)) {
  throw new Error(`R34 recertification refused: unreviewed drift ${JSON.stringify(changedFiles)}.`);
}

const materialFiles = [...priorMaterialFiles, ...newMaterialFiles].sort((a, b) => a.localeCompare(b));
if (new Set(materialFiles).size !== materialFiles.length) {
  throw new Error("R34 recertification refused: duplicate material files.");
}
const entries = materialFiles.map((file) => ({
  path: file,
  blobHash: execFileSync("git", ["hash-object", file], { cwd: repoRoot, encoding: "utf8" }).trim(),
}));
const uncommittedMaterial = execFileSync("git", ["status", "--porcelain", "--", ...materialFiles], { cwd: repoRoot, encoding: "utf8" }).trim();
if (uncommittedMaterial) {
  throw new Error(`R34 recertification refused: material source has uncommitted edits: ${uncommittedMaterial}`);
}

const sourceStateId = createHash("sha256").update(JSON.stringify(entries.map((entry) => [entry.path, entry.blobHash]))).digest("hex");
const surfaceVersion = "r34-capacity-efficiency-interim-v1";
const recertifiedAt = new Date().toISOString();
const reason = "Record the R34 capacity-efficiency surface: AgentRuntime admission now demands measured serialized-request tokens (estimatePromptOnlyTokens) plus role-scoped outputTokenDemand scaled by the governor's learned tokenizerRatio, the repo_* tool surface is withheld when no workspace exists so impossible tools cannot consume free-tier context, and dispatch copies compact superseded or mutation-stale tool outputs via the new history-compaction module. Durable history, capacity-wait semantics, completion-gate, ForgeVerify, and ForgeZero authority are unchanged. This is an interim source identity, not final R34 release certification.";
const recertification = {
  label: "R34 capacity-efficiency surface",
  reason,
  priorSourceStateId,
  priorSurfaceVersion,
  resultingSourceStateId: sourceStateId,
  resultingSurfaceVersion: surfaceVersion,
  changes: [
    {
      file: "packages/server/src/agent-runtime.ts",
      change: "Admission demand is measured from the serialized request per candidate route (learned tokenizerRatio margin, role-scoped outputTokenDemand); getAvailableTools withholds repo_* tools absent a workspace; provider dispatch copies route through compaction of superseded/mutation-stale tool outputs.",
      addedToMaterialFiles: false,
    },
    {
      file: "packages/server/src/history-compaction.ts",
      change: "New module: builds the dispatch-time message copy that replaces stale tool outputs with markers without mutating durable history.",
      addedToMaterialFiles: true,
    },
  ],
  regressionEvidence: "docs/evidence/r34-capacity-efficiency/R34-CERTIFICATION-ADDENDUM.md; canonical vitest run recorded there.",
  recertifiedAt: recertifiedAt.slice(0, 10),
  sourceStateConstant: "CODEFORGE_R34_INTERIM_CAPACITY_EFFICIENCY_SOURCE_STATE_V1",
};

doc.sourceStateId = sourceStateId;
doc.surfaceVersion = surfaceVersion;
doc.materialFiles = materialFiles;
doc.materialFileHashes = Object.fromEntries(entries.map((entry) => [entry.path, entry.blobHash]));
doc.recertifications.push(recertification);
doc.recertifiedAt = recertifiedAt;
doc.recertification = { phase: recertification.label, reason, changedFiles, priorSourceStateId, guarded: true };
doc.recertificationReason = reason;
doc.generationNote = "This interim source-state ID is derived from the reviewed FG-8 through R34 material implementation surface by packages/forgegreen-campaign/src/source-state.ts. Historical R32, R33 interim identities remain bound to their prior states; this is not final R34 release certification.";

const temporaryPath = `${docPath}.r34-recertification.tmp`;
fs.writeFileSync(temporaryPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
fs.renameSync(temporaryPath, docPath);
console.log(JSON.stringify({ sourceStateId, surfaceVersion, changedFiles, addedMaterialFiles: newMaterialFiles, materialFileCount: materialFiles.length }));
