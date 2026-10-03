import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { CAMPAIGN_HARNESS_FILES, FG12E_BENCHMARK_HARNESS_FILES } from '@codeforge/forgegreen-campaign';
const path = "docs/codeforge-forgegreen-certified-source-state.json";
const doc = JSON.parse(await readFile(path, "utf8"));
const start = JSON.parse(await readFile("docs/evidence/r67-everyday-completion-reliability/R67-START-STATE.json", "utf8"));
const preserved = new Set(start.preservedFiles.map((entry) => entry.path));
const harness = new Set([...CAMPAIGN_HARNESS_FILES, ...FG12E_BENCHMARK_HARNESS_FILES,
  'packages/forgegreen-campaign/test/fg11-source-state.test.ts']);
const diff = execFileSync("git", ["diff", "--name-only"], { encoding: "utf8" }).trim().split(/\r?\n/);
const additions = [...diff.filter((file) => /^(packages|apps)\//.test(file) && !preserved.has(file) && !harness.has(file)),
  "packages/server/test/autonomous-parent-recovery.test.ts",
  "packages/server/test/autonomous-new-file.test.ts",
  "packages/terminal/test/conpty-teardown.test.ts",
  "packages/terminal/test/fixtures/conpty-reader-close.mjs",
  "packages/terminal/test/fixtures/conpty-close-worker.mjs",
  "apps/cloud-api/src/production-remote-direct.ts", "packages/server/src/remote-direct-cloud-provider.ts", "apps/cloud-api/test/remote-direct-dispatch.test.ts",
  "packages/server/test/remote-control-pressure.test.ts"];
const materialFiles = [...new Set([...doc.materialFiles, ...additions])].sort((a, b) => a.localeCompare(b));
const entries = materialFiles.map((path) => ({ path, blobHash: execFileSync("git", ["hash-object", path], { encoding: "utf8" }).trim() }));
const sourceStateId = createHash("sha256").update(JSON.stringify(entries.map(({ path, blobHash }) => [path, blobHash]))).digest("hex");
if (sourceStateId !== doc.sourceStateId) {
  const changedFiles = entries.filter(({ path, blobHash }) => doc.materialFileHashes[path] !== blobHash).map(({ path }) => path);
  const reason = "R67 distinguishes structured JSON quality from malformed tools, accepts fully validated structured JSON at the output cap, requires role requalification after independent live failures, preserves authoritative denial facts, and recovers parent stages through durable worker results and worktrees. Completion authority, privacy, call limits and qualification floors are unchanged.";
  const priorSourceStateId = doc.sourceStateId;
  const priorSurfaceVersion = doc.surfaceVersion;
  Object.assign(doc, { sourceStateId, surfaceVersion: "r67-everyday-completion-reliability-v1", materialFiles,
    materialFileHashes: Object.fromEntries(entries.map(({ path, blobHash }) => [path, blobHash])), recertifiedAt: "2026-10-03",
    recertification: { phase: "R67 role-scoped quality and durable parent recovery", reason, changedFiles, priorSourceStateId, guarded: true } });
  doc.recertifications.push({ label: "R67 completion reliability", reason, priorSourceStateId, priorSurfaceVersion,
    resultingSourceStateId: sourceStateId, resultingSurfaceVersion: doc.surfaceVersion, recertifiedAt: doc.recertifiedAt,
    changedFiles: changedFiles.map((file) => ({ file, addedToMaterialFiles: additions.includes(file) })), regressionEvidence: "docs/evidence/r67-everyday-completion-reliability/R67-REPOSITORY-TESTS.json" });
  await writeFile(path, `${JSON.stringify(doc, null, 2)}\n`);
}
console.log(JSON.stringify({ surfaceVersion: doc.surfaceVersion, sourceStateId }));
