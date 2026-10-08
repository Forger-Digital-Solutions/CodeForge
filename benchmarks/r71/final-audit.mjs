import { readFile, writeFile, readdir, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const directory = 'docs/evidence/r71-packaged-free-supply-expansion';
const baseline = JSON.parse(await readFile(`${directory}/baseline.json`, 'utf8'));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], { cwd, encoding: 'utf8' }).trim();
const preserved = await Promise.all(baseline.preservedTracked.map(async item => ({ ...item, matches: digest(await readFile(path.join(baseline.repository, item.file))) === item.sha256 })));
const missingOriginalUntracked = [];
for (const file of baseline.originalUntracked) {
  try { await access(path.join(baseline.repository, file)); } catch { missingOriginalUntracked.push(file); }
}
const files = [];
for (const folder of [directory, 'benchmarks/r71']) {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    if (entry.isFile() && !['final-audit.json', 'evidence-manifest.json'].includes(entry.name)) files.push(path.join(folder, entry.name));
  }
}
const credentialValues = Object.entries(process.env).filter(([name, value]) => /(?:API_KEY|TOKEN|SECRET)$/.test(name) && value && value.length >= 16).map(([, value]) => value);
const credentialFindings = [];
const manifest = [];
for (const file of files) {
  const bytes = await readFile(file);
  const source = bytes.toString('utf8');
  const knownSecret = credentialValues.some(value => source.includes(value));
  const rawProviderKey = /\b(?:sk-or-v1-[a-f0-9]{32,}|gsk_[A-Za-z0-9]{25,}|hf_[A-Za-z0-9]{25,})\b/.test(source);
  if (knownSecret || rawProviderKey) credentialFindings.push({ file, knownSecret, rawProviderKey });
  manifest.push({ file: file.replaceAll('\\', '/'), bytes: bytes.length, sha256: digest(bytes) });
}
const campaign = JSON.parse(await readFile(`${directory}/R71-TASK-CAMPAIGN.json`, 'utf8'));
const taskMetrics = campaign.tasks.map(task => ({ id: task.id, taskClass: task.taskClass, status: task.status, wallTimeMs: task.wallTimeMs, changedFiles: task.result.changedFiles, reviewPassed: task.result.review.passed, verificationAttempts: task.result.counters.verificationAttempts, integratedDiffBytes: task.diff.length, reservations: task.reservations.activeReservations,
  telemetry: task.workers.reduce((totals, worker) => { for (const [key, value] of Object.entries(worker.telemetry)) if (typeof value === 'number') totals[key] = (totals[key] ?? 0) + value; return totals; }, {}), reason: task.result.summary }));
const report = { observedAt: new Date().toISOString(), sourceFreezeCommit: 'b61af87b5a5dbc66fd6b37c807c87b789348eb7b', currentHead: git(process.cwd(), 'rev-parse', 'HEAD'), originalHeadMatches: git(baseline.repository, 'rev-parse', 'HEAD') === baseline.originalHead, originalBranchMatches: git(baseline.repository, 'branch', '--show-current') === baseline.originalBranch, preserved, missingOriginalUntracked, r70ReportMatches: digest(await readFile(baseline.r70Report.file)) === baseline.r70Report.sha256, lockfileMatches: digest(await readFile('package-lock.json')) === baseline.lockfileSha256, credentialAudit: { filesScanned: files.length, credentialFindings, scope: 'All new top-level R71 benchmark and evidence files, including evidence omitted by the generic secret scanner; ignored tmp credentials/session files excluded from delivery.' }, taskMetrics };
await writeFile(`${directory}/final-audit.json`, JSON.stringify(report, null, 2) + '\n');
await writeFile(`${directory}/evidence-manifest.json`, JSON.stringify({ observedAt: report.observedAt, files: manifest }, null, 2) + '\n');
const pass = report.originalHeadMatches && report.originalBranchMatches && preserved.every(item => item.matches) && !missingOriginalUntracked.length && report.r70ReportMatches && report.lockfileMatches && !credentialFindings.length;
console.log(JSON.stringify({ status: pass ? 'PASS' : 'FAIL', preserved: preserved.length, missingOriginalUntracked: missingOriginalUntracked.length, credentialFindings: credentialFindings.length, taskMetrics }, null, 2));
if (!pass) process.exitCode = 1;
