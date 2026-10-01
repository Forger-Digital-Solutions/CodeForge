#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const documentPath = path.join(root, "docs/codeforge-forgegreen-certified-source-state.json");
const document = JSON.parse(fs.readFileSync(documentPath, "utf8"));
const priorId = "6ed8bbdcc2c7c358e5a4846f422bfc060817b4902da9aea4afc1a7e7f8d06e75";
if (document.sourceStateId !== priorId || document.surfaceVersion !== "r59-free-supply-recovery-v10" || document.materialFiles.length !== 89) {
  throw new Error("R59 v11 recertification refused: unexpected r59-v10 predecessor");
}
// R59 v11: the serving-window context bound lives in packages/context/src/budget.ts and the
// failover qualification-await re-entry lives in packages/eight-bit/src/runtime.ts — both join
// the material set with the suites that pin the new semantics.
const added = [
  "packages/context/src/budget.ts",
  "packages/context/test/fg3-budget.test.ts",
  "packages/eight-bit/src/runtime.ts",
  "packages/eight-bit/test/runtime.test.ts",
];
const files = [...new Set([...document.materialFiles, ...added])].sort((a, b) => a.localeCompare(b));
const entries = files.map((file) => ({ path: file, blobHash: execFileSync("git", ["hash-object", file], { cwd: root, encoding: "utf8" }).trim() }));
const changed = entries.filter((entry) => document.materialFileHashes?.[entry.path] !== entry.blobHash).map((entry) => entry.path);
const expected = [
  "packages/context/src/budget.ts",
  "packages/context/test/fg3-budget.test.ts",
  "packages/eight-bit/src/failover.ts",
  "packages/eight-bit/src/runtime.ts",
  "packages/eight-bit/test/runtime.test.ts",
  "packages/model-registry/src/free-cloud-service.ts",
  "packages/model-registry/test/free-cloud-registry.test.ts",
  "packages/server/src/agent-runtime.ts",
].sort((a, b) => a.localeCompare(b));
if (JSON.stringify(changed) !== JSON.stringify(expected)) throw new Error(`R59 v11 recertification refused: unreviewed drift ${JSON.stringify(changed)}`);
const dirty = execFileSync("git", ["status", "--porcelain", "--", ...files], { cwd: root, encoding: "utf8" }).trim();
if (dirty) throw new Error(`R59 v11 recertification refused: uncommitted material source ${dirty}`);
const sourceStateId = createHash("sha256").update(JSON.stringify(entries.map((entry) => [entry.path, entry.blobHash]))).digest("hex");
const version = "r59-free-supply-recovery-v11";
const reason = "R59 v11 closes the three residual honest-supply gaps the v10 packaged dogfood exposed end-to-end (admit -> wire -> truthful Groq 413, Requested ~8.9k > 8000 TPM -> blocked): (1) dispatch sizing — resolveContextCapacity now consumes a servingInputBudget bound, the smallest stamped input-token window across the user's fabric-admissible routes minus the tool/transcript overhead the assembler does not budget, reported as capacity source serving_window; a prompt past the provider's per-request ingest ceiling was a guaranteed wire rejection, so context is packed to the physical window instead of paying a doomed dispatch, unstamped fleets stay unbounded, and an impossibly small window still fails closed on the kernel check. (2) Failover joins one bounded qualification recovery before declaring no_replacement while a lane is live — the awaitQualification hook is once-guarded like R51's capacityMeasured, and a lane at its daily budget returns false so the denial stays terminal. (3) The denial-recovery loop re-decides once when a previously-live lane dies during the wait — an armed retry landing inside the sleep window flipped liveEvidence false and exited the while-gate before the decide that would have seen the receipt; a lane never live never enters the loop and never pays the extra call. No free-only, qualification, billing, qualification-budget, ownership, or completion policy changed.";
const entry = {
  label: "R59 serving-window dispatch + failover qualification-await recertification",
  reason,
  priorSourceStateId: priorId,
  priorSurfaceVersion: document.surfaceVersion,
  resultingSourceStateId: sourceStateId,
  resultingSurfaceVersion: version,
  changes: changed.map((file) => ({ file, addedToMaterialFiles: added.includes(file) })),
  regressionEvidence: "docs/evidence/r59-supply-recovery/R59-FINAL-REPORT.md",
  recertifiedAt: new Date().toISOString().slice(0, 10),
  sourceStateConstant: "CODEFORGE_R59_FREE_SUPPLY_RECOVERY_V11_SOURCE_STATE",
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
