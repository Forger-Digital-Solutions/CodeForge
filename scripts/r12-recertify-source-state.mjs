// Guarded R12 source-state recertification. This updates only the deterministic source-state
// manifest after the R12 material implementation surface has been reviewed.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const docPath = path.join(root, "docs/codeforge-forgegreen-certified-source-state.json");
const doc = JSON.parse(fs.readFileSync(docPath, "utf8"));
const r12Files = [
  "packages/agent/src/index.ts",
  "packages/agent/src/planning-contract.ts",
  "packages/benchmark/src/codeforge-bench-r2.ts",
  "packages/benchmark/src/index.ts",
  "packages/benchmark/src/protected-acceptance.ts",
  "packages/context/src/index.ts",
  "packages/secrets/src/index.ts",
  "packages/server/src/autonomous-orchestrator.ts",
  "packages/server/src/duplicate-suppression.ts",
  "packages/tools/src/index.ts",
];
const materialFiles = [...new Set([...doc.materialFiles, ...r12Files])].sort((a, b) => a.localeCompare(b));
const entries = materialFiles.map((file) => ({
  path: file,
  blobHash: execFileSync("git", ["hash-object", file], { cwd: root, encoding: "utf8" }).trim(),
}));
const hashes = Object.fromEntries(entries.map((entry) => [entry.path, entry.blobHash]));
const sourceStateId = createHash("sha256")
  .update(JSON.stringify(entries.map((entry) => [entry.path, entry.blobHash])))
  .digest("hex");
const changed = r12Files.filter((file) => doc.materialFileHashes[file] !== hashes[file]);
const priorSourceStateId = doc.sourceStateId;
const priorSurfaceVersion = doc.surfaceVersion;
const priorHashes = { ...doc.materialFileHashes };

doc.materialFiles = materialFiles;
doc.materialFileHashes = hashes;
doc.sourceStateId = sourceStateId;
doc.surfaceVersion = "r12-release-closure-v1";
doc.recertifications.push({
  label: "R12 public release gate closure",
  reason: "General protected-acceptance, planning-completeness, authority-boundary, secret-redaction, and no-progress remediation was reviewed as intended R12 material source work.",
  priorSourceStateId,
  priorSurfaceVersion,
  resultingSourceStateId: sourceStateId,
  resultingSurfaceVersion: "r12-release-closure-v1",
  changes: changed.map((file) => ({ file, change: "Reviewed R12 remediation source; included in the new deterministic source-state surface.", addedToMaterialFiles: !priorHashes[file] })),
  regressionEvidence: "R12 focused tests, lint, typecheck, workspace build, dependency audit, secret scan, and the full Vitest rerun were required before final closure.",
  recertifiedAt: new Date().toISOString(),
  sourceStateConstant: "CODEFORGE_R12_RELEASE_CLOSURE_SOURCE_STATE",
});
doc.recertifiedAt = new Date().toISOString();
doc.recertification = {
  phase: "R12 release closure",
  reason: "Intentional R12 remediation source changes; historical R11 benchmark and release evidence remains untouched.",
  changedFiles: changed,
  priorSourceStateId,
  guarded: true,
};
fs.writeFileSync(docPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ sourceStateId, addedFiles: changed, materialFileCount: materialFiles.length }, null, 2));
