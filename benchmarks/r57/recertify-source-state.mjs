#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const documentPath = path.join(root, "docs/codeforge-forgegreen-certified-source-state.json");
const document = JSON.parse(fs.readFileSync(documentPath, "utf8"));
const r56Id = "934a07bc2c0bcd506d8307817be5daf23185afcbb679e5896ba5493b06b41b9e";
const v1Id = "72ce0ea372aa558742c325859f966325d2bd98cbbd2eaa34524ffdf2bb21ca72";
const priorId = "cdc101bc4d3db2fa68552d254e6e6d07fa186a1ebe5df413514cea39b142619b";
const priorVersion = "r57-experience-foundation-v2";
const predecessor = document.recertifications.find((entry) => entry.resultingSourceStateId === priorId);
const firstFoundation = document.recertifications.find((entry) => entry.resultingSourceStateId === v1Id);
if (document.sourceStateId !== priorId || document.surfaceVersion !== priorVersion || document.materialFiles.length !== 62 || predecessor?.priorSourceStateId !== v1Id || firstFoundation?.priorSourceStateId !== r56Id) {
  throw new Error("R57 foundation recertification refused: R56/R57 predecessor identity changed.");
}

const added = [];
const files = [...document.materialFiles, ...added].sort((a, b) => a.localeCompare(b));
if (new Set(files).size !== files.length) throw new Error("R57 foundation recertification refused: duplicate material file.");
const entries = files.map((file) => ({ path: file, blobHash: execFileSync("git", ["hash-object", file], { cwd: root, encoding: "utf8" }).trim() }));
const changed = entries.filter((entry) => document.materialFileHashes?.[entry.path] !== entry.blobHash).map((entry) => entry.path);
const expected = ["packages/server/src/experience-learning.ts"];
if (JSON.stringify(changed) !== JSON.stringify(expected)) {
  throw new Error(`R57 foundation recertification refused: unreviewed material drift ${JSON.stringify(changed)}.`);
}
const dirty = execFileSync("git", ["status", "--porcelain", "--", ...files], { cwd: root, encoding: "utf8" }).trim();
if (dirty) throw new Error(`R57 foundation recertification refused: uncommitted material source ${dirty}`);
const sourceStateId = createHash("sha256").update(JSON.stringify(entries.map((entry) => [entry.path, entry.blobHash]))).digest("hex");
const version = "r57-experience-foundation-v3";
const reason = "R57 foundation role-label correction: production worker role titles are mapped to fixed abstract role classes in the experience receipt without retaining arbitrary role text. This certificate covers reviewed source drift, not full-round closure.";
const entry = {
  label: "R57 experience foundation role recertification",
  reason,
  priorSourceStateId: priorId,
  priorSurfaceVersion: priorVersion,
  resultingSourceStateId: sourceStateId,
  resultingSurfaceVersion: version,
  changes: [
    { file: "packages/server/src/experience-learning.ts", change: "Maps production worker role titles to bounded abstract role classes in both local and generalized receipts, preserving learning signal without raw arbitrary role text.", addedToMaterialFiles: false },
  ],
  regressionEvidence: "docs/evidence/r57-autonomous-endurance-learning/R57-PARTIAL-REPORT.md",
  recertifiedAt: new Date().toISOString().slice(0, 10),
  sourceStateConstant: "CODEFORGE_R57_EXPERIENCE_FOUNDATION_V3_SOURCE_STATE",
};
document.sourceStateId = sourceStateId;
document.surfaceVersion = version;
document.materialFiles = files;
document.materialFileHashes = Object.fromEntries(entries.map((entry) => [entry.path, entry.blobHash]));
document.recertifications.push(entry);
document.recertifiedAt = new Date().toISOString();
document.recertification = { phase: entry.label, reason, changedFiles: changed, priorSourceStateId: priorId, guarded: true };
fs.writeFileSync(documentPath, `${JSON.stringify(document, null, 2)}\n`);
console.log(JSON.stringify({ version, sourceStateId, materialFiles: files.length, changed }));
