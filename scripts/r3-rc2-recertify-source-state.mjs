// CodeForge Managed-Free R3-RC2 recertification of the ForgeGreen certified source state.
//
// This phase changed one material file. packages/server/src/autonomous-orchestrator.ts replaced
// the R1 replan-only crash reconciliation with journal-based worker recovery: workers with a
// resume-safe durable execution journal are genuinely resumed, the rest converge honestly to
// failed (RECOVERY_REPLAN / RECOVERY_FAIL), and stale crash-window tool records are converged to
// cancelled so no later recovery mistakes them for live work.
//
// Neither touches ForgeGreen optimization candidates, the verification-evidence-reuse advisor,
// the FG-12F cost gate, or ForgeVerify validity authority. Prior campaign evidence remains
// historically accurate for the source state it recorded.
//
// Guarded: any other material drift aborts without writing. Hashes are computed, never hand-edited.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const docPath = path.join(repoRoot, "docs", "codeforge-forgegreen-certified-source-state.json");
const doc = JSON.parse(fs.readFileSync(docPath, "utf8"));

const materialFiles = [...doc.materialFiles].sort((a, b) => a.localeCompare(b));
const entries = materialFiles.map((file) => ({
  path: file,
  blobHash: execFileSync("git", ["hash-object", file], { cwd: repoRoot, encoding: "utf8" }).trim(),
}));
const sourceStateId = createHash("sha256")
  .update(JSON.stringify(entries.map((e) => [e.path, e.blobHash])))
  .digest("hex");
const hashes = Object.fromEntries(entries.map((e) => [e.path, e.blobHash]));

const changed = materialFiles.filter((file) => doc.materialFileHashes[file] !== hashes[file]);
if (changed.length === 0) {
  console.log("source state already matches; nothing to recertify");
  process.exit(0);
}

const expectedChangedFiles = [
  "packages/server/src/autonomous-orchestrator.ts",
];
if (changed.some((file) => !expectedChangedFiles.includes(file))) {
  throw new Error(`Unexpected certified-source drift; refusing recertification: ${changed.join(", ")}`);
}

const priorId = doc.sourceStateId;
const priorSurfaceVersion = doc.surfaceVersion;
const next = {
  ...doc,
  sourceStateId,
  materialFileHashes: hashes,
  surfaceVersion: (typeof priorSurfaceVersion === "number" ? priorSurfaceVersion : 0) + 1,
  recertifiedAt: new Date().toISOString(),
  recertification: {
    phase: "R3-RC2",
    reason: "Managed-Free R3-RC2 runtime hardening changed one material file",
    changedFiles: changed.map((file) => ({
      path: file,
      summary: "Replaced replan-only crash reconciliation with journal-based worker recovery (resume-safe journals resumed; others converge honestly; stale crash-window tool records converged to cancelled)",
    })),
    priorSourceStateId: priorId,
    guarded: true,
  },
};

fs.writeFileSync(docPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
console.log(`recertified: ${changed.join(", ")}`);
console.log(`sourceStateId: ${sourceStateId}`);
