#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const documentPath = path.join(root, "docs/codeforge-forgegreen-certified-source-state.json");
const document = JSON.parse(fs.readFileSync(documentPath, "utf8"));
const priorId = "5b139a060e743b2866a232e6e57dd7bc7ee380a8870c6c15c72affc87ef90bb0";
const priorVersion = "r57-experience-foundation-v4";
const priorEntry = document.recertifications.at(-1);
if (document.sourceStateId !== priorId || document.surfaceVersion !== priorVersion || document.materialFiles.length !== 62 || priorEntry?.resultingSourceStateId !== priorId) {
  throw new Error("R57 v5 recertification refused: v4 predecessor identity or material set changed");
}

const addedFile = "packages/server/src/workspace-service.ts";
if (document.materialFiles.includes(addedFile)) throw new Error("R57 v5 recertification refused: workspace service was already material");
const files = [...document.materialFiles, addedFile].sort((a, b) => a.localeCompare(b));
if (new Set(files).size !== files.length) throw new Error("R57 v5 recertification refused: duplicate material file");
const entries = files.map((file) => ({ path: file, blobHash: execFileSync("git", ["hash-object", file], { cwd: root, encoding: "utf8" }).trim() }));
const changed = entries.filter((entry) => document.materialFileHashes?.[entry.path] !== entry.blobHash).map((entry) => entry.path);
const expected = ["packages/server/src/autonomous-orchestrator.ts", "packages/server/src/index.ts", addedFile].sort((a, b) => a.localeCompare(b));
if (JSON.stringify(changed) !== JSON.stringify(expected)) {
  throw new Error(`R57 v5 recertification refused: unreviewed material drift ${JSON.stringify(changed)}`);
}
const dirty = execFileSync("git", ["status", "--porcelain", "--", ...files], { cwd: root, encoding: "utf8" }).trim();
if (dirty) throw new Error(`R57 v5 recertification refused: uncommitted material source ${dirty}`);
const committedDrift = execFileSync("git", ["diff", "--name-only", "3b8ffd3d9cb369fbff36897fe22d199de52403ba", "HEAD", "--", ...files], { cwd: root, encoding: "utf8" }).trim().split(/\r?\n/).filter(Boolean).sort((a, b) => a.localeCompare(b));
if (JSON.stringify(committedDrift) !== JSON.stringify(expected)) throw new Error(`R57 v5 recertification refused: committed drift ${JSON.stringify(committedDrift)}`);

const sourceStateId = createHash("sha256").update(JSON.stringify(entries.map((entry) => [entry.path, entry.blobHash]))).digest("hex");
const version = "r57-endurance-product-fixes-v5";
const reason = "Packaged CodeForge-on-CodeForge found a Windows Git long-path checkout failure and an orchestrator API run-ID race. The committed fixes opt in to Git long paths only for worktree creation and reserve the response run ID before asynchronous setup. No completion, routing, security, or accounting authority was relaxed.";
const entry = {
  label: "R57 endurance product-fix recertification",
  reason,
  priorSourceStateId: priorId,
  priorSurfaceVersion: priorVersion,
  resultingSourceStateId: sourceStateId,
  resultingSurfaceVersion: version,
  changes: [
    { file: "packages/server/src/autonomous-orchestrator.ts", change: "Accepts a validated trusted run ID reserved by the control plane before asynchronous setup.", addedToMaterialFiles: false },
    { file: "packages/server/src/index.ts", change: "Returns the same reserved orchestrator run ID to the client, removing the unrelated fallback ID.", addedToMaterialFiles: false },
    { file: addedFile, change: "Enables Git long-path checkout for both isolated worktree creation paths on Windows.", addedToMaterialFiles: true },
  ],
  regressionEvidence: "docs/evidence/r57-autonomous-endurance-learning/R57-CONTINUATION-REPORT.md",
  recertifiedAt: new Date().toISOString().slice(0, 10),
  sourceStateConstant: "CODEFORGE_R57_ENDURANCE_PRODUCT_FIXES_V5_SOURCE_STATE",
};
document.sourceStateId = sourceStateId;
document.surfaceVersion = version;
document.materialFiles = files;
document.materialFileHashes = Object.fromEntries(entries.map((item) => [item.path, item.blobHash]));
document.recertifications.push(entry);
document.recertifiedAt = new Date().toISOString();
document.recertification = { phase: entry.label, reason, changedFiles: changed, priorSourceStateId: priorId, guarded: true };
fs.writeFileSync(documentPath, `${JSON.stringify(document, null, 2)}\n`);
console.log(JSON.stringify({ version, sourceStateId, materialFiles: files.length, changed, committedDrift }));
