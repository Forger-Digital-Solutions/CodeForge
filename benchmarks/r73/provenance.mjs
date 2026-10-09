import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const original = 'G:/CodeForge';
const r72 = `${original}/worktrees/r72-free-supply-and-autonomy`;
const directory = 'docs/evidence/r73-free-supply-and-completion';
const expected = '220b365c553bff0b1ee952fb6b96498c8ddea325';
const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], { cwd, encoding: 'utf8', windowsHide: true }).trim();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
if (git(r72, 'rev-parse', 'HEAD') !== expected || git(r72, 'status', '--porcelain')) throw new Error('R72_BASELINE_CHANGED');
git(process.cwd(), 'merge-base', '--is-ancestor', expected, 'HEAD');
const preservedFiles = await Promise.all(git(original, 'diff', '--name-only').split('\n').filter(Boolean).map(async file => ({ file, sha256: hash(await readFile(path.join(original, file))) })));
const priorEvidence = [];
for (const entry of await readdir(`${r72}/docs/evidence/r72-free-supply-and-autonomy`, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const absolute = path.join(entry.parentPath, entry.name);
  const file = path.relative(`${r72}/docs/evidence/r72-free-supply-and-autonomy`, absolute).replaceAll('\\', '/');
  const bytes = await readFile(absolute);
  priorEvidence.push({ file, bytes: bytes.length, sha256: hash(bytes) });
}
await mkdir(directory, { recursive: true });
const file = process.argv.includes('--final') ? 'final-preservation.json' : 'baseline-provenance.json';
const receipt = { at: new Date().toISOString(), source: process.cwd(), startingHead: expected, currentHead: git(process.cwd(), 'rev-parse', 'HEAD'), branch: git(process.cwd(), 'branch', '--show-current'), r72Head: expected, r72Clean: true, originalHead: git(original, 'rev-parse', 'HEAD'), originalBranch: git(original, 'branch', '--show-current'), originalStatus: git(original, 'status', '--short'), preservedFiles, priorEvidence, lockfileSha256: hash(await readFile('package-lock.json')) };
if (process.argv.includes('--final')) {
  const baseline = JSON.parse(await readFile(`${directory}/baseline-provenance.json`, 'utf8'));
  receipt.unchanged = ['originalHead', 'originalBranch', 'preservedFiles', 'priorEvidence', 'lockfileSha256'].every(key => JSON.stringify(receipt[key]) === JSON.stringify(baseline[key]));
  if (!receipt.unchanged) throw new Error('PRESERVATION_MISMATCH');
}
await writeFile(`${directory}/${file}`, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify({ file, originalHead: receipt.originalHead, preservedFiles: preservedFiles.length, priorEvidence: priorEvidence.length, unchanged: receipt.unchanged }));
