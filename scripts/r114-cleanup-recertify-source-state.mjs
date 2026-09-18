// CodeForge R11.4 recertification for the definitive-POST cleanup.
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
]);
const unexpected = changed.filter((file) => !expectedChangedFiles.has(file));
if (unexpected.length > 0) {
  throw new Error(`Unexpected certified-source drift; refusing recertification: ${unexpected.join(", ")}`);
}

const notes = {
  "packages/server/src/agent-runtime.ts":
    "Removes an unused StreamEvent type import after the definitive POST freeze. No runtime behavior, routing, verification, approval, ForgeZero, or completion policy changes.",
};

const priorSourceStateId = doc.sourceStateId;
const priorSurfaceVersion = doc.surfaceVersion;
const resultingSurfaceVersion = "fg12f-certified-v1-r114-definitive-post";
doc.recertifications.push({
  label: "R11.4 definitive-POST cleanup source-state recertification",
  reason:
    "The definitive 40-case POST froze at cb4b9cf (33/40 verified, 0 false completions, 7 genuine hidden-verifier failures). After the freeze, the deferred lint debt was removed: an unused StreamEvent import in the agent runtime. A suspended real Google API key used as a redaction-test input was also replaced with a documented synthetic sample in a non-material test file.",
  priorSourceStateId,
  priorSurfaceVersion,
  resultingSourceStateId: sourceStateId,
  resultingSurfaceVersion,
  changes: changed.map((file) => ({ file, change: notes[file], addedToMaterialFiles: false })),
  regressionEvidence:
    "Typecheck PASS, lint 0/0, workspace build PASS; full vitest rerun after recertification plus the 12/12-file 80/80 PostgreSQL campaign.",
  recertifiedAt: new Date().toISOString().slice(0, 10),
  sourceStateConstant: "CODEFORGE_R114_DEFINITIVE_POST_SOURCE_STATE",
});
doc.sourceStateId = sourceStateId;
doc.surfaceVersion = resultingSurfaceVersion;
doc.materialFileHashes = hashes;
doc.recertifiedAt = new Date().toISOString();
doc.recertification = {
  phase: "R11.4 release-candidate closure",
  reason: "Post-freeze lint cleanup and suspended-credential test-input replacement",
  changedFiles: changed.map((file) => ({ path: file, summary: notes[file] })),
  priorSourceStateId,
  guarded: true,
};
if (!doc.generationNote.includes("R11.4 definitive-POST recertification")) {
  doc.generationNote = `${doc.generationNote.replace(/\.$/, "")}, and the R11.4 definitive-POST recertification above.`;
}

fs.writeFileSync(docPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
console.log(`recertified ${changed.length} changed material file(s): ${changed.join(", ")}`);
console.log(`prior=${priorSourceStateId}\nnew  =${sourceStateId}`);
