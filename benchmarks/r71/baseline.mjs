import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const original = 'G:/CodeForge';
const output = path.resolve('docs/evidence/r71-packaged-free-supply-expansion');
mkdirSync(output, { recursive: true });
const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], { cwd, encoding: 'utf8' }).trim();
const modified = git(original, 'diff', '--name-only').split('\n').filter(Boolean);
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const report = {
  observedAt: new Date().toISOString(), repository: original,
  originalBranch: git(original, 'branch', '--show-current'), originalHead: git(original, 'rev-parse', 'HEAD'),
  branch: git(process.cwd(), 'branch', '--show-current'), startingHead: git(process.cwd(), 'rev-parse', 'HEAD'),
  remote: git(original, 'remote', 'get-url', 'origin'),
  baselineCommits: ['516a3c30', '2ac1ede0'].map(commit => ({ commit: git(original, 'rev-parse', commit), containingBranches: git(original, 'branch', '-a', '--contains', commit) })),
  lockfileSha256: hash('package-lock.json'),
  preservedTracked: modified.map(file => ({ file, sha256: hash(path.join(original, file)) })),
  originalUntracked: git(original, 'ls-files', '--others', '--exclude-standard').split('\n').filter(Boolean),
  r70Report: { file: `${original}/docs/evidence/r70-free-supply-independence/R70-FINAL-REPORT.md`, sha256: hash(`${original}/docs/evidence/r70-free-supply-independence/R70-FINAL-REPORT.md`) },
};
writeFileSync(path.join(output, 'baseline.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ startingHead: report.startingHead, branch: report.branch, preservedFiles: modified.length }));
