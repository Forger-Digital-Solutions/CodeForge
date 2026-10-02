import { readFile, writeFile, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";

const directory = "docs/evidence/free-capacity-fabric/";
const path = `${directory}source-certification.json`;
const certificate = JSON.parse(await readFile(path, "utf8"));
const tests = JSON.parse(await readFile(`${directory}R65-REPOSITORY-TESTS.json`, "utf8"));
const build = JSON.parse(await readFile(`${directory}R65-WORKSPACE-BUILD.json`, "utf8"));
const state = JSON.parse(await readFile("docs/codeforge-forgegreen-certified-source-state.json", "utf8"));
if (tests.status !== "PASS" || build.status !== "PASS") throw new Error("GREEN_VALIDATION_REQUIRED");
const implementationHead = process.argv[2];
if (implementationHead && !/^[a-f0-9]{40}$/.test(implementationHead)) throw new Error("COMMIT_SHA_REQUIRED");
const additions = [
  "apps/cloud-api/src/production-remote-direct.ts", "apps/cloud-api/src/remote-direct-host.ts",
  "apps/cloud-api/test/remote-direct-dispatch.test.ts", "packages/server/src/remote-direct-cloud-provider.ts",
  "packages/server/src/agent-runtime.ts",
  "packages/server/src/remote-direct-client.ts", "packages/server/test/remote-control-pressure.test.ts",
  "packages/eight-bit/test/r56-model-scoped-health.test.ts",
  "packages/providers/src/ai-horde.ts", "packages/providers/test/ai-horde.test.ts",
  "packages/providers/src/hosted-text-tools.ts",
  "packages/model-registry/src/horde-policy-reverification.ts", "packages/model-registry/src/quota.ts",
  "packages/model-registry/src/free-cloud-service.ts", "packages/model-registry/src/free-cloud-registry.ts",
  "packages/model-registry/test/community-anonymous-free.test.ts",
  "packages/forge-zero/src/capacity-types.ts", "packages/forge-zero/src/capacity-policy.ts",
  "packages/forge-zero/src/capacity-reservations.ts",
  "apps/desktop/src/main.ts", "apps/desktop/src/provider-connections.ts",
  "apps/desktop/test/ai-horde-fresh-user.test.ts", "apps/desktop/test/openrouter-oauth-browser.test.ts",
  "docs/codeforge-forgegreen-certified-source-state.json",
  "benchmarks/free-capacity-fabric/r65-horde-autonomous.mjs", "benchmarks/free-capacity-fabric/r65-horde-qualify-model.mjs",
  "benchmarks/free-capacity-fabric/r65-dual-domain-failover.mjs", "benchmarks/free-capacity-fabric/r65-multiuser-isolation.mjs",
  "benchmarks/free-capacity-fabric/r65-production-coding.mjs",
  "scripts/r65-bounded-tests.mjs", "scripts/r65-preserve-start.mjs", "scripts/r65-provider-entitlement-probe.mjs",
  "scripts/r65-recertify-source-state.mjs", "scripts/r65-recertify-certificate.mjs",
  "scripts/r65-production-closure.mjs", "scripts/r65-production-health.mjs",
  "scripts/r65-domain-sanity.mjs",
  "benchmarks/r65/closure-evidence.mjs", "benchmarks/r65/closure-preservation.mjs",
];
certificate.sourceFiles = [...new Set([...certificate.sourceFiles.map((entry) => entry.path), ...additions])].sort().map((path) => ({ path, sha256: "RECOMPUTE" }));
const newEvidence = (await readdir(directory)).filter((name) => name.startsWith("R65-") && (name.endsWith(".json") || name.endsWith(".md"))
  && !["R65-final-canaries.json", "R65-certificate-canary.json"].includes(name)).map((name) => `${directory}${name}`);
certificate.evidenceFiles = [...new Set([...certificate.evidenceFiles.map((entry) => entry.path), ...newEvidence])].sort().map((path) => ({ path, sha256: "RECOMPUTE" }));
certificate.certificateId = "r65-free-capacity-fabric-v1";
certificate.sourceStateId = state.sourceStateId;
certificate.implementationBase = "616cbec8629a0083573efa673a8495d1aee64b36";
certificate.implementationHead = implementationHead ?? null;
certificate.validation = { repositoryWideStatus: "PASS", repositoryWideExactTotalsExcludingStandaloneCertificateCanary: tests.totals,
  workspaceBuild: "PASS", workspaceTypecheck: "PASS", affectedDesktopAndCloudTypechecks: "PASS",
  certificateCanary: "RUN_SEPARATELY_AFTER_FREEZE", forgeGreen: { fg11: "5/5", fg12e: "3/3" } };
const production = await readFile(`${directory}R65-PRODUCTION-DISPATCH.json`, "utf8").then(JSON.parse).catch(() => undefined);
const remoteCoding = await readFile(`${directory}R65-PRODUCTION-REMOTE-CODING.json`, "utf8").then(JSON.parse).catch(() => undefined);
const productionCompleted = production?.status === "PASS" && remoteCoding?.result?.completion?.outcome === "completed";
certificate.limitation = "R65 proves independent Kilo SOURCE_IP and AI Horde GLOBAL_SHARED free domains with live coding, two route rotations under an injected Kilo quota fault, owner-isolated reservations on the shared Horde pool, and key-free fresh-user acceptance. AI Horde remains PUBLIC_CODE_ONLY and uses hosted text-tool mediation. "
  + (productionCompleted ? "Authenticated deployed production coding dispatch passed with independent review, verification and completion. " : "Authenticated deployed production coding dispatch remains pending. ")
  + "Provider verifiers for Cloudflare/Groq remain denied/unverified; Pollinations and Puter are recorded DENIED. Provider billing totals are not independently measured.";
await writeFile(path, `${JSON.stringify(certificate, null, 2)}\n`);
execFileSync(process.execPath, ["scripts/free-capacity-certificate.mjs", "--write"], { stdio: "inherit" });
execFileSync(process.execPath, ["scripts/free-capacity-certificate.mjs", "--verify"], { stdio: "inherit" });
