import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const certificatePath = resolve(root, "docs/evidence/free-capacity-fabric/source-certification.json");

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function rows(paths) {
  const unique = [...new Set(paths)].sort();
  if (unique.length !== paths.length || unique.some((path) => !path || path.startsWith("/") || path.includes("..") || path.includes("\\"))) {
    throw new Error("CERTIFICATE_PATH_INVALID");
  }
  return Promise.all(unique.map(async (path) => ({ path, sha256: digest(await readFile(resolve(root, path))) })));
}

function aggregate(entries) {
  return digest(JSON.stringify(entries.map(({ path, sha256 }) => [path, sha256])));
}

export async function checkFreeCapacityCertificate(certificate) {
  const sourceFiles = await rows(certificate.sourceFiles.map((entry) => entry.path));
  const evidenceFiles = await rows(certificate.evidenceFiles.map((entry) => entry.path));
  const sourceAggregateSha256 = aggregate(sourceFiles);
  const evidenceAggregateSha256 = aggregate(evidenceFiles);
  const same = (expected, actual) => JSON.stringify(expected) === JSON.stringify(actual);
  return {
    valid: same(certificate.sourceFiles, sourceFiles)
      && same(certificate.evidenceFiles, evidenceFiles)
      && certificate.sourceAggregateSha256 === sourceAggregateSha256
      && certificate.evidenceAggregateSha256 === evidenceAggregateSha256,
    sourceFiles,
    evidenceFiles,
    sourceAggregateSha256,
    evidenceAggregateSha256,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const certificate = JSON.parse(await readFile(certificatePath, "utf8"));
  const checked = await checkFreeCapacityCertificate(certificate);
  if (process.argv[2] === "--write") {
    const updated = {
      ...certificate,
      certifiedAt: new Date().toISOString(),
      sourceFiles: checked.sourceFiles,
      sourceAggregateSha256: checked.sourceAggregateSha256,
      evidenceFiles: checked.evidenceFiles,
      evidenceAggregateSha256: checked.evidenceAggregateSha256,
    };
    await writeFile(certificatePath, `${JSON.stringify(updated, null, 2)}\n`);
    process.stdout.write("FREE_CAPACITY_CERTIFICATE_WRITTEN\n");
  } else if (process.argv[2] === "--verify") {
    if (!checked.valid) throw new Error("FREE_CAPACITY_CERTIFICATE_MISMATCH");
    process.stdout.write("FREE_CAPACITY_CERTIFICATE_VALID\n");
  } else {
    throw new Error("Usage: node scripts/free-capacity-certificate.mjs --write|--verify");
  }
}
