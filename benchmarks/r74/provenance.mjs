import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const original = 'G:/CodeForge';
const r73 = `${original}/worktrees/r73-free-supply-and-completion`;
const directory = 'docs/evidence/r74-autonomous-completion-and-free-reliability';
const expected = '6d4f98a7986d8bc43442a0254dea628da108e22e';
const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], { cwd, encoding: 'utf8', windowsHide: true }).trim();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
if (git(r73, 'rev-parse', 'HEAD') !== expected || git(r73, 'status', '--porcelain')) throw new Error('R73_BASELINE_CHANGED');
git(process.cwd(), 'merge-base', '--is-ancestor', expected, 'HEAD');
const preservedFiles = await Promise.all(git(original, 'diff', '--name-only').split('\n').filter(Boolean).map(async file => ({ file, sha256: hash(await readFile(path.join(original, file))) })));
const historicalEvidence = [];
const tracked = new Set(git(r73, 'ls-files', 'docs/evidence/r72-free-supply-and-autonomy', 'docs/evidence/r73-free-supply-and-completion').split('\n'));
for (const round of ['r72-free-supply-and-autonomy', 'r73-free-supply-and-completion']) {
  const base = `${r73}/docs/evidence/${round}`;
  for (const entry of await readdir(base, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const absolute = path.join(entry.parentPath, entry.name);
    const file = `docs/evidence/${round}/${path.relative(base, absolute).replaceAll('\\', '/')}`;
    const bytes = await readFile(absolute);
    if (tracked.has(file) && hash(bytes) !== hash(await readFile(file))) throw new Error(`HISTORICAL_EVIDENCE_CHANGED: ${file}`);
    historicalEvidence.push({ file, tracked: tracked.has(file), bytes: bytes.length, sha256: hash(bytes) });
  }
}
historicalEvidence.sort((a, b) => a.file.localeCompare(b.file));
await mkdir(directory, { recursive: true });
const final = process.argv.includes('--final');
const receipt = { at: new Date().toISOString(), source: process.cwd(), startingHead: expected, currentHead: git(process.cwd(), 'rev-parse', 'HEAD'), branch: git(process.cwd(), 'branch', '--show-current'), r73Clean: true, originalHead: git(original, 'rev-parse', 'HEAD'), originalBranch: git(original, 'branch', '--show-current'), preservedFiles, historicalEvidence, lockfileSha256: hash(await readFile('package-lock.json')) };
if (preservedFiles.length !== 6) throw new Error('ORIGINAL_MODIFICATION_COUNT_CHANGED');
if (final) {
  const baseline = JSON.parse(await readFile(`${directory}/baseline-provenance.json`, 'utf8'));
  receipt.unchanged = ['originalHead', 'originalBranch', 'preservedFiles', 'historicalEvidence'].every(key => JSON.stringify(receipt[key]) === JSON.stringify(baseline[key]));
  if (!receipt.unchanged) throw new Error('PRESERVATION_MISMATCH');
  receipt.lockfileUnchanged = receipt.lockfileSha256 === baseline.lockfileSha256;
  if (!receipt.lockfileUnchanged) {
    const refresh = JSON.parse(await readFile(`${directory}/dependency-refresh.json`, 'utf8'));
    if (refresh.previousLockfileSha256 !== baseline.lockfileSha256 || refresh.currentLockfileSha256 !== receipt.lockfileSha256 || refresh.protectedR73DependencyTargetsModified !== false) throw new Error('UNDOCUMENTED_LOCKFILE_CHANGE');
    receipt.intentionalLockfileChange = 'R74 dependency security refresh; see dependency-refresh.json';
  }
}
const file = final ? 'final-preservation.json' : 'baseline-provenance.json';
await writeFile(`${directory}/${file}`, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify({ file, preservedFiles: preservedFiles.length, historicalEvidence: historicalEvidence.length, unchanged: receipt.unchanged }));
