import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const directory = 'docs/evidence/r66-everyday-free-readiness';
const start = JSON.parse(await readFile(`${directory}/R66-START-STATE.json`, 'utf8'));
const files = [];
for (const entry of start.preservedFiles) {
  const bytes = await readFile(entry.path);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== entry.sha256) throw new Error(`USER_WORK_CHANGED:${entry.path}`);
  files.push({ ...entry, finalSha256: sha256, bytePreserved: true });
}
const path = 'packages/repo-intelligence/test/cf14-large-repo-benchmark.test.ts';
const before = execFileSync('git', ['show', `${start.head}:${path}`]);
const current = await readFile(path);
if (!before.equals(current)) throw new Error('CF14_CHANGED');
await writeFile(`${directory}/R66-USER-WORK-PRESERVATION.json`, `${JSON.stringify({ generatedAt: new Date().toISOString(), startingHead: start.head, status: 'PASS', files, cf14: { path, byteUnchanged: true, sha256: createHash('sha256').update(current).digest('hex') } }, null, 2)}\n`);
console.log(JSON.stringify({ preserved: files.length, cf14Unchanged: true }));
