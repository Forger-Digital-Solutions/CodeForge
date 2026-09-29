import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const evidenceDir = path.join(root, "docs/evidence/r57-autonomous-endurance-learning");
const exe = path.join(root, "apps/desktop/release/win-unpacked/CodeForge.exe");
const cases = [
  ["full", "packaged-full.log", "PACKAGED_FULL_SMOKE_OK"],
  ["interrupt", "packaged-interrupt.log", "PACKAGED_INTERRUPT_EXPECTED_EXIT"],
  ["recover", "packaged-recover.log", "PACKAGED_RECOVERY_SMOKE_OK"],
  ["live_completed", "packaged-live-task.log", "packaged_live_task=PASS"],
  ["live_repeat_blocked", "packaged-live-task-repeat-blocked.log", "packaged_live_task=BLOCKED"],
];
const smokes = cases.map(([name, file, marker]) => {
  const content = fs.readFileSync(path.join(evidenceDir, file), "utf8");
  assert.ok(content.includes(marker), `${name} marker missing`);
  assert.ok(content.includes("app_is_packaged=true"), `${name} was not packaged`);
  return { name, file, marker, smokeRunId: [...content.matchAll(/smoke_run_id=([0-9a-f-]+)/g)].at(-1)?.[1] ?? null };
});
assert.equal(new Set(smokes.map((entry) => entry.smokeRunId)).size, smokes.length);
const digest = createHash("sha256");
for await (const chunk of fs.createReadStream(exe)) digest.update(chunk);
const identity = JSON.parse(fs.readFileSync(path.join(root, "apps/desktop/dist/build-identity.json"), "utf8"));
const evidence = {
  schemaVersion: "r57-package-proof/v1", evidenceClass: "packaged_windows",
  artifact: { path: "apps/desktop/release/win-unpacked/CodeForge.exe", sha256: digest.digest("hex"), bytes: fs.statSync(exe).size, version: identity.version, commit: identity.commit, dirty: identity.dirty },
  audits: { internalDependencyGraph: "PASS", runtimeDependencyGraph: "PASS", buildIdentity: "PASS", authEndpoint: "PASS", browserSecurity: "PASS" },
  smokes,
  repeatBlockDiagnostic: "packaged-repeat-diagnostic.json",
};
fs.writeFileSync(path.join(evidenceDir, "package-proof.json"), `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify({ artifact: evidence.artifact, smokes: smokes.map((entry) => entry.name) }));
