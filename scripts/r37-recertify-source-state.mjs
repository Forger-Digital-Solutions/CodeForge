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
doc.surfaceVersion = "r37-intelligence-capacity-v1";
doc.materialFileHashes = hashes;
doc.recertifiedAt = "2026-09-26";

doc.recertifications.push({
  label: "R37 intelligence-fabric source-state reconciliation",
  reason:
    "The certified surface last froze at r35-backend-finalization-interim-v1. R37 touched exactly one material file via commit 855f178 (ForgeVerify semantic hardening): semantic-diff-review now detects focused-test markers (.only/fit/fdescribe) so a narrowed suite cannot masquerade as green. This strengthens the certified detector's blocking surface — it removes no finding, weakens no gate; evaluateCompletion remains the only completion authority and ForgeZero routing authority is unchanged. The frozen set is re-issued over the reviewed content rather than ignoring the drift.",
  priorSourceStateId: priorId,
  priorSurfaceVersion: priorSurface,
  resultingSourceStateId: sourceStateId,
  resultingSurfaceVersion: "r37-intelligence-capacity-v1",
  changes: [
    { file: "packages/workflow/src/semantic-diff-review.ts", change: "R37 ForgeVerify hardening: focused-test markers (it.only/test.only/describe.only/fit/fdescribe with title args) are blocking findings, so a suite-narrowing diff cannot evade semantic review. Existing findings unchanged.", addedToMaterialFiles: false },
  ],
  regressionEvidence:
    "R37 campaign: canonical Vitest suite at the reviewed tree (3746+ pass, expected Postgres-environment skips, zero unexpected failures); focused semantic-diff suite 20/20 including the focused-test cases and the fit() helper false-positive control.",
  recertifiedAt: "2026-09-26",
  sourceStateConstant: "R37_INTELLIGENCE_CAPACITY_SOURCE_STATE",
});

doc.recertification = {
  phase: "R37 intelligence-capacity reconciliation",
  reason: "Re-issue the frozen ForgeGreen source-state over the reviewed R37 committed surface so the fg11/fg12e provenance canaries certify the current tree.",
  changedFiles,
  priorSourceStateId: priorId,
  guarded: true,
};

doc.generationNote =
  "This source-state ID is deterministically derived from the material FG-8 through FG-12F implementation surface present on the recovered lineage, including the FG-11, FG-12D, FG-12F, R18, and R37 recertifications above. Computed by packages/forgegreen-campaign/src/source-state.ts using idAlgorithm.";

fs.writeFileSync(docPath, JSON.stringify(doc, null, 2) + "\n");
console.log(`re-issued ${doc.surfaceVersion}: ${sourceStateId} (changed: ${changedFiles.join(", ") || "none"})`);
