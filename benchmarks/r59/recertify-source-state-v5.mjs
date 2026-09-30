#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const documentPath = path.join(root, "docs/codeforge-forgegreen-certified-source-state.json");
const document = JSON.parse(fs.readFileSync(documentPath, "utf8"));
const priorId = "8f96379554ecd5715f171c079b2f898e3daf90e087b1d5218cb170d0ad16a1c8";
if (document.sourceStateId !== priorId || document.surfaceVersion !== "r59-free-supply-recovery-v4" || document.materialFiles.length !== 78) {
  throw new Error("R59 v5 recertification refused: unexpected r59-v4 predecessor");
}
const added = ["packages/server/test/free-fabric-wiring.test.ts"];
const files = [...document.materialFiles, ...added].sort((a, b) => a.localeCompare(b));
const entries = files.map((file) => ({ path: file, blobHash: execFileSync("git", ["hash-object", file], { cwd: root, encoding: "utf8" }).trim() }));
const changed = entries.filter((entry) => document.materialFileHashes?.[entry.path] !== entry.blobHash).map((entry) => entry.path);
const expected = ["packages/model-registry/src/free-cloud-service.ts", "packages/server/src/agent-runtime.ts", ...added].sort((a, b) => a.localeCompare(b));
if (JSON.stringify(changed) !== JSON.stringify(expected)) throw new Error(`R59 v5 recertification refused: unreviewed drift ${JSON.stringify(changed)}`);
const dirty = execFileSync("git", ["status", "--porcelain", "--", ...files], { cwd: root, encoding: "utf8" }).trim();
if (dirty) throw new Error(`R59 v5 recertification refused: uncommitted material source ${dirty}`);
const sourceStateId = createHash("sha256").update(JSON.stringify(entries.map((entry) => [entry.path, entry.blobHash]))).digest("hex");
const version = "r59-free-supply-recovery-v5";
const reason = "R59 v5 closes the admission-vs-qualification race the v4 packaged run exposed: the paced suite produced a real QUALIFIED verdict (groq gpt-oss-120b) seconds after the coder's single recovery wait expired. Route admission now re-decides in bounded rounds while a lane is in flight or has pending routes with spend headroom; an exhausted lane ends the wait honestly. qualificationSummary joins the routing hooks; wait horizon and recovery budget are injectable options. ForgeZero, ForgeVerify, qualification gates, and completion authority are unchanged.";
const entry = {
  label: "R59 denial-recovery loop recertification",
  reason,
  priorSourceStateId: priorId,
  priorSurfaceVersion: document.surfaceVersion,
  resultingSourceStateId: sourceStateId,
  resultingSurfaceVersion: version,
  changes: changed.map((file) => ({ file, addedToMaterialFiles: added.includes(file) })),
  regressionEvidence: "docs/evidence/r59-supply-recovery/R59-FINAL-REPORT.md",
  recertifiedAt: new Date().toISOString().slice(0, 10),
  sourceStateConstant: "CODEFORGE_R59_FREE_SUPPLY_RECOVERY_V5_SOURCE_STATE",
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
