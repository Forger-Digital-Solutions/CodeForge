import { tasks as existing } from '../r67/tasks.mjs';

const header = "import test from 'node:test';\nimport assert from 'node:assert/strict';\n";
export const tasks = [...existing, {
  id: 'multi-file', taskClass: 'multi-file change',
  goal: 'Add encodeKey(prefix, value) and decodeKey(key) to the two existing source modules and re-export both from src/index.mjs. Encode each part with encodeURIComponent and join using a colon. Decode the two encoded parts into an array. Preserve all acceptance tests.',
  files: {
    'src/encode.mjs': 'export const encodeKey = () => "";\n',
    'src/decode.mjs': 'export const decodeKey = () => [];\n',
    'src/index.mjs': 'export {};\n',
    'test/key.test.mjs': header + "import { encodeKey, decodeKey } from '../src/index.mjs';\ntest('roundtrip', () => { const key = encodeKey('a:b', 'c d'); assert.equal(key, 'a%3Ab:c%20d'); assert.deepEqual(decodeKey(key), ['a:b', 'c d']); });\ntest('empty parts', () => assert.deepEqual(decodeKey(encodeKey('', '')), ['', '']));\n",
  },
}, {
  id: 'multi-package', taskClass: 'multi-package change',
  goal: 'Repair the common clamp helper to honor both inclusive bounds, then update the client package to import it rather than duplicating clamping. Preserve package public exports and all acceptance tests. No dependency installation is required.',
  files: {
    'packages/common/package.json': '{"name":"public-common","type":"module","exports":"./index.mjs"}\n',
    'packages/common/index.mjs': 'export const clamp = (value, min, max) => Math.min(value, max);\n',
    'packages/client/package.json': '{"name":"public-client","type":"module","exports":"./index.mjs"}\n',
    'packages/client/index.mjs': 'export const progress = value => Math.min(value, 100);\n',
    'test/progress.test.mjs': header + "import { clamp } from '../packages/common/index.mjs';\nimport { progress } from '../packages/client/index.mjs';\ntest('bounds', () => { assert.equal(clamp(-4, 0, 100), 0); assert.equal(clamp(104, 0, 100), 100); assert.equal(clamp(40, 0, 100), 40); });\ntest('client', () => { assert.equal(progress(-3), 0); assert.equal(progress(120), 100); assert.equal(progress(20), 20); });\n",
  },
}];

export function taskAt(index) {
  const source = tasks[index % tasks.length];
  return { ...source, id: `${String(index + 1).padStart(2, '0')}-${source.id}`, ordinal: index + 1 };
}
