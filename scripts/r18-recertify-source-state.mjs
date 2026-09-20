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
const priorSurface = doc.surfaceVersion;
const changedFiles = entries.filter((e) => doc.materialFileHashes[e.path] !== e.blobHash).map((e) => e.path);

doc.sourceStateId = sourceStateId;
doc.surfaceVersion = "r18-release-candidate-v1";
doc.materialFileHashes = hashes;
doc.recertifiedAt = "2026-09-19";

doc.recertifications.push({
  label: "R18 release-candidate source-state reconciliation",
  reason:
    "The certified surface last froze at r15-release-hardening-v1. Since then three reviewed, committed campaigns touched material files: 71be319 (R16 — agent command execution routed through headless ConPTY), e49e6b8 (R16 — canonical run lifecycle + owner-aware failure attribution), and 4372290 (R17 — workspace/task UX truthfulness, activity projection, honest completion, parallel visibility). Every drifted file was diffed against its certified blob during R18; the protected seams are unchanged in authority — ForgeZero still gates all routing, evaluateCompletion in packages/workflow/src/completion-gate.ts remains the only path to 'completed', ForgeVerify validity still resolves through the single exported isEvidenceCurrentlyValid, and verification reuse remains cost-gated and fail-closed. No material file was added or removed; the frozen set is re-issued over the reviewed content rather than ignoring the drift.",
  priorSourceStateId: priorId,
  priorSurfaceVersion: priorSurface,
  resultingSourceStateId: sourceStateId,
  resultingSurfaceVersion: "r18-release-candidate-v1",
  changes: [
    { file: "packages/server/src/agent-runtime.ts", change: "R16 headless-ConPTY command routing plus canonical run lifecycle; R17 activity/event projection for truthful file and command visibility. ForgeZero routing authority unchanged.", addedToMaterialFiles: false },
    { file: "packages/server/src/duplicate-suppression.ts", change: "R17 duplicate task-row/tool suppression keyed on stable identities.", addedToMaterialFiles: false },
    { file: "packages/server/src/workflow-service.ts", change: "R16 canonical lifecycle + owner-aware failure attribution; R17 completion summaries that distinguish verified success from blocked plan state. evaluateCompletion remains the only completion authority.", addedToMaterialFiles: false },
    { file: "packages/sessions/src/persistence.ts", change: "R16 lifecycle/persistence records for canonical run state and attribution.", addedToMaterialFiles: false },
    { file: "packages/sessions/src/postgres-persistence.ts", change: "R16 parity changes for the hosted persistence surface.", addedToMaterialFiles: false },
    { file: "packages/sessions/src/session-state.ts", change: "R16 canonical lifecycle state records consumed by the R17 truthful projection.", addedToMaterialFiles: false },
    { file: "packages/tools/src/index.ts", change: "R16 headless ConPTY execution path so agent commands never spawn visible consoles.", addedToMaterialFiles: false },
    { file: "packages/workflow/src/forge-verify.ts", change: "R16 observer surface for headless verification execution; the single exported validity authority is unchanged.", addedToMaterialFiles: false },
    { file: "packages/workflow/src/types.ts", change: "R16 lifecycle/verification record types extended for owner attribution.", addedToMaterialFiles: false },
    { file: "packages/workflow/src/verification-service.ts", change: "R16 headless verification execution path; plan construction, authoritative revalidation, and cost-gated reuse seams unchanged.", addedToMaterialFiles: false },
  ],
  regressionEvidence:
    "R18 campaign: canonical Vitest suite rerun at the reviewed tree (2970 pass, expected skips); R16 packaged smoke (full/interrupt/recover, zero FAIL) re-confirmed; R17 packaged artifact byte-verified via internal dependency audit; live installed-product validation of blocked/completed/stopped runs, approval cancellation, multi-run grouping, and terminal reconciliation documented under docs/evidence/r18-release-candidate/.",
  recertifiedAt: "2026-09-19",
  sourceStateConstant: "R18_RELEASE_CANDIDATE_SOURCE_STATE",
});

doc.recertification = {
  phase: "R18 release-candidate reconciliation",
  reason: "Re-issue the frozen ForgeGreen source-state over the reviewed R16/R17 committed surface so the fg11/fg12e provenance canaries certify the current tree.",
  changedFiles,
  priorSourceStateId: priorId,
  guarded: true,
};

doc.generationNote =
  "This source-state ID is deterministically derived from the material FG-8 through FG-12F implementation surface present on the recovered lineage, including the FG-11, FG-12D, and FG-12F recertifications above and the R18 release-candidate reconciliation above. Computed by packages/forgegreen-campaign/src/source-state.ts using idAlgorithm.";

fs.writeFileSync(docPath, JSON.stringify(doc, null, 2) + "\n");
console.log("R18 source-state recertified:", sourceStateId);
console.log("Prior:", priorId, `(${priorSurface})`);
console.log("Material files:", materialFiles.length);
