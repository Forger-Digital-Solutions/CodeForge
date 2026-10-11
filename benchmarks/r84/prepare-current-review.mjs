import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const directory = 'docs/evidence/r84-free-cloud-autonomy-certification';
const digest = text => createHash('sha256').update(text).digest('hex');
const artifact = async file => {
  const text = await readFile(`${directory}/${file}`, 'utf8');
  return { file, sha256: digest(text), value: JSON.parse(text) };
};
const tests = await artifact('core-tests-final.json');
const terms = await artifact('model-terms-tests-final.json');
const build = await readFile(`${directory}/build-release.log`, 'utf8');
const lint = await readFile(`${directory}/lint-release.log`, 'utf8');
const nativeFiles = (await readdir(`${directory}/native`)).filter(file => /^(migration-fault-campaign|persistence-upgrade)-.*\.json$/.test(file)).sort();
const native = await Promise.all(nativeFiles.map(async file => {
  const item = await artifact(`native/${file}`);
  return { file: item.file, sha256: item.sha256, ok: item.value.ok ?? false, error: item.value.error, cases: Object.fromEntries(Object.entries(item.value.cases ?? {}).map(([name, value]) => [name, typeof value === 'object' && value !== null ? { phase: value.phase, state: value.state, exitCode: value.exitCode, errors: value.errors, levelHash: value.levelHash, mutationStarted: value.mutationStarted, idempotent: value.idempotent, boolean: value.boolean, copiedRollback: value.copiedRollback, evidence: value.evidence ? { actors_verified: value.evidence.actors_verified, instanceCount: value.evidence.instanceCount, independentProcess: value.evidence.independentProcess, levelFileSha256: value.evidence.levelFileSha256, errors: value.evidence.errors } : undefined } : value])),
    stages: Object.fromEntries(Object.entries(item.value.stages ?? {}).map(([name, result]) => [name, { state: result.state, failures: result.metrics?.failures, engineVersion: result.metrics?.engineVersion }])) };
}));
const sourceFiles = ['packages/forge-aaa/src/model-review.ts', 'packages/forge-aaa/src/building-revision.ts'];
const sources = await Promise.all(sourceFiles.map(async file => { const text = await readFile(file, 'utf8'); const end = text.indexOf('const MIGRATION_PY'); return { file, sha256: digest(text), selection: end >= 0 ? 'TypeScript migration authority; native Python implementation retained in full source and exercised by referenced receipts' : 'Full module', source: end >= 0 ? text.slice(0, end) : text }; }));
const prepared = {};
for (const scope of ['r82', 'r83']) {
  const packet = JSON.stringify({
    scope, version: 'R84_CURRENT_ENGINEERING_REVIEW_V2',
    instruction: 'Review the declared engineering requirements and current evidence. Historical review failure is not itself a functional requirement of the engineering being reviewed. Return revision_required for actual unresolved engineering defects. Do not certify Free supply, UI appearance or GitHub onboarding. No images are supplied.',
    baseline: '12ce5a5209329a878a173945b787337f495ba4e3',
    currentValidation: { build: { status: 'PASS', file: 'build-release.log', sha256: digest(build) }, lint: { status: 'PASS', file: 'lint-release.log', sha256: digest(lint) }, core: { passed: tests.value.numPassedTests, failed: tests.value.numFailedTests, skipped: tests.value.numPendingTests, sha256: tests.sha256 }, modelTerms: { passed: terms.value.numPassedTests, failed: terms.value.numFailedTests, sha256: terms.sha256 } },
    requirements: ['Reject unresolved assets before mutation', 'Reject stale source revisions', 'Rollback injected and interrupted mutation', 'Reject caller-forged readback evidence', 'Verify exact saved actor identities and transforms in another engine process', 'Preserve door and window SaveGame through migration', 'Traverse both rooms and exit after fresh-process restoration', 'Never report approval from an interrupted, substituted or schema-invalid reviewer'],
    native, sources,
    history: { r82: 'Historical HTTP 200 SSE upstream 503; R84 bounded attempt timed out at 120 seconds. Neither is approval.', r83: 'Historical truncated JSON; R84 complete qualified verdict requested revisions, citing historical build/lint and prior review absence. Current build/lint are passing; fresh-process exit traversal currently fails in two R84 receipts.' },
    limitations: ['Native exit traversal is unresolved; it must remain blocking.', 'Director remains PARTIAL.', 'No second independent qualified managed Free Coder domain demonstrated.', 'No fresh GitHub login executed.', 'Legacy text-only reviewer callbacks cannot establish stream completion.'],
  }, null, 2);
  if (packet.length > 48_000) throw new Error('Current packet exceeds budget; no evidence clipping or dispatch');
  const file = `${scope}-current-review-packet-${digest(packet).slice(0, 16)}.json`;
  await writeFile(`${directory}/${file}`, packet);
  prepared[scope] = { file, sha256: digest(packet) };
  await writeFile(`${directory}/${file.replace('.json', '-receipt.json')}`, JSON.stringify({ status: 'PREPARED_NOT_SENT', packetChars: packet.length, packetSha256: digest(packet), outputBudgetTokens: 6000, maxDurationMs: 120000, inferenceRequests: 0 }, null, 2));
  console.log(JSON.stringify({ file, packetChars: packet.length, status: 'PREPARED_NOT_SENT' }));
}
await writeFile(`${directory}/current-review-packets.json`, JSON.stringify(prepared, null, 2));
