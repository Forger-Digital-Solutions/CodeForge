import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifestPath = path.join(root, "docs/evidence/r28-capability-completion/R28-EVIDENCE-FREEZE.json");
const outputPath = path.join(root, "docs/evidence/r29-release-closure/02-r28-freeze-verification/hash-check.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const mismatches = [];
let matched = 0;

for (const file of manifest.files) {
  const absolute = path.resolve(root, file.path);
  if (!absolute.startsWith(`${root}${path.sep}`)) throw new Error("Frozen path escaped the repository.");
  try {
    const bytes = await readFile(absolute);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (bytes.length === file.bytes && sha256 === file.sha256) matched++;
    else mismatches.push({ path: file.path, expectedBytes: file.bytes, actualBytes: bytes.length, expectedSha256: file.sha256, actualSha256: sha256 });
  } catch (error) {
    mismatches.push({ path: file.path, error: error instanceof Error ? error.message : String(error) });
  }
}

const receipt = {
  schema: "r29-r28-freeze-hash-check-1",
  checkedAt: new Date().toISOString(),
  sourceManifest: path.relative(root, manifestPath).replaceAll("\\", "/"),
  declaredFileCount: manifest.fileCount,
  listedFileCount: manifest.files.length,
  matched,
  mismatches,
  passed: manifest.fileCount === manifest.files.length && matched === manifest.fileCount,
};
await writeFile(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ passed: receipt.passed, matched, mismatches: mismatches.length }));
if (!receipt.passed) process.exitCode = 1;
