import { readFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
export const directory = 'docs/evidence/r67-everyday-completion-reliability';
export const read = async name => JSON.parse(await readFile(`${directory}/${name}.json`, 'utf8'));
export const helpers = ['.gitignore', 'accounting-faults.mjs', 'audit-final-source.mjs', 'bounded-tests.mjs',
  'canonical-audit.mjs', 'conpty-proof.mjs', 'churn.mjs', 'database-fault.mjs', 'database-recovery-certification.mjs',
  'evidence-scan.mjs', 'forensics.mjs', 'freeze.mjs', 'fresh-campaign.mjs', 'fresh-tasks.mjs',
  'live-campaign.mjs', 'live-coder-recovery.mjs', 'live-parent-recovery.mjs', 'live-parent-worker.mjs',
  'live-supply.mjs', 'multi-user.mjs', 'parent-recovery.mjs', 'parent-worker.mjs', 'progress.mjs',
  'provider-fault-recovery.mjs', 'qualify.mjs', 'recertify-source-state.mjs', 'recovery-live.mjs',
  'recovery-mutations.mjs', 'server-parent-recovery.mjs', 'server-recovery-worker.mjs',
  'stamp-production-package.mjs', 'start.mjs', 'tasks.mjs', 'windows-soak.mjs',
  'release-artifacts.mjs', 'certify.mjs', 'history-index.mjs', 'release-report.mjs', 'stage-audit.mjs', 'package-audit.mjs', 'test-only-source-delta.mjs'];
export async function sourcePaths() {
  const start = await read('R67-START-STATE');
  const preserved = new Set(start.preservedFiles.map(file => file.path));
  const frozen = await read('R67-SOURCE-FREEZE');
  const prior = await read('source-certification').catch(async () => JSON.parse(await readFile('docs/evidence/r66-everyday-free-readiness/source-certification.json', 'utf8')));
  const changed = execFileSync('git', ['diff', '--name-only'], { encoding: 'utf8' }).trim().split(/\r?\n/).filter(file => file && !preserved.has(file) && !file.startsWith('docs/evidence/'));
  return [...new Set([...prior.sourceFiles.map(file => file.path), ...frozen.files.map(file => file.path), ...changed,
    ...helpers.map(file => `benchmarks/r67/${file}`), 'docs/codeforge-forgegreen-certified-source-state.json',
    'scripts/free-capacity-certificate.mjs'])].filter(file => !preserved.has(file)).sort();
}
export async function evidencePaths() {
  const excluded = new Set(['source-certification.json', 'R67-CERTIFICATE-CANARY.json',
    'R67-CERTIFICATE-CANARY-final.json', 'R67-EVIDENCE-SECRET-SCAN.json', 'R67-FINAL-SOURCE-PRESERVATION.json', 'R67-STAGE-AUDIT.json']);
  return (await readdir(directory)).filter(file => /\.(json|md)$/.test(file) && !excluded.has(file)).map(file => `${directory}/${file}`).sort();
}
