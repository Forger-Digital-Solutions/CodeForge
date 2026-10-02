import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import ts from "typescript";

const previousRevision = "1b34b4bbda4bf7904c09cbd72c3c546013d93c3d";
const sourcePath = "packages/cloud-db/src/migrations.ts";
async function migrations(source) {
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`)).MIGRATIONS;
}
const old = await migrations(execFileSync("git", ["show", `${previousRevision}:${sourcePath}`], { encoding: "utf8" }));
const current = await migrations(await readFile(sourcePath, "utf8"));
const compatibility = old.map((entry) => ({ version: entry.version, sameChecksum: current.find((item) => item.version === entry.version)?.checksum === entry.checksum }));
const endpoints = [];
for (const path of ["/health/live", "/health/ready", "/v1/remote-direct/sessions"]) {
  const response = await fetch(`https://codeforge-cloud-va.onrender.com${path}`, { signal: AbortSignal.timeout(30000),
    ...(path.includes("sessions") ? { method: "POST", headers: { "content-type": "application/json" }, body: "{}" } : {}) });
  endpoints.push({ path, httpStatus: response.status, body: await response.json() });
}
await writeFile("docs/evidence/free-capacity-fabric/R64-PRODUCTION-PREFLIGHT.json", `${JSON.stringify({ observedAt: new Date().toISOString(), previousRevision,
  build: "Dockerfile.cloud", start: "Dockerfile CMD apps/cloud-api/dist/index.js", autoDeploy: false,
  migrationCompatibility: compatibility, incompatible: compatibility.filter((entry) => !entry.sameChecksum),
  addedMigrationVersions: current.filter((entry) => !old.some((item) => item.version === entry.version)).map((entry) => entry.version), endpoints }, null, 2)}\n`);
console.log(JSON.stringify({ migrationCompatible: compatibility.every((entry) => entry.sameChecksum), addedMigrations: current.length - old.length,
  endpoints: endpoints.map(({ path, httpStatus }) => ({ path, httpStatus })) }));
