import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { read, directory } from './release-artifacts.mjs';
const before = await read('R67-SOURCE-FREEZE-before-watchdog-synchronization');
const after = await read('R67-SOURCE-FREEZE');
const old = new Map(before.files.map(row => [row.path, row.sha256]));
const next = new Map(after.files.map(row => [row.path, row.sha256]));
const added = after.files.filter(row => !old.has(row.path)).map(row => row.path);
const removed = before.files.filter(row => !next.has(row.path)).map(row => row.path);
const changed = after.files.filter(row => old.has(row.path) && old.get(row.path) !== row.sha256).map(row => row.path);
assert.equal(removed.length, 0);
assert.deepEqual([...added, ...changed], ['packages/server/test/progress-watchdog.test.ts']);
const runtimePaths = before.files.filter(row => /^(?:packages|apps)\/.*\/src\//.test(row.path));
assert(runtimePaths.every(row => next.get(row.path) === row.sha256));
const output = { at: new Date().toISOString(), status: 'PASS', beforeSourceStateId: before.sourceStateId,
  afterSourceStateId: after.sourceStateId, beforeFreezeAt: before.at, afterFreezeAt: after.at,
  addedMaterialPaths: added, removedMaterialPaths: removed, changedMaterialPaths: changed,
  runtimeImplementationFilesCompared: runtimePaths.length, runtimeImplementationChanged: false,
  claim: 'The current live campaign and recoveries use identical runtime implementation bytes before/after the test-only synchronization. The full canonical suite reruns on the final expanded material set.' };
await writeFile(`${directory}/R67-TEST-ONLY-SOURCE-DELTA.json`, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify(output));
