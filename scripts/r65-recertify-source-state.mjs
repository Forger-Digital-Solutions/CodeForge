import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
const path = "docs/codeforge-forgegreen-certified-source-state.json";
const doc = JSON.parse(await readFile(path, "utf8"));
const start = JSON.parse(await readFile("docs/evidence/free-capacity-fabric/R65-START-STATE.json", "utf8"));
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
  const reason = "R65 production acceptance exposed control-plane request-budget exhaustion: 250ms status polling and redundant idle heartbeats exceeded the shared 120-request minute. Status reads now use two-second intervals and idle heartbeats honor their existing five-second period. A deterministic shared-budget regression test preserves polling and lease renewal without HTTP 429. The existing R56 daily-reset test now fixes its Date clock at UTC noon so its unchanged one-hour assertion remains valid near midnight. Provider eligibility, privacy, role qualification, verification and completion gates are unchanged.";
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
