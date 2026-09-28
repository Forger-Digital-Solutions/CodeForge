#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const documentPath = path.join(root, "docs/codeforge-forgegreen-certified-source-state.json");
const document = JSON.parse(fs.readFileSync(documentPath, "utf8"));
const priorId = "f24481030f350a69de885b9b73f8394adb50b4c23bfc47067a3754c5be2fce19";
const priorVersion = "r51-capacity-closure-v1";
const changes = [
  { file: "packages/model-registry/src/free-cloud-service.ts", change: "R52: probe storm control — in-flight coalescing map for probeRouteCapacity so N concurrent demands on the same unmeasured quota domain measure it once, never N times; the entry is removed on completion including failure paths, so a failed probe can never poison the domain. Existing 60s per-domain cooldown and the runtime's ≤4-candidates-per-decision bound are unchanged." },
  { file: "packages/eight-bit/src/free-fabric.ts", change: "R52: capacity observability truth — unreached candidates whose effective quota windows are empty now report CAPACITY_UNMEASURED instead of generic STANDBY, mirroring the reservation ledger's pool-wins rule and keeping measureUnmeasuredFreeCapacity honest about which domains were never measured; HEALTH_EXCLUDED reports now carry capacityPoolId like every other candidate report. Admission semantics, quota windows, fairness, and paid/free isolation unchanged." },
];

if (document.sourceStateId !== priorId || document.surfaceVersion !== priorVersion) {
  throw new Error("R52 recertification refused: predecessor identity changed.");
}
const files = [...document.materialFiles].sort((a, b) => a.localeCompare(b));
if (new Set(files).size !== files.length) throw new Error("R52 recertification refused: duplicate material file.");
const entries = files.map((file) => ({
  path: file,
  blobHash: execFileSync("git", ["hash-object", file], { cwd: root, encoding: "utf8" }).trim(),
}));
const changed = entries.filter((entry) => document.materialFileHashes?.[entry.path] !== entry.blobHash).map((entry) => entry.path);
// R52's reviewed production changes live outside the certified material surface; the
// drift check covers material files only while the entry records every reviewed file.
const expected = changes.filter((entry) => document.materialFiles.includes(entry.file)).map((entry) => entry.file).sort((a, b) => a.localeCompare(b));
if (JSON.stringify(changed) !== JSON.stringify(expected)) {
  throw new Error(`R52 recertification refused: unreviewed source drift ${JSON.stringify(changed)}.`);
}
const dirty = execFileSync("git", ["status", "--porcelain", "--", ...files], { cwd: root, encoding: "utf8" }).trim();
if (dirty) throw new Error(`R52 recertification refused: uncommitted material source ${dirty}`);

const sourceStateId = createHash("sha256").update(JSON.stringify(entries.map((entry) => [entry.path, entry.blobHash]))).digest("hex");
const version = "r52-production-scale-v1";
const reason = "Recertify the reviewed R52 changes: capacity measurement is storm-controlled (in-flight coalescing + domain cooldown + bounded per-decision probes), unreached unmeasured candidates report CAPACITY_UNMEASURED truthfully rather than STANDBY, and health-excluded reports carry pool identity. Live inventory proves three verified usable free domains (groq, mistral, openrouter — 18 independent pools); Cloudflare Workers AI stays fail-closed on blocked telemetry; stale qualification receipts reopen measurement instead of quarantining; restart re-measures quota on demand. Completion gate, paid/free isolation, reviewer independence semantics, and fairness are unchanged.";
const entry = {
  label: "R52 production-scale closure: honest inventory, storm-controlled measurement, no false waiting",
  reason,
  priorSourceStateId: priorId,
  priorSurfaceVersion: priorVersion,
  resultingSourceStateId: sourceStateId,
  resultingSurfaceVersion: version,
  changes: changes.map((change) => ({ ...change, addedToMaterialFiles: false })),
  regressionEvidence: "docs/evidence/r52-production-scale/R52-FINAL-REPORT.md; live inventory 64 models / 244 routes / 142 pools / 3 verified usable free domains; five live $0 missions through the production stack — 4 completed (unmeasured-demand-recovery, provider-outage absorbed at admission, reviewer-scarcity demand-probe recovery, multi-step with two real mid-run failovers and 4/4 post-integration tests) and 1 honest block (reviewer turn-budget exhaustion on nemotron — gate refused completion); seeded long-horizon simulation 4,796 decisions / 41 users / 0 invariant violations / 0 starvation / 0 leaked leases; model-registry 145, eight-bit 347/2sk (8 no-false-waiting scenarios + 7 multi-user fairness), server 902/3sk with the two R51 baseline failures now fixed (stale fixtures, not relaxed gates), paid-auto 71, cloud-billing 3, full monorepo build clean; Cloudflare Workers AI re-probed on the exact production analytics queries — still unauthorized on the env token, guard correctly stays fail-closed",
  recertifiedAt: new Date().toISOString().slice(0, 10),
  sourceStateConstant: "CODEFORGE_R52_PRODUCTION_SCALE_SOURCE_STATE",
};
document.sourceStateId = sourceStateId;
document.surfaceVersion = version;
document.materialFileHashes = Object.fromEntries(entries.map((entry) => [entry.path, entry.blobHash]));
document.recertifications.push(entry);
document.recertifiedAt = new Date().toISOString();
document.recertification = {
  phase: entry.label,
  reason,
  changedFiles: changed,
  priorSourceStateId: priorId,
  guarded: true,
};
fs.writeFileSync(documentPath, JSON.stringify(document, null, 2) + "\n");
console.log(`recertified -> ${version} (${sourceStateId.slice(0, 12)}…)`);
console.log("changed:", JSON.stringify(changed));
