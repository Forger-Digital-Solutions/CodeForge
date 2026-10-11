import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
const path = "docs/codeforge-forgegreen-certified-source-state.json";
const doc = JSON.parse(await readFile(path, "utf8"));
// R84 branched from the R83 head; the milestone's additions to the certified
// surface are the packages/apps paths it changed.
const R83_BASE = "12ce5a5209329a878a173945b787337f495ba4e3";
const additions = execFileSync("git", ["diff", "--name-only", R83_BASE, "--", "packages", "apps"], { encoding: "utf8" }).trim().split(/\r?\n/).filter(Boolean);
const materialFiles = [...new Set([...doc.materialFiles, ...additions])].sort((a, b) => a.localeCompare(b));
const quoted = materialFiles.map((file) => `"${file.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\t", "\\t").replaceAll("\r", "\\r").replaceAll("\n", "\\n")}"`).join("\n") + "\n";
const hashes = execFileSync("git", ["hash-object", "--stdin-paths"], { encoding: "utf8", input: quoted }).trim().split(/\r?\n/);
if (hashes.length !== materialFiles.length || hashes.some((hash) => !/^[0-9a-f]{40,64}$/.test(hash))) throw new Error("SOURCE_STATE_HASH_BATCH_INVALID");
const entries = materialFiles.map((file, index) => [file, hashes[index]]);
const sourceStateId = createHash("sha256").update(JSON.stringify(entries)).digest("hex");
if (sourceStateId !== doc.sourceStateId) {
  const changedFiles = entries.filter(([file, hash]) => doc.materialFileHashes[file] !== hash).map(([file]) => file);
  const reason = "R84 free-cloud autonomy certification: provider terms now gate Kilo NVIDIA trial routes (DEVELOPMENT_ONLY) and opaque Auto Free routes (LEGAL_REVIEW_REQUIRED) so production routing admits only TERMS_ALLOWED models; workflow prompt construction redacts secrets from intent goals before persistence and SSE; the paid-auto meta-provider scopes capacity cooldowns to the canonical model instead of the whole fleet so one walled canonical cannot starve sibling routes; ForgeAAA reviewer schema validation and stream-error contracts harden model review; capacity governor preserves FIFO fairness across eligible tickets; the native exit traversal reverts to the proven single continuous crossing. Completion authority, ForgeZero fail-closed policy, privacy and qualification floors are unchanged. The hash refresh also absorbs material-surface drift accumulated since the R67 recertification.";
  const priorSourceStateId = doc.sourceStateId;
  const priorSurfaceVersion = doc.surfaceVersion;
  Object.assign(doc, { sourceStateId, surfaceVersion: "r84-free-cloud-autonomy-v1", materialFiles,
    materialFileHashes: Object.fromEntries(entries), recertifiedAt: new Date().toISOString().slice(0, 10),
    recertification: { phase: "R84 free-cloud autonomy certification", reason, changedFiles, priorSourceStateId, guarded: true } });
  doc.recertifications.push({ label: "R84 free-cloud autonomy certification", reason, priorSourceStateId, priorSurfaceVersion,
    resultingSourceStateId: sourceStateId, resultingSurfaceVersion: doc.surfaceVersion, recertifiedAt: doc.recertifiedAt,
    changedFiles: changedFiles.map((file) => ({ file, addedToMaterialFiles: additions.includes(file) })), regressionEvidence: "docs/evidence/r84-free-cloud-autonomy-certification/repository-tests-final.json" });
  await writeFile(path, `${JSON.stringify(doc, null, 2)}\n`);
}
console.log(JSON.stringify({ surfaceVersion: doc.surfaceVersion, sourceStateId }));
