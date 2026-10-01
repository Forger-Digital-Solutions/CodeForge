#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const documentPath = path.join(root, "docs/codeforge-forgegreen-certified-source-state.json");
const document = JSON.parse(fs.readFileSync(documentPath, "utf8"));
const priorId = "334f477da0f102ae7a9e0c231f072e42e33886326097cbac02af868dfa11aedd";
if (document.sourceStateId !== priorId || document.surfaceVersion !== "r59-free-supply-recovery-v11" || document.materialFiles.length !== 93) {
  throw new Error("R59 v12 recertification refused: unexpected r59-v11 predecessor");
}
// R59 v12: the first packaged v11 dogfood surfaced two faults the new serving-window wiring
// introduced downstream — the progressive planner received the repository-page slice as its
// kernel-must-fit capacity, and the serialized-wire check inherited the assembly bound rather
// than the raw ceiling. packages/context/test/cf14-context.test.ts joins the material set —
// it now pins the kernel-only-plan semantics a fully consumed repository slice must produce.
const added = [
  "packages/context/test/cf14-context.test.ts",
];
const files = [...new Set([...document.materialFiles, ...added])].sort((a, b) => a.localeCompare(b));
const entries = files.map((file) => ({ path: file, blobHash: execFileSync("git", ["hash-object", file], { cwd: root, encoding: "utf8" }).trim() }));
const changed = entries.filter((entry) => document.materialFileHashes?.[entry.path] !== entry.blobHash).map((entry) => entry.path);
const expected = [
  "packages/context/src/index.ts",
  "packages/context/test/cf14-context.test.ts",
  "packages/server/src/agent-runtime.ts",
  "packages/server/test/free-fabric-wiring.test.ts",
].sort((a, b) => a.localeCompare(b));
if (JSON.stringify(changed) !== JSON.stringify(expected)) throw new Error(`R59 v12 recertification refused: unreviewed drift ${JSON.stringify(changed)}`);
const dirty = execFileSync("git", ["status", "--porcelain", "--", ...files], { cwd: root, encoding: "utf8" }).trim();
if (dirty) throw new Error(`R59 v12 recertification refused: uncommitted material source ${dirty}`);
const sourceStateId = createHash("sha256").update(JSON.stringify(entries.map((entry) => [entry.path, entry.blobHash]))).digest("hex");
const version = "r59-free-supply-recovery-v12";
const reason = "R59 v12 makes the v11 serving-window cap survivable to the wire. The first v11 packaged dogfood (persistent profile, groq/gpt-oss-120b QUALIFIED with a stamped 8000-token input window) died before dispatch with CONTEXT_CAPACITY_UNKNOWN — 228 kernel tokens against a zero budget. Two real faults, both in the new wiring, both fixed without touching admission, qualification, cost, or completion policy. (1) assemble() passed the repository-page slice (repository*0.8) to planNarrow as capacity, but the planner's fail-closed contract is 'capacity must hold the plan's prompt' — which starts with the kernel the caller already rendered and charged upstream. A serving window smaller than the fixed reserves resolves that slice to zero and falsely faults the kernel; the slice is now added on top of the kernel's own cost, so a zero slice honestly produces a kernel-only plan (BUDGET_EXHAUSTED_BY_KERNEL, zero pages, L0 truncation receipt) instead of a crashed run. (2) The R41 serialized-wire bound inherited resolvedMaxContextTokens — now the assembly bound (window minus tool/transcript overhead) — which would fail closed AGENT_CONTEXT_BUDGET_EXCEEDED on every request whose tool surface legitimately rides on top. The wire bound is now min(roleOrModelBound, servingCeiling): the reserve the assembly subtracted is exactly what the tool surface occupies. Regression tests pin both units — assemble under a window smaller than the fixed reserves yields the kernel-only plan rather than faulting, and a free-routed request whose wire measures inside (ceiling minus overhead, ceiling] dispatches instead of failing closed. No free-only, qualification, billing, quota, ownership, or completion-gate policy changed; unknown windows still leave the budget unbounded and impossibly small windows still fail closed.";
const entry = {
  label: "R59 serving-window wire-survival recertification",
  reason,
  priorSourceStateId: priorId,
  priorSurfaceVersion: document.surfaceVersion,
  resultingSourceStateId: sourceStateId,
  resultingSurfaceVersion: version,
  changes: changed.map((file) => ({ file, addedToMaterialFiles: added.includes(file) })),
  regressionEvidence: "docs/evidence/r59-supply-recovery/R59-FINAL-REPORT.md",
  recertifiedAt: new Date().toISOString().slice(0, 10),
  sourceStateConstant: "CODEFORGE_R59_FREE_SUPPLY_RECOVERY_V12_SOURCE_STATE",
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
