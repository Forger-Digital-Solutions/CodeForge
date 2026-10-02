import { readFile, writeFile, copyFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const directory = 'docs/evidence/free-capacity-fabric/';
const authority = JSON.parse(await readFile(`${directory}R65-R34-PRESERVATION.json`, 'utf8'));
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const files = [];
await mkdir('benchmarks/r65/tmp/closure-preserved', { recursive: true });
for (const [index, entry] of authority.preexistingModifiedFiles.entries()) {
  const bytes = await readFile(entry.path);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== entry.currentSha256) throw new Error(`PRESERVATION_MISMATCH:${entry.path}`);
  const backupPath = `benchmarks/r65/tmp/closure-preserved/${index}.bin`;
  await copyFile(entry.path, backupPath);
  files.push({ path: entry.path, sha256, bytes: bytes.length, backupPath, matchesPriorAuthority: true });
}
const state = { generatedAt: new Date().toISOString(), head: git('rev-parse', 'HEAD'), branch: git('branch', '--show-current'), files, status: 'PASS' };
await writeFile(`${directory}R65-USER-WORK-PRESERVATION.json`, `${JSON.stringify(state, null, 2)}\n`);
await writeFile(`${directory}R65-CLOSURE-RECOVERY.json`, `${JSON.stringify({ ...state, expectedHead: '4dfa11e195ca5864927c2ab3539f25b82ac24bf6', trackedStatus: git('status', '--short', '--untracked-files=no') }, null, 2)}\n`);
console.log(`Verified and backed up ${files.length} preserved files.`);
