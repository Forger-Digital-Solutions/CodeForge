import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const directory = 'docs/evidence/r66-everyday-free-readiness';
const backup = 'benchmarks/r66/tmp/preserved';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
await mkdir(directory, { recursive: true });
await mkdir(backup, { recursive: true });
const prior = JSON.parse(await readFile('docs/evidence/free-capacity-fabric/R65-USER-WORK-PRESERVATION.json', 'utf8'));
const paths = git('diff', '--name-only').split(/\r?\n/).filter(Boolean);
const files = [];
for (const [index, path] of paths.entries()) {
  const bytes = await readFile(path);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const authority = prior.files.find((entry) => entry.path === path);
  if (!authority || authority.sha256 !== sha256) throw new Error(`PRIOR_WORK_MISMATCH:${path}`);
  const backupPath = `${backup}/${index}.bin`;
  await copyFile(path, backupPath);
  files.push({ path, sha256, bytes: bytes.length, backupPath, matchesR65: true });
}
if (files.length !== 6) throw new Error('EXPECTED_SIX_PREEXISTING_EDITS');
const state = { generatedAt: new Date().toISOString(), head: git('rev-parse', 'HEAD'), branch: git('branch', '--show-current'), trackedStatus: git('status', '--short', '--untracked-files=no'), log: git('log', '-8', '--oneline'), preservedFiles: files };
if (state.head !== '8b436277e6ebbb9620a4e61b085a447e96045727') throw new Error('UNEXPECTED_HEAD');
await writeFile(`${directory}/R66-START-STATE.json`, `${JSON.stringify(state, null, 2)}\n`);
await writeFile(`${directory}/R66-USER-WORK-PRESERVATION.json`, `${JSON.stringify({ ...state, status: 'PASS' }, null, 2)}\n`);
console.log(JSON.stringify({ head: state.head, branch: state.branch, preservedFiles: files.length }));
