// R23 recertification of the ForgeGreen certified source state.
//
// The R23 continuation changed one material file, packages/server/src/agent-runtime.ts, for
// provider-failure handling on the autonomous path. None of the changes touch ForgeGreen
// optimization candidates, the verification-evidence-reuse advisor, the FG-12F cost gate, or
// ForgeVerify validity authority. Prior campaign evidence remains historically accurate for its
// recorded source state; this entry records the reviewed drift rather than rewriting it.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const docPath = path.join(repoRoot, "docs", "codeforge-forgegreen-certified-source-state.json");
const doc = JSON.parse(fs.readFileSync(docPath, "utf8"));

const materialFiles = [...doc.materialFiles].sort((a, b) => a.localeCompare(b));
const entries = materialFiles.map((file) => ({ path: file, blobHash: execFileSync("git", ["hash-object", file], { cwd: repoRoot, encoding: "utf8" }).trim() }));
const sourceStateId = createHash("sha256").update(JSON.stringify(entries.map((e) => [e.path, e.blobHash]))).digest("hex");
const hashes = Object.fromEntries(entries.map((e) => [e.path, e.blobHash]));

const changed = materialFiles.filter((file) => doc.materialFileHashes[file] !== hashes[file]);
if (changed.length === 0) {
  console.log("source state already matches; nothing to recertify");
  process.exit(0);
}

const expectedChangedFiles = ["packages/server/src/agent-runtime.ts"];
if (changed.length !== expectedChangedFiles.length || changed.some((file) => !expectedChangedFiles.includes(file))) {
  throw new Error(`Unexpected certified-source drift; refusing recertification: ${changed.join(", ")}`);
}

const priorId = doc.sourceStateId;
const priorSurfaceVersion = doc.surfaceVersion;
const resultingSurfaceVersion = "r23-pinned-route-recovery-v1";

const changeNotes = {
  "packages/server/src/agent-runtime.ts":
    "Four reviewed changes on the provider-failure path, none in ForgeGreen policy or ForgeVerify authority: (1) executeAgentRun builds its ModelExecutionAdapter with the runtime's explicitly injected capacity governor instead of always the module singleton, so injected pacing (the R23 harness proxy, per-runtime configuration) is honoured and measured; (2) a pinned (explicit) model selection now consults 8-Bit with pinMode 'route' on a model-turn failure and honours bounded same-route retries (PINNED_ROUTE_MAX_SAME_ROUTE_RETRIES = 3 per turn, 8-Bit's consecutive-failure streak across turns) — rotation remains refused; previously every failure on a pinned route ended the child run outright; (3) a provider-rejected tool call (INVALID_TOOL_OUTPUT) is recorded in 8-Bit's tool-reliability ledger, the same ledger the locally-detected malformed-argument path feeds; (4) the production tool schemas are exported as agentToolDefinitions()/repositoryToolDefinitions() and the private builders delegate to them (no behavioural change) so production-shaped probes exercise the real request shape. Completion gate, ForgeVerify dispatch, verification-evidence reuse, ForgeGreen ledger persistence and the FG-12F cost gate are untouched.",
};

doc.recertifications.push({
  label: "R23 pinned-route recovery and governor injection",
  reason:
    "The R23 free-supply campaign found that the autonomous path had no per-turn fault tolerance for pinned routes and bypassed an injected capacity governor; both are corrected in agent-runtime.ts. ForgeGreen optimization candidates, the verification-evidence-reuse advisor, the FG-12F cost gate and ForgeVerify validity authority are unchanged; prior campaign evidence remains historically accurate for its recorded source state. This entry records the reviewed drift rather than rewriting historical evidence.",
  priorSourceStateId: priorId,
  priorSurfaceVersion,
  resultingSourceStateId: sourceStateId,
  resultingSurfaceVersion,
  changes: changed.map((file) => ({ file, change: changeNotes[file], addedToMaterialFiles: false })),
  regressionEvidence:
    "Canonical vitest suite on 2026-09-21 (commit 3424a67): 426 files / 3 365 tests passed, 47 skipped, and exactly these two source-state guards failing on the pre-recertification fingerprint; providers (203), eight-bit, forgegreen-campaign R23 goldens and the server failover/security suites pass; security gate PASS (secret scan, dependency audit 0 high/critical, public claims, doc links).",
  recertifiedAt: new Date().toISOString().slice(0, 10),
  sourceStateConstant: "CODEFORGE_R23_PINNED_ROUTE_RECOVERY_SOURCE_STATE",
});

doc.sourceStateId = sourceStateId;
doc.surfaceVersion = resultingSurfaceVersion;
doc.materialFileHashes = hashes;
doc.generationNote = `${doc.generationNote.replace(/\.$/, "")}, and the R23 pinned-route recovery and governor injection above.`;
fs.writeFileSync(docPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
console.log(`recertified ${changed.length} changed material file(s): ${changed.join(", ")}`);
console.log(`prior=${priorId}\nnew  =${sourceStateId}`);
