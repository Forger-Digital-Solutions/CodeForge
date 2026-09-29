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
const orchestrator = extractFile(archive, "node_modules\\@codeforge\\server\\dist\\autonomous-orchestrator.js").toString("utf8");
const worker = extractFile(archive, "node_modules\\@codeforge\\server\\dist\\subagent-manager.js").toString("utf8");
const identity = JSON.parse(extractFile(archive, "apps\\desktop\\dist\\build-identity.json").toString("utf8"));
const certificate = JSON.parse(readFileSync(path.join(root, "docs/codeforge-forgegreen-certified-source-state.json"), "utf8"));

assert.match(main, /useRealRuntime: true,\s+subagentsR1Enabled: true/);
assert.match(server, /process\.env\.CODEFORGE_SUBAGENTS_R1 !== "false"/);
assert.match(orchestrator, /AUTONOMOUS_EXECUTOR_UNAVAILABLE: no coder executor was configured/);
assert.match(worker, /AUTONOMOUS_EXECUTOR_UNAVAILABLE: R1 worker has no agent runtime/);
assert.match(worker, /countUsefulProgress/);
assert.equal(certificate.materialFiles.length, 68);

const receipt = {
  schema: "r58-packaged-wiring/v1",
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
    legacyCoderStubFailsClosed: true,
    missingR1RuntimeFailsClosed: true,
    usefulProgressClassifierPackaged: true,
  },
};
const output = path.join(root, "docs/evidence/r58-progress-aware-autonomy/production-wiring.json");
mkdirSync(path.dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify({ output, status: receipt.status, buildCommit: identity.commit, sourceStateId: certificate.sourceStateId }));
