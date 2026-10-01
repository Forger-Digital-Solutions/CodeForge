#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const documentPath = path.join(root, "docs/codeforge-forgegreen-certified-source-state.json");
const document = JSON.parse(fs.readFileSync(documentPath, "utf8"));
const priorId = "9d7b9495fbd3baa05885ebb6493be61b6af55a515db12674c5571e54be6922be";
if (document.sourceStateId !== priorId || document.surfaceVersion !== "r59-free-supply-recovery-v12" || document.materialFiles.length !== 94) {
  throw new Error("R59 v13 recertification refused: unexpected r59-v12 predecessor");
}
// R59 v13: the first packaged v12 dogfood (persistent profile) exposed two faults outside the
// supply pipeline itself. (1) A stale persisted git worktree — checkout gone, node_modules
// junction left behind — reclaimed its parent's repositoryRoot during hydration because every
// workspace aliased repositoryRoot; the next run targeting that path resolved to the dead
// worktree, and its checkpoint `git stash -u` resolved upward to the enclosing repository and
// nearly swept the developer's main checkout. (2) Groq's live quota headers stamped
// remainingTokens (122-528 observed) into CapacityWindow.limit via a fallback, collapsing the
// servingInputTokenCeiling toward zero whenever mid-window probes drained remaining. Both test
// files join the material set — they pin the workspace-identity and checkpoint-root invariants.
const added = [
  "packages/server/test/checkpoint.test.ts",
  "packages/server/test/forge-workspaces.test.ts",
];
const files = [...new Set([...document.materialFiles, ...added])].sort((a, b) => a.localeCompare(b));
const entries = files.map((file) => ({ path: file, blobHash: execFileSync("git", ["hash-object", file], { cwd: root, encoding: "utf8" }).trim() }));
const changed = entries.filter((entry) => document.materialFileHashes?.[entry.path] !== entry.blobHash).map((entry) => entry.path);
const expected = [
  "packages/model-registry/src/free-cloud-service.ts",
  "packages/model-registry/test/free-cloud-registry.test.ts",
  "packages/server/src/checkpoint-service.ts",
  "packages/server/src/workspace-service.ts",
  "packages/server/test/checkpoint.test.ts",
  "packages/server/test/forge-workspaces.test.ts",
].sort((a, b) => a.localeCompare(b));
if (JSON.stringify(changed) !== JSON.stringify(expected)) throw new Error(`R59 v13 recertification refused: unreviewed drift ${JSON.stringify(changed)}`);
const dirty = execFileSync("git", ["status", "--porcelain", "--", ...files], { cwd: root, encoding: "utf8" }).trim();
if (dirty) throw new Error(`R59 v13 recertification refused: uncommitted material source ${dirty}`);
const sourceStateId = createHash("sha256").update(JSON.stringify(entries.map((entry) => [entry.path, entry.blobHash]))).digest("hex");
const version = "r59-free-supply-recovery-v13";
const reason = "R59 v13 closes the workspace-identity and quota-projection faults the v12 packaged dogfood surfaced, without touching admission, qualification, cost, or completion policy. (1) Workspace identity: hydration aliased every workspace's repositoryRoot to its id, so a stale persisted git worktree whose checkout had been partially removed reclaimed its parent's root; the next run registering that path resolved to the dead worktree, and checkpoint ran `git stash -u` inside a directory that resolved upward to the enclosing repository. Now only local workspaces alias repositoryRoot, persisted worktrees missing their directory or .git marker are marked missing and never returned as live registration targets, worktree creation verifies the .git marker materialized before persisting, and checkpoint verification requires the workspace to be a repository toplevel via `git rev-parse --show-prefix` (empty at a root, non-empty when nested, error outside a repo — no Windows 8.3 path compare; result cached per service). (2) Serving ceiling: servingInputTokenCeiling previously consumed the conflated CapacityWindow.limit, whose quotaWindows projection falls back to remainingTokens when limitTokens is absent — a mid-window Groq observation (remaining 122-528 against an 8000-token window) collapsed the ceiling toward zero. The ceiling now reads declared limitTokens directly from RouteQuotaTracker with identical provider/model/bucket resolution, so only provider-declared windows bound context assembly while admission keeps arbitrating on live remaining and reset evidence. Regression tests pin both invariants: a stale persisted worktree never captures its parent's repository root on restart, a nested directory can never checkpoint the enclosing tree, and remaining-only quota observations leave the serving ceiling unbounded rather than fabricating a limit. No free-only, qualification, billing, quota, ownership, or completion-gate policy changed; missing or unqualified capacity still fails closed.";
const entry = {
  label: "R59 workspace-identity and declared-ceiling recertification",
  reason,
  priorSourceStateId: priorId,
  priorSurfaceVersion: document.surfaceVersion,
  resultingSourceStateId: sourceStateId,
  resultingSurfaceVersion: version,
  changes: changed.map((file) => ({ file, addedToMaterialFiles: added.includes(file) })),
  regressionEvidence: "docs/evidence/r59-supply-recovery/R59-FINAL-REPORT.md",
  recertifiedAt: new Date().toISOString().slice(0, 10),
  sourceStateConstant: "CODEFORGE_R59_FREE_SUPPLY_RECOVERY_V13_SOURCE_STATE",
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
