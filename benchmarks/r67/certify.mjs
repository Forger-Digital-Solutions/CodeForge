import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { directory, read, sourcePaths, evidencePaths } from './release-artifacts.mjs';
const production = process.argv[2] === 'production';
const suite = await read('R67-REPOSITORY-TESTS');
assert.equal(suite.status, 'PASS'); assert.equal(suite.totals.failed, 0); assert(suite.repositoryWideGreen);
assert.equal(suite.phases.length, 6);
assert(suite.phases.every(phase => phase.status === 'PASS' && phase.exitCode === 0));
const build = await read('R67-WORKSPACE-BUILD-certified');
assert.equal(build.exitCode, 0); assert.equal(build.status, 'PASS');
const audit = await read('R67-CANONICAL-AUDIT');
assert.equal(audit.status, 'PASS'); assert.equal(audit.campaigns[0].completed, 6); assert.equal(audit.campaigns[1].completed, 3);
const frozen = await read('R67-SOURCE-FREEZE');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
assert((await Promise.all(frozen.files.map(async row => digest(await readFile(row.path)) === row.sha256))).every(Boolean));
const sourceState = JSON.parse(await readFile('docs/codeforge-forgegreen-certified-source-state.json', 'utf8'));
assert.equal(sourceState.sourceStateId, frozen.sourceStateId);
for (const name of ['R67-SERVER-PARENT-RECOVERY-LIVE-certified', 'R67-REVIEWER-RECOVERY-LIVE-certified', 'R67-DATABASE-RECOVERY-CERTIFICATION']) assert.equal((await read(name)).status, 'PASS');
for (const name of ['429', '503', 'SOCKET']) assert.equal((await read(`R67-PROVIDER-${name}-RECOVERY`)).status, 'PASS_CONTROLLED_LIVE_ROLE_RECOVERY');
const canaries = await read('R67-SOURCE-CANARIES-batched');
assert.equal(canaries.numFailedTests, 0); assert.equal(canaries.numPassedTests, 9);
const windows = await read('R67-WINDOWS-CERTIFIED-IDLE-RESTART');
assert.equal(windows.status, 'PASS_UNAUTHENTICATED_IDLE_RESTART');
assert.equal(windows.manifest.channel, 'production');
assert.equal(windows.backendHealth.status, 200); assert.equal(windows.backendHealthAfterRestart.status, 200);
assert.equal(windows.endpointConsistency.matches, true);
assert.equal(windows.runtimeStatusAfterRestart.recoverable, true);
assert.equal(windows.runtimeStatusAfterRestart.activeWork, false);
assert.equal(windows.runtimeStatusAfterRestart.unrecoverableResources.length, 0);
assert.equal(windows.authenticatedTaskGate, 'HUMAN_AUTH_REQUIRED');
const packageAudit = await read('R67-WINDOWS-PACKAGE-BYTE-AUDIT');
assert.equal(packageAudit.status, 'PASS'); assert.equal(packageAudit.runtimeModulesCompared, 13);
assert.equal(packageAudit.runtimeSourceStateId, frozen.sourceStateId);
assert.equal(packageAudit.runtimeSourceAggregateSha256, frozen.sourceAggregateSha256);
assert.equal(packageAudit.identity.commit, windows.identity.commit);
assert.equal((await read('R67-EVIDENCE-SECRET-SCAN')).status, 'PASS');
assert.equal((await read('R67-SOURCE-SECRET-SCAN-final')).ownerReviewRequired.length, 0);
const start = await read('R67-START-STATE');
for (const file of start.preservedFiles) assert.equal(digest(await readFile(file.path)), file.sha256);
let runtimeRevision;
if (production) {
  const deployment = await read('R67-PRODUCTION-DEPLOYMENT');
  const smoke = await read('R67-PRODUCTION-FINAL');
  assert.equal(deployment.status, 'live'); assert.equal(smoke.status, 'PASS');
  runtimeRevision = deployment.commit;
  assert.equal(smoke.endpoints[0].body.deployment.commit, runtimeRevision);
  assert.equal(windows.identity.commit, runtimeRevision);
}
const prior = await read('source-certification').catch(() => undefined);
const rows = async paths => Promise.all(paths.map(async path => ({ path, sha256: digest(await readFile(path)) })));
const sourceFiles = await rows(await sourcePaths());
const evidenceFiles = await rows(await evidencePaths());
const aggregate = entries => digest(JSON.stringify(entries.map(({ path, sha256 }) => [path, sha256])));
const certificate = { certificateId: 'r67-everyday-completion-reliability-v1', schemaVersion: 'free-capacity-source-certification/v1',
  certifiedAt: new Date().toISOString(), implementationBase: start.head,
  implementationHead: runtimeRevision ?? prior?.implementationHead ?? 'PENDING_IMPLEMENTATION_COMMIT',
  sourceStateId: frozen.sourceStateId, runtimeSourceAggregateSha256: frozen.sourceAggregateSha256,
  closureStatus: production ? 'CODEFORGE_R67_CLOSED' : 'SOURCE_CERTIFIED_DEPLOYMENT_PENDING',
  certificateMeaning: 'Exact source/evidence byte integrity, final canonical validation and measured public-fixture runtime reliability. Backend/runtime closure permits only the isolated authenticated Windows task to remain human-dependent.',
  validation: { repositoryWideStatus: suite.status, repositoryWideExactTotalsExcludingStandaloneCertificateCanary: suite.totals,
    workspaceBuild: build.status, sourceIdentityCanaries: { passed: canaries.numPassedTests, failed: canaries.numFailedTests }, certificateCanary: 'RUN_SEPARATELY_AFTER_EVIDENCE_FREEZE' },
  mandatoryGates: { canonicalLive: 'PASS_6_OF_6', concurrency: 'PASS_3_OF_3', falseCompletion: 'NONE_OBSERVED',
    roleScopedQuality: 'PASS', explorerOutputBudget: 'PASS_NO_FINAL_EXPLORER_OUTPUT_CAP_BLOCKS',
    parentAndServerRecovery: 'PASS_ACTUAL_PROCESS_KILL', providerFaults: 'PASS_CONTROLLED_LIVE_RECOVERY_WITHIN_ELIGIBLE_SUPPLY',
    databaseRecovery: 'PASS_PRODUCTION_CLAIM_PATH_ISOLATED_STATE', validation: 'PASS',
    windowsStartupIdleRestart: 'PASS', authenticatedWindowsTask: 'HUMAN_AUTH_REQUIRED',
    production: production ? 'PASS_EXACT_RUNTIME_REVISION' : 'PENDING' },
  limitations: ['Only Kilo anonymous PUBLIC_IP supply is eligible; independent physical quota domains are not verified. Horde remains ineligible after fresh failed qualification.',
    'Final software tasks complete 6/6; preliminary Explorers complete 5/6. CSV Explorer returned complete JSON with invalid line=0 and remains rejected. Bounded normal-topology fallback does not count that output as valid evidence; independent review and real verification still authorize task completion.',
    '429/503/reset faults are controlled adapter-boundary faults with actual live calls, not naturally occurring outages or proven live cross-provider failover.',
    'Production HostedQueueWorker/HostedAdmissionAuthority are exercised against isolated SQLite state with actual loopback connectivity failure; no production Postgres outage is claimed.',
    'Six public engineering fixtures and three concurrent users do not prove unlimited task complexity or indefinite provider availability. Monetary billing remains UNKNOWN.',
    'Actual Windows production-channel startup/renderer/backend/idle/restart passed; authenticated packaged coding remains HUMAN_AUTH_REQUIRED.',
    'Canonical test execution retains six pre-existing user files; they are hash-audited and excluded from the R67 commit. The recovery fixture addition affects only an unused recover: entry point, not canonical crash cases.'],
  sourceFiles, sourceAggregateSha256: aggregate(sourceFiles), evidenceFiles, evidenceAggregateSha256: aggregate(evidenceFiles) };
await writeFile(`${directory}/source-certification.json`, `${JSON.stringify(certificate, null, 2)}\n`);
execFileSync(process.execPath, ['scripts/free-capacity-certificate.mjs', '--verify'], { stdio: 'inherit' });
console.log(JSON.stringify({ closureStatus: certificate.closureStatus, sourceFiles: sourceFiles.length, evidenceFiles: evidenceFiles.length, sourceStateId: certificate.sourceStateId }));
