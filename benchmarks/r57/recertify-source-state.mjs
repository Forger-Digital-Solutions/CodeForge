#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const documentPath = path.join(root, "docs/codeforge-forgegreen-certified-source-state.json");
const document = JSON.parse(fs.readFileSync(documentPath, "utf8"));
const priorId = "934a07bc2c0bcd506d8307817be5daf23185afcbb679e5896ba5493b06b41b9e";
const priorVersion = "r56-golden-backend-freeze-v1";
if (document.sourceStateId !== priorId || document.surfaceVersion !== priorVersion || document.materialFiles.length !== 60) {
  throw new Error("R57 foundation recertification refused: R56 predecessor identity changed.");
}

const added = ["packages/server/src/experience-learning.ts", "packages/server/src/strategy-novelty.ts"];
const files = [...document.materialFiles, ...added].sort((a, b) => a.localeCompare(b));
if (new Set(files).size !== files.length) throw new Error("R57 foundation recertification refused: duplicate material file.");
const entries = files.map((file) => ({ path: file, blobHash: execFileSync("git", ["hash-object", file], { cwd: root, encoding: "utf8" }).trim() }));
const changed = entries.filter((entry) => document.materialFileHashes?.[entry.path] !== entry.blobHash).map((entry) => entry.path);
const expected = [...added, "packages/server/src/autonomous-orchestrator.ts"].sort((a, b) => a.localeCompare(b));
if (JSON.stringify(changed) !== JSON.stringify(expected)) {
  throw new Error(`R57 foundation recertification refused: unreviewed material drift ${JSON.stringify(changed)}.`);
}
const dirty = execFileSync("git", ["status", "--porcelain", "--", ...files], { cwd: root, encoding: "utf8" }).trim();
if (dirty) throw new Error(`R57 foundation recertification refused: uncommitted material source ${dirty}`);
const sourceStateId = createHash("sha256").update(JSON.stringify(entries.map((entry) => [entry.path, entry.blobHash]))).digest("hex");
const version = "r57-experience-foundation-v1";
const reason = "Partial R57 foundation: owner-local and generalized privacy-safe experience receipts, reviewer revision strategy-novelty intervention, and bounded abstract-outcome recovery advice. This certificate covers only reviewed source drift; it does not certify R57 endurance, live concurrency, packaged recovery, or full-round closure.";
const entry = {
  label: "R57 experience foundation source recertification",
  reason,
  priorSourceStateId: priorId,
  priorSurfaceVersion: priorVersion,
  resultingSourceStateId: sourceStateId,
  resultingSurfaceVersion: version,
  changes: [
    { file: "packages/server/src/autonomous-orchestrator.ts", change: "Persists scoped experience and generalized signals from terminal autonomous runs; compares observable reviewer-failure strategy history, records interventions, and consumes bounded prior abstract outcomes for recovery advice.", addedToMaterialFiles: false },
    { file: "packages/server/src/experience-learning.ts", change: "Defines authority-bound success labels, privacy-safe receipt projection, and reconstructable bounded recovery advice; no source, prompt, path, endpoint, or raw model identity enters generalized signals.", addedToMaterialFiles: true },
    { file: "packages/server/src/strategy-novelty.ts", change: "Hashes observable target-file and failure-code signatures and classifies bounded revision novelty without storing reasoning or raw source.", addedToMaterialFiles: true },
  ],
  regressionEvidence: "docs/evidence/r57-autonomous-endurance-learning/R57-PARTIAL-REPORT.md",
  recertifiedAt: new Date().toISOString().slice(0, 10),
  sourceStateConstant: "CODEFORGE_R57_EXPERIENCE_FOUNDATION_SOURCE_STATE",
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
