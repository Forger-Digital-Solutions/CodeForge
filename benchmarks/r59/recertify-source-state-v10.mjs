#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const documentPath = path.join(root, "docs/codeforge-forgegreen-certified-source-state.json");
const document = JSON.parse(fs.readFileSync(documentPath, "utf8"));
const priorId = "b6511c2747db31aec46aab1fa894e7c731b8f7df197847623e82447faa72f80c";
if (document.sourceStateId !== priorId || document.surfaceVersion !== "r59-free-supply-recovery-v9" || document.materialFiles.length !== 84) {
  throw new Error("R59 v10 recertification refused: unexpected r59-v9 predecessor");
}
// R59 v10: whole-window provider arbitration lives in the reservation ledger (already
// material); the suites that pin the new clamp/horizon semantics and the recovery-loop
// gate join the material set.
const added = [
  "packages/eight-bit/test/free-fabric.test.ts",
  "packages/eight-bit/test/r24-multi-pool.test.ts",
  "packages/eight-bit/test/role-quality.test.ts",
  "packages/server/test/role-routing.test.ts",
  "packages/server/test/role-output-budget.test.ts",
];
const files = [...new Set([...document.materialFiles, ...added])].sort((a, b) => a.localeCompare(b));
const entries = files.map((file) => ({ path: file, blobHash: execFileSync("git", ["hash-object", file], { cwd: root, encoding: "utf8" }).trim() }));
const changed = entries.filter((entry) => document.materialFileHashes?.[entry.path] !== entry.blobHash).map((entry) => entry.path);
const expected = [
  "packages/eight-bit/test/free-fabric.test.ts",
  "packages/eight-bit/test/r24-multi-pool.test.ts",
  "packages/eight-bit/test/role-quality.test.ts",
  "packages/forge-zero/src/capacity-reservations.ts",
  "packages/forge-zero/test/capacity-transition-chaos.test.ts",
  "packages/server/src/agent-runtime.ts",
  "packages/server/test/role-output-budget.test.ts",
  "packages/server/test/role-routing.test.ts",
].sort((a, b) => a.localeCompare(b));
if (JSON.stringify(changed) !== JSON.stringify(expected)) throw new Error(`R59 v10 recertification refused: unreviewed drift ${JSON.stringify(changed)}`);
const dirty = execFileSync("git", ["status", "--porcelain", "--", ...files], { cwd: root, encoding: "utf8" }).trim();
if (dirty) throw new Error(`R59 v10 recertification refused: uncommitted material source ${dirty}`);
const sourceStateId = createHash("sha256").update(JSON.stringify(entries.map((entry) => [entry.path, entry.blobHash]))).digest("hex");
const version = "r59-free-supply-recovery-v10";
const reason = "R59 v10 closes the permanent-queue false zero the v9 run exposed end-to-end: the coder's measured demand (assembled context ~27.3k chars -> estimatedPromptTokens ~8.7k, inflated by the borrowed tokenizer ratio and 1.15 reserve margin to ~10-15k) exceeded Groq's declared 8k token-window limit, so every reserve() verdict classified a structurally unfittable ESTIMATE as transient CAPACITY_EXHAUSTED and queued on a reset that could never satisfy it — ~5 minutes of re-decides ending in an honest-looking blocked run while the real billed prompt (~0.83 observed ratio, ~7.2k tokens) would have fit. Reservation semantics now mirror the pacing governor's tokenBucketDecision rule for need>limit: an over-limit hold on an arbitrable unit clamps to the window's limit and admits exactly when the window is unspent and unheld, reserving the whole window so a second request serializes honestly; a partially spent window still denies on its own real reset; hard-count units (requests, concurrency) never clamp and still fail closed. The provider's wire verdict arbitrates the estimate — success proves usable capacity, a real 429 stamps real exhaustion. Denial horizons now bind to the denying dimension (window-short units report their own reset; hold-short units report the earlier of lease expiry or reset), so a queued verdict never again advertises a deadline that cannot serve it. The R59 qualification-recovery loop is also gated on a live lane before its first round so DENIED verdicts and dead fleets fail fast instead of consuming a spurious re-decide. No free-only, qualification, billing, qualification-budget, ownership, or completion policy changed.";
const entry = {
  label: "R59 whole-window provider-arbitration recertification",
  reason,
  priorSourceStateId: priorId,
  priorSurfaceVersion: document.surfaceVersion,
  resultingSourceStateId: sourceStateId,
  resultingSurfaceVersion: version,
  changes: changed.map((file) => ({ file, addedToMaterialFiles: added.includes(file) })),
  regressionEvidence: "docs/evidence/r59-supply-recovery/R59-FINAL-REPORT.md",
  recertifiedAt: new Date().toISOString().slice(0, 10),
  sourceStateConstant: "CODEFORGE_R59_FREE_SUPPLY_RECOVERY_V10_SOURCE_STATE",
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
