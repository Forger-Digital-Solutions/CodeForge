import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const root = "docs/evidence/free-capacity-fabric/";
const backup = "benchmarks/r65/tmp/preserved/";
await mkdir(backup, { recursive: true });
const paths = git("diff", "--name-only").split(/\r?\n/).filter(Boolean);
const files = [];
for (const [index, path] of paths.entries()) {
  const bytes = await readFile(path);
  const backupPath = `${backup}${index}.bin`;
  await copyFile(path, backupPath);
  files.push({ path, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, backupPath });
}
await writeFile(`${root}R65-START-STATE.json`, `${JSON.stringify({ generatedAt: new Date().toISOString(), head: git("rev-parse", "HEAD"), branch: git("branch", "--show-current"), ancestor: "616cbec8629a0083573efa673a8495d1aee64b36", status: git("status", "--short", "--untracked-files=no"), diffStat: git("diff", "--stat"), preservedFiles: files }, null, 2)}\n`);
console.log(`Preserved ${files.length} dirty files with byte backups.`);
