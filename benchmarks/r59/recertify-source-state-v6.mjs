#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const documentPath = path.join(root, "docs/codeforge-forgegreen-certified-source-state.json");
const document = JSON.parse(fs.readFileSync(documentPath, "utf8"));
const priorId = "2e7fe8e4a1aedddc5c5664e7e525ed9ddaa5d12b28bf1406cff626742c1cbd51";
if (document.sourceStateId !== priorId || document.surfaceVersion !== "r59-free-supply-recovery-v5" || document.materialFiles.length !== 79) {
  throw new Error("R59 v6 recertification refused: unexpected r59-v5 predecessor");
}
const added = ["packages/server/test/progress-watchdog.test.ts"];
const files = [...document.materialFiles, ...added].sort((a, b) => a.localeCompare(b));
const entries = files.map((file) => ({ path: file, blobHash: execFileSync("git", ["hash-object", file], { cwd: root, encoding: "utf8" }).trim() }));
const changed = entries.filter((entry) => document.materialFileHashes?.[entry.path] !== entry.blobHash).map((entry) => entry.path);
const expected = ["packages/server/src/agent-runtime.ts", "packages/server/src/subagent-manager.ts", "packages/server/test/free-fabric-wiring.test.ts", ...added].sort((a, b) => a.localeCompare(b));
if (JSON.stringify(changed) !== JSON.stringify(expected)) throw new Error(`R59 v6 recertification refused: unreviewed drift ${JSON.stringify(changed)}`);
const dirty = execFileSync("git", ["status", "--porcelain", "--", ...files], { cwd: root, encoding: "utf8" }).trim();
if (dirty) throw new Error(`R59 v6 recertification refused: uncommitted material source ${dirty}`);
const sourceStateId = createHash("sha256").update(JSON.stringify(entries.map((entry) => [entry.path, entry.blobHash]))).digest("hex");
const version = "r59-free-supply-recovery-v6";
const reason = "R59 v6 closes the watchdog blindness the v5 packaged run exposed: a real QUALIFIED verdict (groq gpt-oss-120b) existed, but the coder spent its whole window in cold workspace indexing and pre-first-turn admission — phases that emit no durable tool-trace — and was aborted as 'stalled'. The runtime now marks runs inside bounded pre-first-turn phases; the subagent watchdog reads the mark as liveness, keeps the two-window stall check honest afterward, and the existing hard deadline still bounds a phase that genuinely wedges. No admission, qualification, billing, or completion authority changed.";
const entry = {
  label: "R59 watchdog pre-flight liveness recertification",
  reason,
  priorSourceStateId: priorId,
  priorSurfaceVersion: document.surfaceVersion,
  resultingSourceStateId: sourceStateId,
  resultingSurfaceVersion: version,
  changes: changed.map((file) => ({ file, addedToMaterialFiles: added.includes(file) })),
  regressionEvidence: "docs/evidence/r59-supply-recovery/R59-FINAL-REPORT.md",
  recertifiedAt: new Date().toISOString().slice(0, 10),
  sourceStateConstant: "CODEFORGE_R59_FREE_SUPPLY_RECOVERY_V6_SOURCE_STATE",
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
