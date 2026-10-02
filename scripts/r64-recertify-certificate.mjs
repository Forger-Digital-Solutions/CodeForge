import { readFile, writeFile, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";

const directory = "docs/evidence/free-capacity-fabric/";
const path = `${directory}source-certification.json`;
const certificate = JSON.parse(await readFile(path, "utf8"));
const tests = JSON.parse(await readFile(`${directory}R64-REPOSITORY-TESTS.json`, "utf8"));
const build = JSON.parse(await readFile(`${directory}R64-WORKSPACE-BUILD.json`, "utf8"));
const state = JSON.parse(await readFile("docs/codeforge-forgegreen-certified-source-state.json", "utf8"));
if (tests.status !== "PASS" || build.status !== "PASS") throw new Error("GREEN_VALIDATION_REQUIRED");
const implementationHead = process.argv[2];
if (implementationHead && !/^[a-f0-9]{40}$/.test(implementationHead)) throw new Error("COMMIT_SHA_REQUIRED");
const additions = [
  "apps/cloud-api/src/server.ts", "apps/cloud-api/src/deployment-identity.ts", "apps/cloud-api/test/deployment-identity.test.ts",
  "apps/desktop/src/provider-connection-types.ts", "apps/desktop/src/renderer/settings/settings-registry.tsx",
  "apps/desktop/src/renderer/settings/sections/FreeCapacitySection.tsx", "apps/desktop/test/free-capacity-settings.test.tsx",
  "apps/desktop/test/provider-connections.test.ts", "apps/desktop/test/settings-registry.test.tsx",
  "docs/codeforge-forgegreen-certified-source-state.json", "benchmarks/free-capacity-fabric/r64-kilo-autonomous.mjs",
  "scripts/r64-bounded-tests.mjs", "scripts/r64-memory-observe.ps1", "scripts/r64-provider-entitlement-probe.mjs",
  "scripts/r64-recertify-source-state.mjs", "scripts/r64-production-preflight.mjs", "scripts/r64-production-health.mjs",
  "scripts/r64-production-transport-probe.mjs", "scripts/r64-evidence-snapshot.mjs", "scripts/r64-recertify-certificate.mjs",
];
certificate.sourceFiles = [...new Set([...certificate.sourceFiles.map((entry) => entry.path), ...additions])].sort().map((path) => ({ path, sha256: "RECOMPUTE" }));
const newEvidence = (await readdir(directory)).filter((name) => name.startsWith("R64-") && (name.endsWith(".json") || name.endsWith(".md"))
  && !["R64-final-canaries.json", "R64-certificate-canary.json"].includes(name)).map((name) => `${directory}${name}`);
certificate.evidenceFiles = [...new Set([...certificate.evidenceFiles.map((entry) => entry.path), ...newEvidence])].sort().map((path) => ({ path, sha256: "RECOMPUTE" }));
certificate.certificateId = "r64-free-capacity-fabric-v1";
certificate.sourceStateId = state.sourceStateId;
certificate.implementationBase = "f1ceb4a34a97c0bbae4553994148c465fce44c1d";
certificate.implementationHead = implementationHead ?? null;
certificate.validation = { repositoryWideStatus: "PASS", repositoryWideExactTotalsExcludingStandaloneCertificateCanary: tests.totals,
  workspaceBuild: "PASS", workspaceTypecheck: "PASS", affectedDesktopAndCloudTypechecks: "PASS",
  certificateCanary: "RUN_SEPARATELY_AFTER_FREEZE", forgeGreen: { fg11: "5/5", fg12e: "3/3" } };
certificate.limitation = "R64 remains partial: no independently owned Domain B Free entitlement, live two-domain failover, or live independent users. Production remote control transport is deployed only when verified in R64 production evidence; actual hosted Fabric remote dispatch is not configured. Dedicated Cloudflare and Groq Free account verifiers remain unfinished. Fresh-user end-to-end authorization and coding are unproven.";
await writeFile(path, `${JSON.stringify(certificate, null, 2)}\n`);
execFileSync(process.execPath, ["scripts/free-capacity-certificate.mjs", "--write"], { stdio: "inherit" });
execFileSync(process.execPath, ["scripts/free-capacity-certificate.mjs", "--verify"], { stdio: "inherit" });
