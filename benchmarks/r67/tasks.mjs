const testHeader = "import test from 'node:test';\nimport assert from 'node:assert/strict';\n";
export const tasks = [
  {
    id: 'bug-fix', taskClass: 'bug fix',
    goal: 'Inspect the retry queue and repair its attempt-boundary bug. Preserve the tests and public API. Verify the retry sequence, exhaustion and zero-budget cases.',
    files: {
      'src/retry.mjs': 'export function retryDelays(maxAttempts, baseMs) { const delays = []; for (let attempt = 0; attempt <= maxAttempts; attempt++) delays.push(baseMs * 2 ** attempt); return delays; }\n',
      'src/index.mjs': "export { retryDelays } from './retry.mjs';\n",
      'test/retry.test.mjs': testHeader + "import { retryDelays } from '../src/index.mjs';\ntest('bounded backoff', () => assert.deepEqual(retryDelays(3, 100), [100, 200, 400]));\ntest('zero retries', () => assert.deepEqual(retryDelays(0, 100), []));\ntest('one retry', () => assert.deepEqual(retryDelays(1, 7), [7]));\n",
    },
  },
  {
    id: 'feature', taskClass: 'small feature',
    goal: 'Add normalizeTags(values) to src/tags.mjs and re-export it from src/index.mjs. Trim and lowercase strings, remove empty entries and duplicates, and sort alphabetically. Use the existing normalization helper. Do not mutate input or modify tests.',
    files: {
      'src/normalize.mjs': "export const normalize = value => value.trim().toLowerCase();\n",
      'src/tags.mjs': "import { normalize } from './normalize.mjs';\nexport const tagLabel = value => normalize(value);\n",
      'src/index.mjs': "export { tagLabel } from './tags.mjs';\n",
      'test/tags.test.mjs': testHeader + "import * as api from '../src/index.mjs';\ntest('normalizes and deduplicates', () => assert.deepEqual(api.normalizeTags([' B ', 'a', '', 'b']), ['a', 'b']));\ntest('empty', () => assert.deepEqual(api.normalizeTags([]), []));\ntest('input preserved', () => { const input = ['z', ' a ']; api.normalizeTags(input); assert.deepEqual(input, ['z', ' a ']); });\n",
    },
  },
  {
    id: 'refactor', taskClass: 'refactor',
    goal: 'Extract the duplicated nonempty-string validation from src/user.mjs and src/project.mjs into src/validate.mjs. Both modules should import and use that shared helper. Preserve the exported API, error messages and behavior. Preserve tests.',
    files: {
      'src/user.mjs': "export function userName(value) { if (typeof value !== 'string' || !value.trim()) throw new TypeError('name required'); return value.trim(); }\n",
      'src/project.mjs': "export function projectName(value) { if (typeof value !== 'string' || !value.trim()) throw new TypeError('name required'); return value.trim(); }\n",
      'test/names.test.mjs': testHeader + "import { userName } from '../src/user.mjs';\nimport { projectName } from '../src/project.mjs';\nfor (const fn of [userName, projectName]) { test(fn.name + ' trims', () => assert.equal(fn(' ok '), 'ok')); test(fn.name + ' rejects', () => { for (const v of ['', ' ', null, 7]) assert.throws(() => fn(v), {name:'TypeError',message:'name required'}); }); }\n",
    },
  },
  {
    id: 'test-creation', taskClass: 'test creation',
    goal: 'Inspect parsePort in src/port.mjs and create meaningful Node tests in test/port.test.mjs covering valid boundaries, invalid syntax, and out-of-range values. Assert outputs and thrown errors. Do not change the implementation; no dependencies are needed.',
    files: {
      'src/port.mjs': "export function parsePort(input) { if (!/^\\d+$/.test(String(input))) throw new TypeError('invalid port'); const value = Number(input); if (value < 1 || value > 65535) throw new RangeError('port range'); return value; }\n",
      'test/smoke.test.mjs': testHeader + "import { parsePort } from '../src/port.mjs';\ntest('default port', () => assert.equal(parsePort('8080'), 8080));\n",
    },
  },
  {
    id: 'debugging', taskClass: 'debugging',
    goal: 'Diagnose why the cache tests fail. Inspect the implementation and failure output, then repair the contained bug while preserving the API and all existing tests. Explain the cause in the result.',
    files: {
      'src/cache.mjs': 'export function fresh(entry, nowMs) { return Boolean(entry) && entry.expiresAt >= nowMs; }\n',
      'test/cache.test.mjs': testHeader + "import { fresh } from '../src/cache.mjs';\ntest('future entry', () => assert.equal(fresh({expiresAt:1001},1000),true));\ntest('expired entry', () => assert.equal(fresh({expiresAt:999},1000),false));\ntest('boundary', () => assert.equal(fresh({expiresAt:1000},1000),false));\ntest('missing', () => assert.equal(fresh(null,1000),false));\n",
    },
  },
  {
    id: 'configuration', taskClass: 'configuration/build issue',
    goal: 'Repair the package exports configuration so the named package subpath r66-public-package/helpers resolves to the existing src/helpers.mjs. Preserve implementation and tests and verify package self-reference works.',
    package: { name: 'r66-public-package', exports: { './helpers': './src/missing.mjs' } },
    files: {
      'src/helpers.mjs': "export const joinKey = (prefix, value) => `${prefix}:${value}`;\n",
      'test/exports.test.mjs': testHeader + "test('package exports', async () => { const { joinKey } = await import('r66-public-package/helpers'); assert.equal(joinKey('task','42'), 'task:42'); });\n",
    },
  },
];

export function taskAt(index) {
  const source = tasks[index % tasks.length];
  return { ...source, id: `${String(index + 1).padStart(2, '0')}-${source.id}`, ordinal: index + 1 };
}
