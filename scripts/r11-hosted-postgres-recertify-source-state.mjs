// CodeForge R11 recertification for the PostgreSQL-proven hosted workflow boundary.
//
// Guarded and append-only: only the reviewed material files may differ. Historical identities
// stay intact, and the new identity is derived from the current repository bytes.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const docPath = path.join(repoRoot, "docs", "codeforge-forgegreen-certified-source-state.json");
const doc = JSON.parse(fs.readFileSync(docPath, "utf8"));
const materialFiles = [...doc.materialFiles].sort((a, b) => a.localeCompare(b));
const entries = materialFiles.map((file) => ({
  path: file,
  blobHash: execFileSync("git", ["hash-object", file], { cwd: repoRoot, encoding: "utf8" }).trim(),
}));
const sourceStateId = createHash("sha256")
  .update(JSON.stringify(entries.map((entry) => [entry.path, entry.blobHash])))
  .digest("hex");
const hashes = Object.fromEntries(entries.map((entry) => [entry.path, entry.blobHash]));
const changed = materialFiles.filter((file) => doc.materialFileHashes[file] !== hashes[file]);

if (changed.length === 0) {
  console.log("source state already matches; nothing to recertify");
  process.exit(0);
}

const expectedChangedFiles = new Set([
  "packages/server/src/agent-runtime.ts",
  "packages/server/src/workflow-service.ts",
  "packages/workflow/src/types.ts",
]);
const unexpected = changed.filter((file) => !expectedChangedFiles.has(file));
if (unexpected.length > 0 || changed.some((file) => !expectedChangedFiles.has(file))) {
  throw new Error(`Unexpected certified-source drift; refusing recertification: ${unexpected.join(", ")}`);
}

const notes = {
  "packages/server/src/agent-runtime.ts":
    "Applies the existing ForgeZero and approval gates before durable hosted-worker dispatch, so a remote edit cannot bypass the same user authorization required by local execution.",
  "packages/server/src/workflow-service.ts":
    "Persists and resumes the approved workflow plan and pre-edit snapshot across hosted-worker process restarts, then returns control to ForgeVerify and the existing completion gate for the only terminal verdict.",
  "packages/workflow/src/types.ts":
    "Represents durable worker suspension as an explicit nonterminal workflow outcome; it cannot be counted as completed and carries no completion authority.",
};

const priorSourceStateId = doc.sourceStateId;
const priorSurfaceVersion = doc.surfaceVersion;
const resultingSurfaceVersion = "fg12f-certified-v1-r11-hosted-postgres";
doc.recertifications.push({
  label: "R11 PostgreSQL hosted-workflow source-state recertification",
  reason:
    "The real PostgreSQL campaign activated a previously skipped restart test and exposed two release-critical defects: hosted workflows had no top-level resume path, and hosted edit dispatch bypassed the normal approval gate. The repaired path is restart-safe, row-locked across competing processes, approval-gated, and can finish only through ForgeVerify plus evaluateCompletion.",
  priorSourceStateId,
  priorSurfaceVersion,
  resultingSourceStateId: sourceStateId,
  resultingSurfaceVersion,
  changes: changed.map((file) => ({ file, change: notes[file], addedToMaterialFiles: false })),
  regressionEvidence:
    "Real PostgreSQL campaign passed 12/12 files and 80/80 tests; hosted continuation unit tests passed 2/2; workflow, sessions, and server builds passed before recertification.",
  recertifiedAt: new Date().toISOString().slice(0, 10),
  sourceStateConstant: "CODEFORGE_R11_HOSTED_POSTGRES_SOURCE_STATE",
});
doc.sourceStateId = sourceStateId;
doc.surfaceVersion = resultingSurfaceVersion;
doc.materialFileHashes = hashes;
doc.recertifiedAt = new Date().toISOString();
doc.recertification = {
  phase: "R11 release-candidate closure",
  reason: "PostgreSQL-proven hosted workflow suspension, approval, and resumption",
  changedFiles: changed.map((file) => ({ path: file, summary: notes[file] })),
  priorSourceStateId,
  guarded: true,
};
if (!doc.generationNote.includes("R11 PostgreSQL hosted-workflow recertification")) {
  doc.generationNote = `${doc.generationNote.replace(/\.$/, "")}, and the R11 PostgreSQL hosted-workflow recertification above.`;
}

fs.writeFileSync(docPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
console.log(`recertified ${changed.length} changed material file(s): ${changed.join(", ")}`);
console.log(`prior=${priorSourceStateId}\nnew  =${sourceStateId}`);
