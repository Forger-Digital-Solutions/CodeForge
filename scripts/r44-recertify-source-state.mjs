import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const docPath = path.join(repoRoot, "docs", "codeforge-forgegreen-certified-source-state.json");
const doc = JSON.parse(fs.readFileSync(docPath, "utf8"));

// compress.ts decides what ForgeGreen tool-output compression emits into model context —
// a material optimization control that R43 and R44 both changed but had never been pinned
// in the certified surface. It is added for the same reason R42 added the policy files.
const ADDITIONS = [
  "packages/tools/src/compress.ts",
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
doc.surfaceVersion = "r44-multifile-intelligence-v1";
doc.materialFiles = materialFiles;
doc.materialFileHashes = Object.fromEntries(entries.map((e) => [e.path, e.blobHash]));
doc.recertifiedAt = new Date().toISOString().slice(0, 10);

doc.recertifications.push({
  label: "R44 multi-file intelligence + edit-discipline source-state reconciliation",
  reason:
    "R44 adds bounded deterministic structured-output repair with recorded repair strategies, a per-run observed-state gate that denies blind mutations (EDIT_MISSING_STATE) and auto-attaches the observed hash to edits the model omitted it on, per-attempt first-edit telemetry and structured-output telemetry on the run journal, an explicit reviewer diff-truncation marker, a compression failure-line extension covering jest ●/Rust panicked/segfault/timeout formats, and an explorer prompt rule for batched lookups. compress.ts enters the material set because it is a ForgeGreen control deciding model-context content. No gate was weakened: stale edits still fail closed, suppression still requires state evidence, evaluateCompletion remains the only completion authority, and ForgeZero routing is unchanged.",
  priorSourceStateId: priorId,
  priorSurfaceVersion: priorSurface,
  resultingSourceStateId: sourceStateId,
  resultingSurfaceVersion: "r44-multifile-intelligence-v1",
  changes: [
    { file: "packages/agent/src/index.ts", change: "Ordered bounded repair (fenced block → brace extract → trailing-comma strip) with repairedWith telemetry; coder read→hash→edit contract; explorer batching rule; EDIT_MISSING_STATE canonical code.", addedToMaterialFiles: false },
    { file: "packages/server/src/agent-runtime.ts", change: "Observed-state mutation gate, hash auto-attach, EditAttemptRecord/StructuredOutputTelemetry, journal telemetry block, route reliability feed on structured-output exhaustion.", addedToMaterialFiles: false },
    { file: "packages/server/src/autonomous-orchestrator.ts", change: "Reviewer diff context extracted to buildReviewerDiffContext with explicit truncation marker for the §18 regression pin.", addedToMaterialFiles: false },
    { file: "packages/tools/src/index.ts", change: "Tool descriptions carry the read→hash contract; post-write [hash:] surfacing; bracketed canonical error codes reach ToolExecutionRecord.error.", addedToMaterialFiles: false },
    { file: "packages/tools/src/compress.ts", change: "Failure-line pattern extended (jest ●, panicked, segmentation fault, core dumped, timed out); added to the certified material surface.", addedToMaterialFiles: true },
  ],
  regressionEvidence:
    "R44 targeted suites green: r44-edit-discipline 6/6, r44-reviewer-visibility 3/3, r44-compression-formats 9/9, fg1-compression 9/9, structured-output-security 19/19, agent-orchestrator-integration 8/8, fg1-runtime-efficiency 8/8, role benchmark 15/15, provider-saturation sim 28/28. Full canonical recorded in docs/evidence/r44-multifile/R44-REGRESSION.md.",
  recertifiedAt: doc.recertifiedAt,
  sourceStateConstant: "R44_MULTIFILE_INTELLIGENCE_SOURCE_STATE",
});

doc.recertification = {
  phase: "R44 multi-file intelligence reconciliation",
  reason: "Re-issue the frozen ForgeGreen source-state over the reviewed R44 surface so the fg11/fg12e provenance canaries certify the current tree.",
  changedFiles,
  priorSourceStateId: priorId,
  guarded: true,
};

doc.generationNote =
  "This source-state ID is deterministically derived from the material FG-8 through R44 implementation surface present on the recovered lineage, including the FG-11, FG-12D, FG-12F, R18, R37, R41, R42, R43, and R44 recertifications above. Computed by packages/forgegreen-campaign/src/source-state.ts using idAlgorithm.";

fs.writeFileSync(docPath, JSON.stringify(doc, null, 2) + "\n");
console.log(`re-issued ${doc.surfaceVersion}: ${sourceStateId} (changed: ${changedFiles.join(", ") || "none"})`);
