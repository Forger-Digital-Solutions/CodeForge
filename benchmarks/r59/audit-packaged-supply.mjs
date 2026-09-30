#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractFile } from "@electron/asar";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const exe = path.join(root, "apps/desktop/release/win-unpacked/CodeForge.exe");
const archive = path.join(root, "apps/desktop/release/win-unpacked/resources/app.asar");
const main = extractFile(archive, "apps\\desktop\\dist\\main.js").toString("utf8");
const server = extractFile(archive, "node_modules\\@codeforge\\server\\dist\\index.js").toString("utf8");
const runtime = extractFile(archive, "node_modules\\@codeforge\\server\\dist\\agent-runtime.js").toString("utf8");
const service = extractFile(archive, "node_modules\\@codeforge\\model-registry\\dist\\free-cloud-service.js").toString("utf8");
const discovery = extractFile(archive, "node_modules\\@codeforge\\model-registry\\dist\\discovery.js").toString("utf8");
const refresh = extractFile(archive, "node_modules\\@codeforge\\model-registry\\dist\\catalog-refresh.js").toString("utf8");
const fabric = extractFile(archive, "node_modules\\@codeforge\\eight-bit\\dist\\free-fabric.js").toString("utf8");
const ledger = extractFile(archive, "node_modules\\@codeforge\\eight-bit\\dist\\route-ledger.js").toString("utf8");
const compact = extractFile(archive, "node_modules\\@codeforge\\eight-bit\\dist\\qualification\\compact.js").toString("utf8");
const roleSuite = extractFile(archive, "node_modules\\@codeforge\\eight-bit\\dist\\qualification\\role-suite.js").toString("utf8");
const definitions = extractFile(archive, "node_modules\\@codeforge\\model-registry\\dist\\provider-definitions.js").toString("utf8");
const identity = JSON.parse(extractFile(archive, "apps\\desktop\\dist\\build-identity.json").toString("utf8"));
const certificate = JSON.parse(readFileSync(path.join(root, "docs/codeforge-forgegreen-certified-source-state.json"), "utf8"));

// R58 invariants still hold — R59 must not regress the real-runtime wiring.
assert.match(main, /useRealRuntime: true,\s+subagentsR1Enabled: true/);
assert.match(server, /process\.env\.CODEFORGE_SUBAGENTS_R1 !== "false"/);

// R59 supply-recovery surface present in the packaged bundle. cloud-gateway is hosted
// (apps/cloud-api only) and never enters this artifact, so it is audited at source level.
assert.match(server, /\/api\/free-cloud\/supply/);
assert.match(runtime, /measuring verified-free routes/);
assert.match(service, /qualificationSummary/);
assert.match(service, /recoveryAttempts/);
assert.match(discovery, /catalogPruneKeepSet/);
assert.match(discovery, /probeRevoked/);
assert.match(refresh, /probeRevoked/);
assert.match(fabric, /nextAvailableAt/);
assert.match(ledger, /healthGate/);
assert.match(main, /rediscoverProviderFree/);
assert.match(main, /discoveryInflight/);
// R59 v2 qualification-starvation surface: provider lanes, suite deadline, bounded probes.
assert.match(service, /qualificationProviderConcurrency/);
assert.match(service, /qualificationSuiteDeadlineMs/);
assert.match(service, /capacityProbeTimeoutMs/);
assert.match(compact, /suite deadline elapsed/);
assert.match(roleSuite, /suite deadline elapsed/);
// R59 v4 probe pacing surface: declared-RPM spacing shared by suites and capacity probes.
assert.match(service, /probeMinIntervalMs/);
assert.match(service, /paceProviderAdapter/);
assert.match(definitions, /maxRequestsPerMinute/);
assert.equal(certificate.materialFiles.length, 78);
assert.equal(certificate.surfaceVersion, "r59-free-supply-recovery-v4");

const receipt = {
  schema: "r59-packaged-supply-recovery/v1",
  status: "PASS",
  artifact: {
    exeSha256: createHash("sha256").update(readFileSync(exe)).digest("hex"),
    buildCommit: identity.commit,
    buildDirty: identity.dirty,
    builtAt: identity.builtAt,
  },
  sourceStateId: certificate.sourceStateId,
  assertions: {
    desktopExplicitR1: true,
    serverDefaultsR1: true,
    supplyExclusionLedgerEndpoint: true,
    denialTimeRecovery: true,
    qualificationRecoveryScheduler: true,
    transientProbeKeepSet: true,
    revocationClassification: true,
    fabricNextAvailableAt: true,
    discoveryInflightJoin: true,
    qualificationProviderLanes: true,
    qualificationSuiteDeadline: true,
    boundedCapacityProbe: true,
    probePacing: true,
  },
};
const output = path.join(root, "docs/evidence/r59-supply-recovery/production-wiring.json");
mkdirSync(path.dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify({ output, status: receipt.status, buildCommit: identity.commit, sourceStateId: certificate.sourceStateId }));
