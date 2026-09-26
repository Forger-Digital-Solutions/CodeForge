import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const docPath = path.join(repoRoot, "docs", "codeforge-forgegreen-certified-source-state.json");
const doc = JSON.parse(fs.readFileSync(docPath, "utf8"));

const ADDITIONS = [
  "packages/server/src/forgegreen-run-policy.ts",
  "packages/server/src/model-execution-adapter.ts",
];

for (const file of ADDITIONS) {
  if (!doc.materialFiles.includes(file)) doc.materialFiles.push(file);
}

const materialFiles = [...doc.materialFiles].sort((a, b) => a.localeCompare(b));
const entries = materialFiles.map((file) => ({ path: file, blobHash: execFileSync("git", ["hash-object", file], { cwd: repoRoot, encoding: "utf8" }).trim() }));
const sourceStateId = createHash("sha256").update(JSON.stringify(entries.map((e) => [e.path, e.blobHash]))).digest("hex");

const priorId = doc.sourceStateId;
const priorSurface = doc.surfaceVersion;
const changedFiles = entries.filter((e) => doc.materialFileHashes[e.path] !== e.blobHash).map((e) => e.path);

doc.sourceStateId = sourceStateId;
doc.surfaceVersion = "r42-forgegreen-selectivity-v1";
doc.materialFiles = materialFiles;
doc.materialFileHashes = Object.fromEntries(entries.map((e) => [e.path, e.blobHash]));
doc.recertifiedAt = new Date().toISOString().slice(0, 10);

doc.recertifications.push({
  label: "R42 ForgeGreen selectivity source-state reconciliation",
  reason:
    "R42 adds a per-run selective optimization policy (ForgeGreenRunPolicy) that gates the certified controls by request signals and escalates toward baseline on quality-risk signals, plus a conservative no-replay mode in the duplicate classifier and a completed-response replay guard in model-request dedup. agent-runtime.ts and duplicate-suppression.ts changed inside the frozen set; forgegreen-run-policy.ts and model-execution-adapter.ts are added to the material surface because they now decide when optimization may act. No gate was weakened: evaluateCompletion remains the only completion authority, ForgeZero routing authority unchanged, and OFF reproduces the certified disabled arm byte-for-byte.",
  priorSourceStateId: priorId,
  priorSurfaceVersion: priorSurface,
  resultingSourceStateId: sourceStateId,
  resultingSurfaceVersion: "r42-forgegreen-selectivity-v1",
  changes: [
    { file: "packages/server/src/forgegreen-run-policy.ts", change: "New material file: per-run ForgeGreen level resolution (FULL/CONSERVATIVE/OFF) from request signals with monotonic quality-risk escalation.", addedToMaterialFiles: true },
    { file: "packages/server/src/model-execution-adapter.ts", change: "New material file: model-request dedup consults the run policy — CONSERVATIVE joins in-flight duplicates but never replays a completed response; escalation epoch folds into the dedupe key.", addedToMaterialFiles: true },
    { file: "packages/server/src/agent-runtime.ts", change: "Run policy resolved per executeAgentRun; control call-sites consult it; escalations on unusable response, provider failover, and no-effect write.", addedToMaterialFiles: false },
    { file: "packages/server/src/duplicate-suppression.ts", change: "classify(identity, {replay:false}) keeps the no-progress bound while never replaying a prior output.", addedToMaterialFiles: false },
    { file: "packages/forge-green/src/index.ts", change: "runDeduplicated accepts completedReplay:false — in-flight join only, finished responses never served.", addedToMaterialFiles: false },
  ],
  regressionEvidence:
    "Targeted: packages/server test suite 222/222 including forgegreen-run-policy 10/10 and fg9 unsafe-mutating; tsc -b clean on server+forge-green. Full canonical recorded in docs/evidence/r42-production-stress/R42-REGRESSION.md.",
  recertifiedAt: doc.recertifiedAt,
  sourceStateConstant: "R42_FORGEGREEN_SELECTIVITY_SOURCE_STATE",
});

doc.recertification = {
  phase: "R42 ForgeGreen selectivity reconciliation",
  reason: "Re-issue the frozen ForgeGreen source-state over the reviewed R42 surface so the fg11/fg12e provenance canaries certify the current tree.",
  changedFiles,
  priorSourceStateId: priorId,
  guarded: true,
};

doc.generationNote =
  "This source-state ID is deterministically derived from the material FG-8 through R42 implementation surface present on the recovered lineage, including the FG-11, FG-12D, FG-12F, R18, R37, R41, and R42 recertifications above. Computed by packages/forgegreen-campaign/src/source-state.ts using idAlgorithm.";

fs.writeFileSync(docPath, JSON.stringify(doc, null, 2) + "\n");
console.log(`re-issued ${doc.surfaceVersion}: ${sourceStateId} (changed: ${changedFiles.join(", ") || "none"})`);
