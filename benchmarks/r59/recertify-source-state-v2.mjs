#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const documentPath = path.join(root, "docs/codeforge-forgegreen-certified-source-state.json");
const document = JSON.parse(fs.readFileSync(documentPath, "utf8"));
const priorId = "a529e102fe8096f62957dc746e6d9ca80616af413837e401c4ec6ec1e8623e78";
if (document.sourceStateId !== priorId || document.surfaceVersion !== "r59-free-supply-recovery-v1" || document.materialFiles.length !== 74) {
  throw new Error("R59 v2 recertification refused: unexpected r59-v1 predecessor");
}
// The qualification suite deadline (compact + role suites) is load-bearing R59 supply work:
// it is what stops one saturated provider from monopolizing qualification and starving the
// sibling lanes that decide whether free supply ever becomes usable. Moving it under the
// certified material set keeps the audited surface equal to the fix surface.
const added = [
  "packages/eight-bit/src/qualification/compact.ts",
  "packages/eight-bit/src/qualification/role-suite.ts",
].sort((a, b) => a.localeCompare(b));
if (added.some((file) => document.materialFiles.includes(file))) throw new Error("R59 v2 material addition was already certified");
const files = [...document.materialFiles, ...added].sort((a, b) => a.localeCompare(b));
const entries = files.map((file) => ({ path: file, blobHash: execFileSync("git", ["hash-object", file], { cwd: root, encoding: "utf8" }).trim() }));
const changed = entries.filter((entry) => document.materialFileHashes?.[entry.path] !== entry.blobHash).map((entry) => entry.path);
const expected = [
  ...added,
  "packages/model-registry/src/free-cloud-service.ts",
].sort((a, b) => a.localeCompare(b));
if (JSON.stringify(changed) !== JSON.stringify(expected)) throw new Error(`R59 v2 recertification refused: unreviewed drift ${JSON.stringify(changed)}`);
const dirty = execFileSync("git", ["status", "--porcelain", "--", ...files], { cwd: root, encoding: "utf8" }).trim();
if (dirty) throw new Error(`R59 v2 recertification refused: uncommitted material source ${dirty}`);
const sourceStateId = createHash("sha256").update(JSON.stringify(entries.map((entry) => [entry.path, entry.blobHash]))).digest("hex");
const version = "r59-free-supply-recovery-v2";
const reason = "R59 v2 bounds the qualification path that supply recovery depends on: provider lanes run concurrently so one saturated upstream cannot serialize another provider's pending routes, a per-suite wall-clock deadline aborts in-flight probes and classifies as transient (the route stays pending and retries at cooldown rather than earning a starvation verdict), capacity probes race a fixed timeout instead of waiting on unbounded adapter calls, and a recovery timer that fires mid-cycle re-arms inside its cooldown window instead of dropping. ForgeZero, ForgeVerify, qualification gates, and completion authority are unchanged.";
const entry = {
  label: "R59 qualification starvation recertification",
  reason,
  priorSourceStateId: priorId,
  priorSurfaceVersion: document.surfaceVersion,
  resultingSourceStateId: sourceStateId,
  resultingSurfaceVersion: version,
  changes: changed.map((file) => ({ file, addedToMaterialFiles: added.includes(file) })),
  regressionEvidence: "docs/evidence/r59-supply-recovery/R59-FINAL-REPORT.md",
  recertifiedAt: new Date().toISOString().slice(0, 10),
  sourceStateConstant: "CODEFORGE_R59_FREE_SUPPLY_RECOVERY_V2_SOURCE_STATE",
};
document.sourceStateId = sourceStateId;
document.surfaceVersion = version;
document.materialFiles = files;
document.materialFileHashes = Object.fromEntries(entries.map((item) => [item.path, item.blobHash]));
document.recertifications.push(entry);
document.recertifiedAt = new Date().toISOString();
document.recertification = { phase: entry.label, reason, changedFiles: changed, priorSourceStateId: priorId, guarded: true };
fs.writeFileSync(documentPath, `${JSON.stringify(document, null, 2)}\n`);
console.log(JSON.stringify({ version, sourceStateId, materialFiles: files.length, changed }));
