import { readFile, writeFile, readdir } from 'node:fs/promises';
import { checkFreeCapacityCertificate } from '../../scripts/free-capacity-certificate.mjs';

const directory = 'docs/evidence/r66-everyday-free-readiness';
const tests = JSON.parse(await readFile(`${directory}/R66-REPOSITORY-TESTS.json`, 'utf8'));
const build = JSON.parse(await readFile(`${directory}/R66-WORKSPACE-BUILD.json`, 'utf8'));
if (!tests.repositoryWideGreen || build.status !== 'PASS') throw new Error('GREEN_VALIDATION_REQUIRED');
const head = process.argv[2];
if (!/^[a-f0-9]{40}$/.test(head ?? '')) throw new Error('RUNTIME_COMMIT_REQUIRED');
const previous = JSON.parse(await readFile('docs/evidence/free-capacity-fabric/source-certification.json', 'utf8'));
const state = JSON.parse(await readFile('docs/codeforge-forgegreen-certified-source-state.json', 'utf8'));
const sourcePaths = [...new Set([...previous.sourceFiles.map((entry) => entry.path),
  'packages/server/src/autonomous-orchestrator.ts', 'packages/server/test/r54-quality-handoff.test.ts',
  'packages/eight-bit/src/qualification/role-protocols.ts', 'packages/eight-bit/src/qualification/role-suite.ts',
  'packages/eight-bit/test/role-qualification.test.ts', 'packages/server/src/experience-learning.ts',
  'scripts/security/secret-scan.mjs', ...(await readdir('benchmarks/r66')).filter((name) => name.endsWith('.mjs')).map((name) => `benchmarks/r66/${name}`),
])].sort();
const excluded = new Set(['source-certification.json', 'R66-FINAL-CANARIES.json', 'R66-CERTIFICATE-VERIFICATION.json']);
const evidencePaths = (await readdir(directory)).filter((name) => !excluded.has(name) && /^R66-/.test(name) && /\.(json|md)$/.test(name)).map((name) => `${directory}/${name}`).sort();
const certificate = { certificateId: 'r66-everyday-free-readiness-v1', schemaVersion: 'free-capacity-source-certification/v1', certifiedAt: new Date().toISOString(), implementationBase: '8b436277e6ebbb9620a4e61b085a447e96045727', implementationHead: head, sourceStateId: state.sourceStateId,
  closureStatus: 'PARTIAL', certificateMeaning: 'Source and evidence byte integrity with green repository validation. Everyday-use mandatory gates remain incomplete; this is not a CLOSED readiness certificate.',
  validation: { repositoryWideStatus: 'PASS', repositoryWideExactTotalsExcludingStandaloneCertificateCanary: tests.totals, workspaceBuild: 'PASS', certificateCanary: 'RUN_SEPARATELY_AFTER_FREEZE' },
  mandatoryGates: JSON.parse(await readFile(`${directory}/R66-CLOSURE-GATES.json`, 'utf8')),
  sourceFiles: sourcePaths.map((path) => ({ path, sha256: '' })), evidenceFiles: evidencePaths.map((path) => ({ path, sha256: '' })),
  limitation: 'Qualification fixtures improved, but ordinary autonomous review/exploration remains unreliable. Repeated parent kill/resume, sustained consecutive completion, and authenticated multi-task Windows daily use are not certified. Simulations are explicitly separate from live outcomes. Unknown billing measurements remain UNKNOWN. Historical R65 certificate is preserved.',
};
const checked = await checkFreeCapacityCertificate(certificate);
Object.assign(certificate, { sourceFiles: checked.sourceFiles, evidenceFiles: checked.evidenceFiles, sourceAggregateSha256: checked.sourceAggregateSha256, evidenceAggregateSha256: checked.evidenceAggregateSha256 });
await writeFile(`${directory}/source-certification.json`, `${JSON.stringify(certificate, null, 2)}\n`);
console.log(JSON.stringify({ certificateId: certificate.certificateId, closureStatus: certificate.closureStatus, sourceFiles: certificate.sourceFiles.length, evidenceFiles: certificate.evidenceFiles.length }));
