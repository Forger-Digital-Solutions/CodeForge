import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { execFile as callback } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { createKiloFreeDirectAdapter } from '@codeforge/providers';
import { reverifyKiloPolicy } from '@codeforge/model-registry';
import { ROLE_PROMPTS, REVIEWER_CLEAN_DIFF_INSTRUCTION, REVIEWER_TEMPERATURE, formatUntrustedData, validateStructuredAgentResult } from '@codeforge/agent';
import { buildReviewerEvidenceSnapshot, assertReviewerEvidenceCurrent } from '../../packages/server/dist/reviewer-evidence.js';

const execFile = promisify(callback);
const model = 'nvidia/nemotron-3-ultra-550b-a55b:free';
const directory = 'docs/evidence/r74-autonomous-completion-and-free-reliability';
const report = { startedAt: new Date().toISOString(), evidenceClass: 'LIVE_HELD_OUT_PUBLIC_CODE_REVIEW', model, cases: [], status: 'RUNNING' };
const output = `${directory}/held-out-review-${Date.now()}.json`;
const persist = () => writeFile(output, JSON.stringify(report, null, 2) + '\n');
const adapter = createKiloFreeDirectAdapter();
const header = "import test from 'node:test';\nimport assert from 'node:assert/strict';\n";
const resourceBase = 'export async function withPermit(pool, job) { const permit = pool.acquire(); return await job(permit); }\n';
const resourceFixed = 'export async function withPermit(pool, job) { const permit = pool.acquire(); try { return await job(permit); } finally { pool.release(permit); } }\n';
const resourceTests = header + "import { withPermit } from '../src/permit.mjs';\nfor (const fails of [false, true]) test('release after '+fails, async () => { const held = new Set(); const pool = { acquire() { const p = {}; held.add(p); return p; }, release(p) { held.delete(p); } }; try { await withPermit(pool, async () => { if (fails) throw new Error('job failed'); return 42; }); } catch (e) { assert.equal(e.message, 'job failed'); } assert.equal(held.size, 0); });\n";
const tenantBase = 'export function lookup(rows, ownerId, key) { return rows.find(row => row.key === key); }\n';
const tenantFixed = 'export function lookup(rows, ownerId, key) { return rows.find(row => row.ownerId === ownerId && row.key === key); }\n';
const tenantTests = header + "import { lookup } from '../src/store.mjs';\nconst rows = [{ownerId:'alice',key:'same',value:'private'},{ownerId:'bob',key:'same',value:'own'}];\ntest('owner isolation', () => assert.equal(lookup(rows,'bob','same').value,'own'));\ntest('missing owner', () => assert.equal(lookup(rows,'carol','same'),undefined));\n";
const cases = [
  { id: 'permit-cleanup-fix', intent: 'Ensure every acquired permit is released once on both fulfilled and rejected jobs. Preserve result and error propagation.', file: 'permit', before: resourceBase, after: resourceFixed, tests: resourceTests, expected: 'pass' },
  { id: 'permit-rejection-leak', intent: 'Refactor permit cleanup while preserving release on both fulfilled and rejected jobs and propagating the job result or error.', file: 'permit', before: resourceFixed, after: 'export async function withPermit(pool, job) { const permit = pool.acquire(); const result = await job(permit); pool.release(permit); return result; }\n', tests: resourceTests, expected: 'revision_required' },
  { id: 'tenant-isolation-fix', intent: 'Lookup must return only a row owned by ownerId with the requested key. Return undefined for an absent owner. Preserve tests.', file: 'store', before: tenantBase, after: tenantFixed, tests: tenantTests, expected: 'pass' },
  { id: 'tenant-isolation-regression', intent: 'Simplify lookup while preserving owner isolation and the requested key. Preserve tests.', file: 'store', before: tenantFixed, after: tenantBase, tests: tenantTests, expected: 'revision_required' },
];
try {
  const policy = await reverifyKiloPolicy(report.startedAt);
  report.policy = policy;
  if (policy.status !== 'VERIFIED') throw new Error('CURRENT_POLICY_REQUIRED');
  report.catalog = (await adapter.listModels()).find(row => row.modelId === model && row.isFree && row.freeStatus === 'verified_free');
  if (!report.catalog) throw new Error('CURRENT_EXACT_ZERO_MODEL_REQUIRED');
  await mkdir('benchmarks/r74/tmp', { recursive: true });
  for (const caze of cases) {
    const workspace = await mkdtemp(path.resolve('benchmarks/r74/tmp/held-out-'));
    await mkdir(path.join(workspace, 'src'));
    await mkdir(path.join(workspace, 'test'));
    const files = ['package.json', `src/${caze.file}.mjs`, `test/${caze.file}.test.mjs`];
    await writeFile(path.join(workspace, files[0]), '{"type":"module","private":true}\n');
    await writeFile(path.join(workspace, files[1]), caze.before);
    await writeFile(path.join(workspace, files[2]), caze.tests);
    for (const args of [['init'], ['config', 'user.name', 'CodeForge Held Out'], ['config', 'user.email', 'fixture@codeforge.invalid'], ['config', 'commit.gpgsign', 'false'], ['add', '.'], ['commit', '-m', 'Held out baseline']]) await execFile('git', args, { cwd: workspace, windowsHide: true });
    const baseRevision = (await execFile('git', ['rev-parse', 'HEAD'], { cwd: workspace })).stdout.trim();
    await writeFile(path.join(workspace, files[1]), caze.after);
    const diff = (await execFile('git', ['diff'], { cwd: workspace })).stdout;
    const tests = await execFile(process.execPath, ['--test'], { cwd: workspace }).then(r => ({ exitCode: 0, output: r.stdout })).catch(e => ({ exitCode: e.code, output: e.stdout }));
    const snapshot = await buildReviewerEvidenceSnapshot({ workspacePath: workspace, baseRevision, diff, files, verificationCommands: ['node --test'] });
    if (!snapshot.binding.complete) throw new Error('COMPLETE_BOUND_PACKET_REQUIRED');
    const record = { id: caze.id, expected: caze.expected, workspace, baseRevision, diff, tests, snapshot, events: [] };
    report.cases.push(record);
    record.request = { model, messages: [{ role: 'system', content: ROLE_PROMPTS.reviewer.systemPromptTemplate + '\n' + REVIEWER_CLEAN_DIFF_INSTRUCTION }, { role: 'user', content: `Goal:\n${caze.intent}\n\n${formatUntrustedData(snapshot.context, 'workspace review snapshot')}` }], temperature: REVIEWER_TEMPERATURE, maxTokens: 2048 };
    await persist();
    for await (const event of adapter.streamChat(record.request, AbortSignal.timeout(60_000))) record.events.push(event);
    assertReviewerEvidenceCurrent(snapshot.binding, workspace, snapshot.context);
    record.validation = validateStructuredAgentResult('reviewer', record.events.filter(e => e.type === 'text_delta').map(e => e.delta).join(''));
    record.servedModel = record.events.findLast(e => e.type === 'finish')?.model;
    record.passed = record.servedModel === model && record.validation.success && record.validation.data.verdict === caze.expected && (tests.exitCode === 0) === (caze.expected === 'pass');
    await persist();
    console.log(JSON.stringify({ case: caze.id, passed: record.passed, verdict: record.validation.data?.verdict, tests: tests.exitCode }));
    if (!record.passed) { report.stopReason = 'HELD_OUT_REVIEW_FAILED'; break; }
  }
  report.status = report.cases.length === cases.length && report.cases.every(row => row.passed) ? 'PASS' : 'FAIL';
} catch (error) { report.status = 'BLOCKED'; report.error = { message: error.message, code: error.code, status: error.status }; }
report.finishedAt = new Date().toISOString();
await persist();
console.log(JSON.stringify({ output, status: report.status, cases: report.cases.length }));
