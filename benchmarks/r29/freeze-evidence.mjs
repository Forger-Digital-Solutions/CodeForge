import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const evidenceRoot = "docs/evidence/r29-release-closure";
const certification = "docs/certification/codeforge-r29-release-closure-2026-09-23.md";
const manifestPath = `${evidenceRoot}/R29-EVIDENCE-FREEZE.json`;
const sourceCommit = "0dbca660ba721b7cde5bcd6bd6d7cbbb01e600f7";

function walk(relative) {
  const full = path.join(repoRoot, relative);
  return fs.readdirSync(full, { withFileTypes: true }).flatMap((entry) => {
    const child = `${relative}/${entry.name}`;
    if (entry.isDirectory()) return walk(child);
    if (!entry.isFile() || child === manifestPath || child.endsWith(".log")) return [];
    return [child];
  });
}

function entries() {
  const paths = [certification, ...walk(evidenceRoot), ...walk("benchmarks/r29")].sort();
  return paths.map((relative) => {
    const bytes = fs.readFileSync(path.join(repoRoot, relative));
    return { path: relative, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
  });
}

const files = entries();
if (process.argv.includes("--verify")) {
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, manifestPath), "utf8"));
  const actual = JSON.stringify(files);
  const expected = JSON.stringify(manifest.files);
  if (manifest.fileCount !== files.length || actual !== expected) {
    throw new Error("R29 evidence freeze mismatch");
  }
  console.log(JSON.stringify({ passed: true, matched: files.length, mismatches: 0 }));
} else {
  const manifest = {
    schema: "r29-evidence-freeze-1",
    frozenAt: new Date().toISOString(),
    verdict: "CODEFORGE_R29_RELEASE_BLOCKED",
    certification,
    packageSourceCommit: sourceCommit,
    fileCount: files.length,
    files,
  };
  fs.writeFileSync(path.join(repoRoot, manifestPath), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify({ frozen: true, files: files.length }));
}
