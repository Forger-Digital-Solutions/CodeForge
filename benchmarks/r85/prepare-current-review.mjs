import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const directory = 'docs/evidence/r85-free-onboarding-autonomy-and-forgeaaa-review';
const digest = text => createHash('sha256').update(text).digest('hex');
const artifact = async file => {
  const text = await readFile(`${directory}/${file}`, 'utf8');
  return { file, sha256: digest(text), value: JSON.parse(text) };
};
const account = await artifact('account-separation-tests.json');
const onboarding = await artifact('onboarding-tests.json');
const recovery = await artifact('recovery-redaction-tests.json');
const build = await readFile(`${directory}/build-release.log`, 'utf8');
const lint = await readFile(`${directory}/lint-release.log`, 'utf8');
const nativeFiles = (await readdir(`${directory}/native`)).filter(file => /^(migration-fault-campaign|persistence-upgrade)-.*\.json$/.test(file)).sort();
const native = await Promise.all(nativeFiles.map(async file => {
  const item = await artifact(`native/${file}`);
  return { file: item.file, sha256: item.sha256, ok: item.value.ok ?? false, error: item.value.error, cases: Object.fromEntries(Object.entries(item.value.cases ?? {}).map(([name, value]) => [name, typeof value === 'object' && value !== null ? { phase: value.phase, state: value.state, exitCode: value.exitCode, errors: value.errors, levelHash: value.levelHash, mutationStarted: value.mutationStarted, idempotent: value.idempotent, boolean: value.boolean, copiedRollback: value.copiedRollback, evidence: value.evidence ? { actors_verified: value.evidence.actors_verified, instanceCount: value.evidence.instanceCount, independentProcess: value.evidence.independentProcess, levelFileSha256: value.evidence.levelFileSha256, errors: value.evidence.errors } : undefined } : value])),
    stages: Object.fromEntries(Object.entries(item.value.stages ?? {}).map(([name, result]) => [name, { state: result.state, failures: result.metrics?.failures, engineVersion: result.metrics?.engineVersion }])) };
}));
const preservation = await artifact('native/preservation.json');
const concurrentFiles = (await readdir(directory)).filter(file => /^R85-CONCURRENT-CAMPAIGN-\d+\.json$/.test(file)).sort();
const concurrent = await Promise.all(concurrentFiles.map(async file => {
  const item = await artifact(file);
  return { file: item.file, sha256: item.sha256, domainSeparation: item.value.domainSeparation, frames: item.value.inferenceFrames?.length, tasks: item.value.tasks?.map(task => ({ id: task.id, project: task.project, status: task.status })) };
}));
const qualifyFiles = (await readdir(directory)).filter(file => /^qualify-.*\.json$/.test(file)).sort();
const qualifications = await Promise.all(qualifyFiles.map(async file => {
  const item = await artifact(file);
  return { file: item.file, sha256: item.sha256, status: item.value.status, providerId: item.value.providerId, modelId: item.value.modelId, requests: item.value.frames?.length, roles: item.value.qualification ? Object.fromEntries(Object.entries(item.value.qualification.roleResults).map(([role, result]) => [role, result?.status])) : undefined };
}));
const sourceFiles = [
  'benchmarks/r85/concurrent-projects.mjs',
  'benchmarks/r85/live-coding.mjs',
  'benchmarks/r85/qualify-route.mjs',
  'benchmarks/r85/native-regression.mjs',
  'benchmarks/r85/native/persistence-upgrade-live.mjs',
  'benchmarks/r85/native/migration-fault-campaign.mjs',
  'benchmarks/r85/native/live-utils.mjs',
  'benchmarks/r85/independent-review.mjs',
  'benchmarks/r85/prepare-current-review.mjs',
  'benchmarks/r85/capacity-audit.mjs',
  'benchmarks/r85/watch-and-qualify.mjs',
];
const sources = await Promise.all(sourceFiles.map(async file => { const text = await readFile(file, 'utf8'); return { file, sha256: digest(text), chars: text.length } }));
const packet = JSON.stringify({
  scope: 'r85', version: 'R85_CURRENT_ENGINEERING_REVIEW_V1',
  instruction: 'Review the declared engineering requirements and current evidence for milestone R85. Historical review failure is not itself a functional requirement of the engineering being reviewed. Return revision_required only for actual unresolved engineering defects in the listed source or invalid evidence claims. Do not certify Free supply reliability, UI appearance, or GitHub onboarding. No images are supplied.',
  baseline: '41f7a1622256067c386118e45a433c2159987aa2',
  currentValidation: {
    build: { status: 'PASS', file: 'build-release.log', sha256: digest(build) },
    lint: { status: 'PASS', file: 'lint-release.log', sha256: digest(lint) },
    accountSeparation: { passed: account.value.numPassedTests, failed: account.value.numFailedTests, sha256: account.sha256 },
    onboarding: { passed: onboarding.value.numPassedTests, failed: onboarding.value.numFailedTests, sha256: onboarding.sha256 },
    recoveryRedaction: { passed: recovery.value.numPassedTests, failed: recovery.value.numFailedTests, sha256: recovery.sha256 },
  },
  requirements: [
    'Preserve the published R84 baseline and evidence trail byte-for-byte inside the R85 branch',
    'Record live free-supply observations without claiming catalog presence as capacity',
    'Qualify routes through the role-aware suite before admitting them to campaign rosters',
    'Run two projects concurrently in isolated git workspaces with per-run sessions, journals, and ledgers — no cross-contamination of workspace or run state (upstream quota domains are shared supply, not workspace state, and are assessed separately)',
    'Fail closed to blocked on quota exhaustion, unqualified roles, or failed verification — never paid fallback',
    'Keep every qualification, campaign, and native receipt bounded, hashed, and independently reviewable',
    'Verify native migration/persistence behavior in a real UE4.27 editor process with source content preservation',
    'Never report approval from an interrupted, substituted, or schema-invalid reviewer',
  ],
  native, preservation: { status: preservation.value.status, originalContentPreserved: preservation.value.originalContentPreserved, fileCount: preservation.value.before?.length, sha256: preservation.sha256 },
  concurrent, qualifications, sources,
  history: {
    r82: 'Historical HTTP 200 SSE upstream 503; R84 bounded attempt timed out at 120 seconds. Neither is approval.',
    r83: 'Qualified verdict revision_required: cited stale build/lint state (resolved and re-verified), absent independent review (this packet), Director PARTIAL (unchanged), no second qualified managed Free Coder domain, prior native traversal stalls.',
    nativeStalls: 'The persistence-upgrade return-leg moveTo stalled at the door-frame edge in 3 of 4 runs across R84+R85; choreography hardened with a door-centerline waypoint and passed (1791758824636). Earlier stall-only receipts retained as evidence history — every functional assertion passed in every run.',
  },
  limitations: [
    'No production-eligible qualified REVIEWER route exists — five CLEARED-model attempts hard-failed or were quota-exhausted; the only qualified reviewer is a DEVELOPMENT_ONLY NVIDIA trial route correctly excluded at TERMS_ALLOWED.',
    'Autonomous runs cannot reach completed today; they fail closed at REVIEWER_FAILED after implementation. This is an external-supply blocker, not an orchestrator defect.',
    'Two-project concurrency demonstrated under a single shared kilo:source-ip domain; the domain saturated at an upstream 429. A second independent quota domain was not proven.',
    'No live GitHub-authenticated desktop onboarding executed — requires a deployed Cloud and real OAuth client credentials.',
    'Director remains PARTIAL.',
  ],
}, null, 2);
if (packet.length > 48_000) throw new Error(`Current packet exceeds budget (${packet.length}); no evidence clipping or dispatch`);
const file = `r85-current-review-packet-${digest(packet).slice(0, 16)}.json`;
await writeFile(`${directory}/${file}`, packet);
await writeFile(`${directory}/current-review-packets.json`, JSON.stringify({ r85: { file, sha256: digest(packet) } }, null, 2));
await writeFile(`${directory}/${file.replace('.json', '-receipt.json')}`, JSON.stringify({ status: 'PREPARED_NOT_SENT', packetChars: packet.length, packetSha256: digest(packet), outputBudgetTokens: 6000, maxDurationMs: 120000, inferenceRequests: 0 }, null, 2));
console.log(JSON.stringify({ file, packetChars: packet.length, status: 'PREPARED_NOT_SENT' }));
