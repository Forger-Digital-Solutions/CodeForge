import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

const path = "docs/codeforge-forgegreen-certified-source-state.json";
const doc = JSON.parse(await readFile(path, "utf8"));
const additions = [
  "packages/server/tsconfig.json", "Dockerfile.cloud",
  "apps/cloud-api/src/deployment-identity.ts", "apps/cloud-api/src/server.ts", "apps/cloud-api/test/deployment-identity.test.ts",
  "apps/cloud-api/test/remote-direct-http.test.ts", "apps/desktop/src/provider-connections.ts", "apps/desktop/src/provider-connection-types.ts",
  "apps/desktop/src/renderer/settings/sections/FreeCapacitySection.tsx", "apps/desktop/src/renderer/settings/settings-registry.tsx",
  "apps/desktop/test/free-capacity-settings.test.tsx", "apps/desktop/test/provider-connections.test.ts", "apps/desktop/test/settings-registry.test.tsx",
];
const materialFiles = [...new Set([...doc.materialFiles, ...additions])].sort((a, b) => a.localeCompare(b));
const entries = materialFiles.map((path) => ({ path, blobHash: execFileSync("git", ["hash-object", path], { encoding: "utf8" }).trim() }));
const sourceStateId = createHash("sha256").update(JSON.stringify(entries.map(({ path, blobHash }) => [path, blobHash]))).digest("hex");
const changedFiles = entries.filter(({ path, blobHash }) => doc.materialFileHashes[path] !== blobHash).map(({ path }) => path);
if (sourceStateId !== doc.sourceStateId) {
  const priorSourceStateId = doc.sourceStateId;
  const priorSurfaceVersion = doc.surfaceVersion;
  const reason = "R64 adds a dedicated Free Capacity authorization screen backed by Fabric admission, safe rejected-account status, owner-scoped metrics, default hosted-workflow authorization for remote session scope and validated Render revision provenance. It also corrects server project references so clean Docker builds compile cloud usage, browser, computer use and MCP declarations before the server. No Free eligibility, privacy, billing, role qualification, verification or completion policy is relaxed. Production dispatch remains denied unless a Fabric admission authority is configured; its absence is exposed in health metadata.";
  Object.assign(doc, { sourceStateId, surfaceVersion: "r64-free-capacity-fabric-v1", materialFiles,
    materialFileHashes: Object.fromEntries(entries.map(({ path, blobHash }) => [path, blobHash])), recertifiedAt: new Date().toISOString().slice(0, 10),
    recertification: { phase: "R64 external entitlement acquisition", reason, changedFiles, priorSourceStateId, guarded: true } });
  doc.recertifications.push({ label: "R64 Free connection and production provenance", reason, priorSourceStateId, priorSurfaceVersion,
    resultingSourceStateId: sourceStateId, resultingSurfaceVersion: doc.surfaceVersion, recertifiedAt: doc.recertifiedAt,
    changedFiles: changedFiles.map((file) => ({ file, addedToMaterialFiles: additions.includes(file) })), regressionEvidence: "docs/evidence/free-capacity-fabric/R64-REPOSITORY-TESTS.json" });
  await writeFile(path, `${JSON.stringify(doc, null, 2)}\n`);
}
console.log(JSON.stringify({ surfaceVersion: doc.surfaceVersion, sourceStateId, changedFiles }));
