import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
const path = "docs/codeforge-forgegreen-certified-source-state.json";
const doc = JSON.parse(await readFile(path, "utf8"));
const start = JSON.parse(await readFile("docs/evidence/free-capacity-fabric/R65-START-STATE.json", "utf8"));
const preserved = new Set(start.preservedFiles.map((entry) => entry.path));
const diff = execFileSync("git", ["diff", "--name-only"], { encoding: "utf8" }).trim().split(/\r?\n/);
const additions = [...diff.filter((file) => /^(packages|apps)\//.test(file) && !preserved.has(file)),
  "apps/cloud-api/src/production-remote-direct.ts", "packages/server/src/remote-direct-cloud-provider.ts", "apps/cloud-api/test/remote-direct-dispatch.test.ts"];
const materialFiles = [...new Set([...doc.materialFiles, ...additions])].sort((a, b) => a.localeCompare(b));
const entries = materialFiles.map((path) => ({ path, blobHash: execFileSync("git", ["hash-object", path], { encoding: "utf8" }).trim() }));
const sourceStateId = createHash("sha256").update(JSON.stringify(entries.map(({ path, blobHash }) => [path, blobHash]))).digest("hex");
if (sourceStateId !== doc.sourceStateId) {
  const changedFiles = entries.filter(({ path, blobHash }) => doc.materialFileHashes[path] !== blobHash).map(({ path }) => path);
  const reason = "R65 connects authenticated owner-scoped remote assignment production to the governed client runtime, verifies public-code consent and role-qualified Free supply on each admission, keeps cancellation monotone, and isolates benchmark generation from existing user work. Provider authorization remains fail closed on paid or ambiguous capacity; verification and completion policies are unchanged.";
  const priorSourceStateId = doc.sourceStateId;
  const priorSurfaceVersion = doc.surfaceVersion;
  Object.assign(doc, { sourceStateId, surfaceVersion: "r65-free-capacity-fabric-v1", materialFiles,
    materialFileHashes: Object.fromEntries(entries.map(({ path, blobHash }) => [path, blobHash])), recertifiedAt: "2026-10-02",
    recertification: { phase: "R65 production dispatch and Domain B", reason, changedFiles, priorSourceStateId, guarded: true } });
  doc.recertifications.push({ label: "R65 production dispatch and Free authorization", reason, priorSourceStateId, priorSurfaceVersion,
    resultingSourceStateId: sourceStateId, resultingSurfaceVersion: doc.surfaceVersion, recertifiedAt: doc.recertifiedAt,
    changedFiles: changedFiles.map((file) => ({ file, addedToMaterialFiles: additions.includes(file) })), regressionEvidence: "docs/evidence/free-capacity-fabric/R65-REPOSITORY-TESTS.json" });
  await writeFile(path, `${JSON.stringify(doc, null, 2)}\n`);
}
console.log(JSON.stringify({ surfaceVersion: doc.surfaceVersion, sourceStateId }));
