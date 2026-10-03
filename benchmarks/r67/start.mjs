import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const directory = 'docs/evidence/r67-everyday-completion-reliability';
const backup = 'benchmarks/r67/tmp/preserved';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const prior = JSON.parse(await readFile('docs/evidence/r66-everyday-free-readiness/R66-USER-WORK-PRESERVATION.json', 'utf8'));
const head = git('rev-parse', 'HEAD');
if (head !== '6c8af1b3fd43b048fdad2002aa6e5d22b1b72957') throw new Error('UNEXPECTED_HEAD');
await mkdir(directory, { recursive: true });
await mkdir(backup, { recursive: true });
const files = [];
for (const [index, file] of prior.files.entries()) {
  const bytes = await readFile(file.path);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== file.sha256) throw new Error(`PRIOR_WORK_MISMATCH:${file.path}`);
  const backupPath = `${backup}/${index}.bin`;
  await copyFile(file.path, backupPath);
  files.push({ path: file.path, sha256, bytes: bytes.length, backupPath, matchesR66: true });
}
const state = { generatedAt: new Date().toISOString(), head, branch: git('branch', '--show-current'), trackedStatus: git('status', '--short', '--untracked-files=no'), log: git('log', '-8', '--oneline'), preservedFiles: files };
await writeFile(`${directory}/R67-START-STATE.json`, `${JSON.stringify(state, null, 2)}\n`);
await writeFile(`${directory}/R67-USER-WORK-PRESERVATION.json`, `${JSON.stringify({ status: 'PASS', startingHead: head, files }, null, 2)}\n`);
console.log(JSON.stringify({ head, branch: state.branch, preservedFiles: files.length }));
