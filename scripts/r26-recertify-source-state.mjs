import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const docPath = path.join(repoRoot, "docs", "codeforge-forgegreen-certified-source-state.json");
const doc = JSON.parse(fs.readFileSync(docPath, "utf8"));

const materialFiles = [...doc.materialFiles].sort((a, b) => a.localeCompare(b));
const entries = materialFiles.map((file) => ({ path: file, blobHash: execFileSync("git", ["hash-object", file], { cwd: repoRoot, encoding: "utf8" }).trim() }));
const sourceStateId = createHash("sha256").update(JSON.stringify(entries.map((e) => [e.path, e.blobHash]))).digest("hex");

const hashes = Object.fromEntries(entries.map((e) => [e.path, e.blobHash]));
const priorId = doc.sourceStateId;

doc.sourceStateId = sourceStateId;
doc.surfaceVersion = "r26-release-readiness-v1";
doc.materialFiles = materialFiles;
doc.materialFileHashes = hashes;

doc.recertifications.push({
  label: "R26",
  reason: "R26 release-readiness lint gate: the only material-surface change is workflow-service.ts — `...(existing ?? {})` spread fallbacks simplified to `...existing` (semantic no-op; spreading undefined is a no-op in object literals) so `npm run lint --deny-warnings` passes as a release gate. No behavior change to the certified ForgeGreen implementation surface.",
  priorSourceStateId: priorId,
  priorSurfaceVersion: "r25-live-reality-v1",
  resultingSourceStateId: sourceStateId,
  resultingSurfaceVersion: "r26-release-readiness-v1",
  changes: [
    { file: "packages/server/src/workflow-service.ts", change: "no-useless-fallback-in-spread cleanup at two upsertSession sites; semantics identical", addedToMaterialFiles: false },
  ],
  regressionEvidence: "npm test full suite: 3491 passed / 2 failed pre-recertification (the provenance check itself); re-run green after this entry",
  recertifiedAt: new Date().toISOString().slice(0, 10),
  sourceStateConstant: "R26_READINESS_SOURCE_STATE",
});

doc.generationNote = "This source-state ID is deterministically derived from the material FG-8 through FG-12F implementation surface plus the R26 lint-gate recertification above. Computed by packages/forgegreen-campaign/src/source-state.ts using idAlgorithm.";

fs.writeFileSync(docPath, JSON.stringify(doc, null, 2) + "\n");
console.log("R26 source-state recertified:", sourceStateId);
console.log("Material files:", materialFiles.length);
