import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { directory, read } from './release-artifacts.mjs';
const certificate = await read('source-certification');
const start = await read('R67-START-STATE');
const preserved = new Set(start.preservedFiles.map(file => file.path));
const ownedExtras = ['source-certification.json', 'R67-CERTIFICATE-CANARY.json', 'R67-CERTIFICATE-CANARY-final.json',
  'R67-EVIDENCE-SECRET-SCAN.json', 'R67-FINAL-SOURCE-PRESERVATION.json', 'R67-STAGE-AUDIT.json'].map(file => `${directory}/${file}`);
const all = [...certificate.sourceFiles, ...certificate.evidenceFiles];
const allowed = new Set([...all.map(file => file.path), ...ownedExtras]);
const staged = execFileSync('git', ['diff', '--cached', '--name-only', '-z']).toString('utf8').split('\0').filter(Boolean);
assert(staged.length > 0);
assert(staged.every(file => allowed.has(file) && !preserved.has(file)), 'UNAUTHORIZED_STAGED_FILE');
const files = [...all, { path: `${directory}/source-certification.json`, sha256: createHash('sha256').update(await readFile(`${directory}/source-certification.json`)).digest('hex') }];
const bytes = execFileSync('git', ['cat-file', '--batch'], { input: files.map(file => `:${file.path}`).join('\n') + '\n', maxBuffer: 128 * 1024 * 1024 });
let offset = 0;
for (const file of files) {
  const boundary = bytes.indexOf(10, offset);
  const header = bytes.subarray(offset, boundary).toString('utf8');
  const match = /^[0-9a-f]+ blob (\d+)$/.exec(header);
  assert(match, `INDEX_OBJECT_UNAVAILABLE:${file.path}`);
  const size = Number(match[1]);
  const content = bytes.subarray(boundary + 1, boundary + 1 + size);
  assert.equal(createHash('sha256').update(content).digest('hex'), file.sha256, `INDEX_BYTE_MISMATCH:${file.path}`);
  offset = boundary + size + 2;
}
assert.equal(offset, bytes.length);
for (const file of start.preservedFiles) assert.equal(createHash('sha256').update(await readFile(file.path)).digest('hex'), file.sha256);
const result = { at: new Date().toISOString(), status: 'PASS', stagedFiles: staged, stagedCount: staged.length,
  certificateSourceAndEvidenceObjectsChecked: files.length, exactIndexBytesMatchCertificate: true,
  preservedFilesStaged: 0, preservedFilesStillMatch: true, matchedSecretValuesPrinted: false };
await writeFile(`${directory}/R67-STAGE-AUDIT.json`, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ status: result.status, stagedCount: staged.length, checked: files.length }));
