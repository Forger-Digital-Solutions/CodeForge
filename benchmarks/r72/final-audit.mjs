import { readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const directory = 'docs/evidence/r72-free-supply-and-autonomy';
const baseline = JSON.parse(await readFile(`${directory}/provenance.json`, 'utf8'));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], { cwd, encoding: 'utf8' }).trim();
const preserved = await Promise.all(baseline.preservedFiles.map(async file => ({ ...file, matches: digest(await readFile(path.join(baseline.original, file.file))) === file.sha256 })));
const historical = await Promise.all(baseline.previousEvidence.map(async file => ({ file: file.file, matches: digest(await readFile(path.join(baseline.original, 'benchmarks/r71/tmp/source/docs/evidence/r71-packaged-free-supply-expansion', file.file))) === file.sha256 })));
const secrets = Object.entries(process.env).filter(([name, value]) => /(?:API_KEY|TOKEN|SECRET)$/.test(name) && value?.length >= 16).map(([, value]) => value);
const paths = [];
async function walk(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name === 'tmp') continue;
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) await walk(file);
    else if (entry.isFile() && !['final-audit.json', 'evidence-manifest.json'].includes(entry.name)) paths.push(file);
  }
}
await walk(directory);
await walk('benchmarks/r72');
const files = [], credentialFindings = [];
for (const file of paths) {
  const bytes = await readFile(file);
  const content = bytes.toString('utf8');
  if (secrets.some(secret => content.includes(secret)) || /\b(?:sk-or-v1-[a-f0-9]{32,}|gsk_[A-Za-z0-9]{25,}|hf_[A-Za-z0-9]{25,})\b/.test(content)) credentialFindings.push(file);
  files.push({ file: file.replaceAll('\\', '/'), bytes: bytes.length, sha256: digest(bytes) });
}
const report = { observedAt: new Date().toISOString(), currentHead: git(process.cwd(), 'rev-parse', 'HEAD'), branch: git(process.cwd(), 'branch', '--show-current'),
  originalHeadMatches: git(baseline.original, 'rev-parse', 'HEAD') === baseline.originalHead,
  originalBranchMatches: git(baseline.original, 'branch', '--show-current') === baseline.originalBranch,
  originalStatusMatches: git(baseline.original, 'status', '--short') === baseline.originalStatus,
  r71HeadMatches: git(path.join(baseline.original, 'benchmarks/r71/tmp/source'), 'rev-parse', 'HEAD') === baseline.r71CheckoutHead,
  preserved, historical, lockfileMatches: digest(await readFile('package-lock.json')) === baseline.lockfileSha256,
  credentialAudit: { filesScanned: paths.length, findings: credentialFindings, scope: 'Recursive R72 delivered benchmark/evidence files, including archived candidate receipts; ignored tmp/session/native test data excluded.' } };
const pass = report.originalHeadMatches && report.originalBranchMatches && report.originalStatusMatches && report.r71HeadMatches && preserved.every(f => f.matches) && historical.every(f => f.matches) && report.lockfileMatches && !credentialFindings.length;
report.status = pass ? 'PASS' : 'FAIL';
await writeFile(`${directory}/final-audit.json`, JSON.stringify(report, null, 2));
await writeFile(`${directory}/evidence-manifest.json`, JSON.stringify({ observedAt: report.observedAt, files }, null, 2));
console.log(JSON.stringify({ status: report.status, preservedFiles: preserved.length, historicalEvidenceFiles: historical.length, credentialFindings: credentialFindings.length, originalStatusMatches: report.originalStatusMatches }));
process.exitCode = pass ? 0 : 1;
