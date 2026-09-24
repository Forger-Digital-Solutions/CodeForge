#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const documentPath = path.join(root, "docs/codeforge-forgegreen-certified-source-state.json");
const document = JSON.parse(fs.readFileSync(documentPath, "utf8"));
const priorId = "57da084fd15cb01e887629b470a780c2fc67c7993e7195deba4d478d1048f358";
const priorVersion = "r30-release-unblocking-v1";
if (document.sourceStateId !== priorId || document.surfaceVersion !== priorVersion) {
  throw new Error("R30 rename recertification refused: predecessor identity changed.");
}
const files = [...document.materialFiles].sort((a, b) => a.localeCompare(b));
const entries = files.map((file) => ({
  path: file,
  blobHash: execFileSync("git", ["hash-object", file], { cwd: root, encoding: "utf8" }).trim(),
}));
const changed = entries.filter((entry) => document.materialFileHashes?.[entry.path] !== entry.blobHash).map((entry) => entry.path);
if (JSON.stringify(changed) !== JSON.stringify(["packages/server/src/workflow-service.ts"])) {
  throw new Error(`R30 rename recertification refused: unreviewed source drift ${JSON.stringify(changed)}.`);
}
const sourceStateId = createHash("sha256").update(JSON.stringify(entries.map((entry) => [entry.path, entry.blobHash]))).digest("hex");
const version = "r30-large-task-rename-v2";
const reason = "A bounded R30 live run changed the external --max-retries CLI flag while renaming an internal configuration property. The implementation prompt now tells the coder to preserve external interfaces unless requested. A subsequent locked large-task run kept that flag and passed all nine independent semantic checks. ForgeZero and completion authority are unchanged.";
const entry = {
  label: "R30 large-task rename safeguard",
  reason,
  priorSourceStateId: priorId,
  priorSurfaceVersion: priorVersion,
  resultingSourceStateId: sourceStateId,
  resultingSurfaceVersion: version,
  changes: [{ file: changed[0], change: "General rename guidance added to the implementation prompt; no gate or routing policy change.", addedToMaterialFiles: false }],
  regressionEvidence: "docs/evidence/r30-release-unblocking/04-large-task-benchmarks/r30-live-20cf0e22-5ade-47bf-a94b-a45f3d6f3ccd.json",
  recertifiedAt: new Date().toISOString().slice(0, 10),
  sourceStateConstant: "CODEFORGE_R30_LARGE_TASK_RENAME_SOURCE_STATE",
};
document.sourceStateId = sourceStateId;
document.surfaceVersion = version;
document.materialFileHashes = Object.fromEntries(entries.map((entry) => [entry.path, entry.blobHash]));
document.recertifications.push(entry);
document.recertifiedAt = new Date().toISOString();
document.recertification = { phase: entry.label, reason, changedFiles: changed, priorSourceStateId: priorId, guarded: true };
document.recertificationReason = reason;
document.generationNote = "The current source-state ID covers the reviewed material implementation through R30. Historical campaign evidence remains bound to its recorded source-state identity.";
const temporary = `${documentPath}.r30-rename.tmp`;
fs.writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`);
fs.renameSync(temporary, documentPath);
console.log(JSON.stringify({ priorId, sourceStateId, changed }));
