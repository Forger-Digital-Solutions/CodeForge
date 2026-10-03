import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const start = JSON.parse(await readFile('docs/evidence/r67-everyday-completion-reliability/R67-START-STATE.json', 'utf8'));
const baseline = execFileSync('git', ['show', `${start.head}:packages/terminal/src/pty-loader.ts`], { encoding: 'utf8' });
const baselinePath = resolve('benchmarks/r67/tmp/baseline-pty-loader.mjs');
await writeFile(baselinePath, ts.transpileModule(baseline, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText);
const fixture = await readFile('packages/terminal/test/fixtures/conpty-reader-close.mjs', 'utf8');
const baselineFixture = resolve('benchmarks/r67/tmp/baseline-reader-close.mjs');
await writeFile(baselineFixture, fixture.replace('../../dist/pty-loader.js', pathToFileURL(baselinePath).href));
const run = file => {
  const result = spawnSync(process.execPath, [file], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  return { exitCode: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim(), error: result.error?.message };
};
const before = run(baselineFixture);
const after = run('packages/terminal/test/fixtures/conpty-reader-close.mjs');
assert.equal(before.exitCode, 1);
assert(before.stderr.includes('Output socket closed while its reader worker was still alive'));
assert.equal(after.exitCode, 0);
const evidence = { at: new Date().toISOString(), status: 'PASS', evidenceClass: 'REAL_NODE_PTY_READER_WORKER_CONTROLLED_SOCKET_LIFECYCLE',
  baselineRevision: start.head, before, after,
  limitation: 'The full suite observed EPIPE. This controlled regression reproduces premature socket teardown with the actual reader worker; the isolated stress fixture did not reproduce EPIPE itself.' };
await writeFile('docs/evidence/r67-everyday-completion-reliability/R67-CONPTY-READER-LIFECYCLE.json', `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify({ status: evidence.status, baselineExit: before.exitCode, fixedExit: after.exitCode }));
