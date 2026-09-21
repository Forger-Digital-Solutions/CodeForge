import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const docPath = path.join(repoRoot, "docs", "codeforge-forgegreen-certified-source-state.json");
const doc = JSON.parse(fs.readFileSync(docPath, "utf8"));

const R25_FILES = [
  "packages/workflow/src/diff-review.ts",
  "packages/workflow/src/semantic-diff-review.ts",
  "packages/workflow/src/types.ts",
];

const materialFiles = [...new Set([...doc.materialFiles, ...R25_FILES])].sort((a, b) => a.localeCompare(b));
const entries = materialFiles.map((file) => ({ path: file, blobHash: execFileSync("git", ["hash-object", file], { cwd: repoRoot, encoding: "utf8" }).trim() }));
const sourceStateId = createHash("sha256").update(JSON.stringify(entries.map((e) => [e.path, e.blobHash]))).digest("hex");

const hashes = Object.fromEntries(entries.map((e) => [e.path, e.blobHash]));
const priorId = doc.sourceStateId;
const priorSurface = doc.surfaceVersion;

doc.sourceStateId = sourceStateId;
doc.surfaceVersion = "r25-live-reality-v1";
doc.materialFiles = materialFiles;
doc.materialFileHashes = hashes;

doc.recertifications.push({
  label: "R25",
  reason: "R25 Live Reality campaign: deterministic semantic diff-review layer added to the certified completion-authority surface (reviewDiff -> evaluateCompletion unchanged as the single authority), plus live free-provider qualification, paired live pilot, durable PostgreSQL admission, crash recovery, quota-forecast, and fairness evidence. The semantic detector is additive and fail-closed: blocking findings flow through the existing review_rejected path.",
  priorSourceStateId: priorId,
  priorSurfaceVersion: priorSurface,
  resultingSourceStateId: sourceStateId,
  resultingSurfaceVersion: "r25-live-reality-v1",
  changes: [
    { file: "packages/workflow/src/semantic-diff-review.ts", change: "New file. Deterministic semantic detection for adversarial patch patterns: hard-coded fixture responses, test-input special-casing, environment-only behavior, empty/swallowing catches, dead branches, weakened/skipped/deleted assertions, unreferenced new symbols, comment-only changes. Findings are typed into ReviewFinding.code and appended by reviewDiff into the existing ReviewDecision.findings.", addedToMaterialFiles: true },
    { file: "packages/workflow/src/diff-review.ts", change: "reviewDiff now runs the semantic layer on every diff and appends findings into the same decision object consumed by evaluateCompletion; no second authority added.", addedToMaterialFiles: true },
    { file: "packages/workflow/src/types.ts", change: "ReviewFinding.code union widened with the seven semantic finding codes (test_assertion_weakened, error_swallow_added, environment_special_case, dead_branch_added, test_input_special_case, unreferenced_new_symbol, non_functional_change).", addedToMaterialFiles: true },
    { file: "packages/forgegreen-campaign/src/r23/tasks.ts", change: "Task schema widened additively for R25 corpus classes/roles (reviewer, investigation, test_fix, ambiguous); r23-task-manifest-1 literal preserved for the r23 protocol.", addedToMaterialFiles: false },
    { file: "packages/forgegreen-campaign/src/r23/run-task.ts", change: "Reviewer tasks deliver their validated structured verdict as the run deliverable; blocked-with-verdict runs surface the structured summary for answer-key verification. Completion authority unchanged.", addedToMaterialFiles: false },
  ],
  regressionEvidence: "docs/evidence/r25-live-reality/ — R25-RECOVERY-CHECKPOINT.md, R25-PHASE3-4-CHECKPOINT.md, R25-PHASE5-6-CHECKPOINT.md, live-preflight.json, qualification-pass1.json, durable-admission.json, quota-forecast.json, bench/raw/pilot/",
  recertifiedAt: new Date().toISOString().slice(0, 10),
  sourceStateConstant: "R25_LIVE_REALITY_SOURCE_STATE",
});

fs.writeFileSync(docPath, `${JSON.stringify(doc, null, 2)}\n`);
console.log("R25 source-state recertified:", sourceStateId);
console.log("Material files:", materialFiles.length);
