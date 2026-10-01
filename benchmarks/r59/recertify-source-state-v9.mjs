#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const documentPath = path.join(root, "docs/codeforge-forgegreen-certified-source-state.json");
const document = JSON.parse(fs.readFileSync(documentPath, "utf8"));
const priorId = "883611157fc6c09ad6e9f6a9846268a4e67dd56698dacb7f811dd46bd247a917";
if (document.sourceStateId !== priorId || document.surfaceVersion !== "r59-free-supply-recovery-v8" || document.materialFiles.length !== 82) {
  throw new Error("R59 v9 recertification refused: unexpected r59-v8 predecessor");
}
// R59 v9: the ms-duration reset-parse fix touches quota capture — the stamp authority for every
// free capacity window. Its source and the quota suite that pins it join the material set.
const added = [
  "packages/model-registry/src/quota.ts",
  "packages/model-registry/test/free-cloud-registry.test.ts",
];
const files = [...new Set([...document.materialFiles, ...added])].sort((a, b) => a.localeCompare(b));
const entries = files.map((file) => ({ path: file, blobHash: execFileSync("git", ["hash-object", file], { cwd: root, encoding: "utf8" }).trim() }));
const changed = entries.filter((entry) => document.materialFileHashes?.[entry.path] !== entry.blobHash).map((entry) => entry.path);
const expected = [...added, "packages/server/src/index.ts"].sort((a, b) => a.localeCompare(b));
if (JSON.stringify(changed) !== JSON.stringify(expected)) throw new Error(`R59 v9 recertification refused: unreviewed drift ${JSON.stringify(changed)}`);
const dirty = execFileSync("git", ["status", "--porcelain", "--", ...files], { cwd: root, encoding: "utf8" }).trim();
if (dirty) throw new Error(`R59 v9 recertification refused: uncommitted material source ${dirty}`);
const sourceStateId = createHash("sha256").update(JSON.stringify(entries.map((entry) => [entry.path, entry.blobHash]))).digest("hex");
const version = "r59-free-supply-recovery-v9";
const reason = "R59 v9 closes the false-zero defect the v8 packaged denial made legible once the horizon surfaced: groq::openai/gpt-oss-120b was QUALIFIED/HEALTHY with 7927/8000 tokens live, yet the coder denied USER_QUOTA_EXHAUSTED across the whole recovery loop. Live header capture shows Groq reports short token windows as millisecond durations (x-ratelimit-reset-tokens: 547ms); parseResetAt had no ms group so tokenResetAt was dropped, effectiveQuota could never see the token window's reset (with requestResetAt present the aggregate fallback no longer applies), and a low mid-suite remainingTokens stamp froze the route exhausted until another call refreshed it — while denied, no call ever came: self-sealing false zero capacity. The window's own reset also inherited the ~45min request reset, so every queued verdict surfaced a wait horizon ~50x past the true refill. Parsing ms restores the real reset so low stamps refill on elapsed time and queued verdicts report the actual recovery instant; the supply projection now also surfaces token fields so a denial's binding dimension is directly evidenced. No admission, qualification, billing, or completion policy changed.";
const entry = {
  label: "R59 millisecond-reset false-zero recertification",
  reason,
  priorSourceStateId: priorId,
  priorSurfaceVersion: document.surfaceVersion,
  resultingSourceStateId: sourceStateId,
  resultingSurfaceVersion: version,
  changes: changed.map((file) => ({ file, addedToMaterialFiles: added.includes(file) })),
  regressionEvidence: "docs/evidence/r59-supply-recovery/R59-FINAL-REPORT.md",
  recertifiedAt: new Date().toISOString().slice(0, 10),
  sourceStateConstant: "CODEFORGE_R59_FREE_SUPPLY_RECOVERY_V9_SOURCE_STATE",
};
document.materialFiles = files;
document.sourceStateId = sourceStateId;
document.surfaceVersion = version;
document.materialFileHashes = Object.fromEntries(entries.map((item) => [item.path, item.blobHash]));
document.recertifications.push(entry);
document.recertifiedAt = new Date().toISOString();
document.recertification = { phase: entry.label, reason, changedFiles: changed, priorSourceStateId: priorId, guarded: true };
fs.writeFileSync(documentPath, `${JSON.stringify(document, null, 2)}\n`);
console.log(JSON.stringify({ version, sourceStateId, materialFiles: files.length, changed }));
