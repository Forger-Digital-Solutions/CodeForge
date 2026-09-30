#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const documentPath = path.join(root, "docs/codeforge-forgegreen-certified-source-state.json");
const document = JSON.parse(fs.readFileSync(documentPath, "utf8"));
const priorId = "2d3955fd43cf7f01e821e039009fa66d2a38b451226f7a56d8b59eaec1bdf2eb";
if (document.sourceStateId !== priorId || document.surfaceVersion !== "r59-free-supply-recovery-v6" || document.materialFiles.length !== 80) {
  throw new Error("R59 v7 recertification refused: unexpected r59-v6 predecessor");
}
const files = [...document.materialFiles].sort((a, b) => a.localeCompare(b));
const entries = files.map((file) => ({ path: file, blobHash: execFileSync("git", ["hash-object", file], { cwd: root, encoding: "utf8" }).trim() }));
const changed = entries.filter((entry) => document.materialFileHashes?.[entry.path] !== entry.blobHash).map((entry) => entry.path);
const expected = [
  "packages/model-registry/src/free-cloud-service.ts",
  "packages/model-registry/test/r59-supply-recovery.test.ts",
  "packages/server/src/agent-runtime.ts",
  "packages/server/test/free-fabric-wiring.test.ts",
].sort((a, b) => a.localeCompare(b));
if (JSON.stringify(changed) !== JSON.stringify(expected)) throw new Error(`R59 v7 recertification refused: unreviewed drift ${JSON.stringify(changed)}`);
const dirty = execFileSync("git", ["status", "--porcelain", "--", ...files], { cwd: root, encoding: "utf8" }).trim();
if (dirty) throw new Error(`R59 v7 recertification refused: uncommitted material source ${dirty}`);
const sourceStateId = createHash("sha256").update(JSON.stringify(entries.map((entry) => [entry.path, entry.blobHash]))).digest("hex");
const version = "r59-free-supply-recovery-v7";
const reason = "R59 v7 closes the cooled-lane blindness the v6 packaged run exposed: every unqualified route on a provider sitting in transient cooldown reports pending=0, so the denial-time recovery loop read the lane as dead and denied PROVIDER_UNAVAILABLE minutes before the provider-stated recovery retry — already armed with budget headroom — could land a verdict. qualificationSummary now computes liveEvidence service-side where the spend/cap/interval constants live: a lane is live while pending work is reachable (a recovery kick or a due cycle) or a cooled-route retry is armed with headroom left. A lane past its daily budget or recovery cap still denies on schedule. No admission, qualification, billing, or completion authority changed.";
const entry = {
  label: "R59 cooldown live-evidence recertification",
  reason,
  priorSourceStateId: priorId,
  priorSurfaceVersion: document.surfaceVersion,
  resultingSourceStateId: sourceStateId,
  resultingSurfaceVersion: version,
  changes: changed.map((file) => ({ file, addedToMaterialFiles: false })),
  regressionEvidence: "docs/evidence/r59-supply-recovery/R59-FINAL-REPORT.md",
  recertifiedAt: new Date().toISOString().slice(0, 10),
  sourceStateConstant: "CODEFORGE_R59_FREE_SUPPLY_RECOVERY_V7_SOURCE_STATE",
};
document.materialFiles = files;
document.sourceStateId = sourceStateId;
document.surfaceVersion = version;
document.materialFileHashes = Object.fromEntries(entries.map((item) => [item.path, item.blobHash]));
document.recertifications.push(entry);
document.recertifiedAt = new Date().toISOString();
document.recertification = { phase: entry.label, reason, changedFiles: changed, priorSourceStateId: priorId, guarded: true };
fs.writeFileSync(documentPath, `${JSON.stringify(document, null, 2)}\n`);
console.log(JSON.stringify({ version, sourceStateId, materialFiles: files.length, changed }));
