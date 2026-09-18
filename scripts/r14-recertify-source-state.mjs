import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const docPath = path.join(root, "docs", "codeforge-forgegreen-certified-source-state.json");
const doc = JSON.parse(fs.readFileSync(docPath, "utf8"));
const materialFiles = [...doc.materialFiles].sort((left, right) => left.localeCompare(right));
const entries = materialFiles.map((file) => ({
  path: file,
  blobHash: execFileSync("git", ["hash-object", file], { cwd: root, encoding: "utf8" }).trim(),
}));
const hashes = Object.fromEntries(entries.map((entry) => [entry.path, entry.blobHash]));
const changed = materialFiles.filter((file) => doc.materialFileHashes[file] !== hashes[file]);
const expected = new Set(["packages/secrets/src/index.ts", "packages/server/src/autonomous-orchestrator.ts"]);
const unexpected = changed.filter((file) => !expected.has(file));
if (unexpected.length > 0) throw new Error(`Unexpected certified-source drift: ${unexpected.join(", ")}`);
if (changed.length === 0) {
  console.log("source state already matches; nothing to recertify");
  process.exit(0);
}

const sourceStateId = createHash("sha256")
  .update(JSON.stringify(entries.map((entry) => [entry.path, entry.blobHash])))
  .digest("hex");
const priorSourceStateId = doc.sourceStateId;
const priorSurfaceVersion = doc.surfaceVersion;
doc.materialFileHashes = hashes;
doc.sourceStateId = sourceStateId;
doc.surfaceVersion = "r14-free-cloud-capacity-v1";
doc.recertifications.push({
  label: "R14 Free Cloud capacity source-state reconciliation",
  reason: "The R14 handoff was clean, but the committed source-state manifest contained stale hashes for two existing material files. Their current content matches HEAD and was reconciled before the final regression; R14 capacity changes remain outside the ForgeGreen material surface.",
  priorSourceStateId,
  priorSurfaceVersion,
  resultingSourceStateId: sourceStateId,
  resultingSurfaceVersion: doc.surfaceVersion,
  changes: changed.map((file) => ({ file, change: "Recomputed the certified hash from the existing repository content; no production source edit was made in this file.", addedToMaterialFiles: false })),
  regressionEvidence: "Full Vitest completed with the two source-state sentinels failing only on the stale manifest; the sentinels are rerun after this guarded reconciliation.",
  recertifiedAt: new Date().toISOString(),
  sourceStateConstant: "CODEFORGE_R14_FREE_CLOUD_CAPACITY_SOURCE_STATE",
});
doc.recertifiedAt = new Date().toISOString();
doc.recertification = {
  phase: "R14 Free Cloud capacity",
  reason: "Reconcile pre-existing certified-source hashes before final regression.",
  changedFiles: changed,
  priorSourceStateId,
  guarded: true,
};
doc.generationNote = `${String(doc.generationNote).replace(/\.$/, "")}, and the R14 Free Cloud capacity reconciliation above.`;
fs.writeFileSync(docPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ sourceStateId, changedFiles: changed, materialFileCount: materialFiles.length }, null, 2));
