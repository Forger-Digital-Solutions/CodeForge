import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
const path = "docs/codeforge-forgegreen-certified-source-state.json";
const doc = JSON.parse(await readFile(path, "utf8"));
const start = JSON.parse(await readFile("docs/evidence/r66-everyday-free-readiness/R66-START-STATE.json", "utf8"));
const preserved = new Set(start.preservedFiles.map((entry) => entry.path));
const diff = execFileSync("git", ["diff", "--name-only"], { encoding: "utf8" }).trim().split(/\r?\n/);
const additions = [...diff.filter((file) => /^(packages|apps)\//.test(file) && !preserved.has(file)),
  "apps/cloud-api/src/production-remote-direct.ts", "packages/server/src/remote-direct-cloud-provider.ts", "apps/cloud-api/test/remote-direct-dispatch.test.ts",
  "packages/server/test/remote-control-pressure.test.ts"];
const materialFiles = [...new Set([...doc.materialFiles, ...additions])].sort((a, b) => a.localeCompare(b));
const entries = materialFiles.map((path) => ({ path, blobHash: execFileSync("git", ["hash-object", path], { encoding: "utf8" }).trim() }));
const sourceStateId = createHash("sha256").update(JSON.stringify(entries.map(({ path, blobHash }) => [path, blobHash]))).digest("hex");
if (sourceStateId !== doc.sourceStateId) {
  const changedFiles = entries.filter(({ path, blobHash }) => doc.materialFileHashes[path] !== blobHash).map(({ path }) => path);
  const reason = "R66 traced live qualification exposed missing Explorer report budget, invalid parallel tool transcript grouping, discarded complete JSON, and grounded NodeNext imports falsely scored as invented paths. Measured role tier now precedes domain order, with bounded independent review across domains. Scoring thresholds, call caps, privacy and completion authority are preserved.";
  const priorSourceStateId = doc.sourceStateId;
  const priorSurfaceVersion = doc.surfaceVersion;
  Object.assign(doc, { sourceStateId, surfaceVersion: "r66-everyday-free-readiness-v1", materialFiles,
    materialFileHashes: Object.fromEntries(entries.map(({ path, blobHash }) => [path, blobHash])), recertifiedAt: "2026-10-03",
    recertification: { phase: "R66 role transport and role team", reason, changedFiles, priorSourceStateId, guarded: true } });
  doc.recertifications.push({ label: "R66 everyday Free role quality", reason, priorSourceStateId, priorSurfaceVersion,
    resultingSourceStateId: sourceStateId, resultingSurfaceVersion: doc.surfaceVersion, recertifiedAt: doc.recertifiedAt,
    changedFiles: changedFiles.map((file) => ({ file, addedToMaterialFiles: additions.includes(file) })), regressionEvidence: "docs/evidence/r66-everyday-free-readiness/R66-REPOSITORY-TESTS.json" });
  await writeFile(path, `${JSON.stringify(doc, null, 2)}\n`);
}
console.log(JSON.stringify({ surfaceVersion: doc.surfaceVersion, sourceStateId }));
