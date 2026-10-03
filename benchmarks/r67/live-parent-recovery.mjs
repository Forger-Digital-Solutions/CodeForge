import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createSessionPersistence } from '@codeforge/sessions';
const exec = promisify(execFile);
const root = await mkdtemp(path.resolve('benchmarks/r67/tmp/parent-recovery-'));
const repo = path.join(root, 'repo');
await mkdir(path.join(repo, 'test'), { recursive: true });
await writeFile(path.join(repo, 'math.mjs'), 'export function multiply(a, b) { return 0; }\n');
await writeFile(path.join(repo, 'test/math.test.mjs'), "import test from 'node:test'; import assert from 'node:assert/strict'; import { multiply } from '../math.mjs'; test('multiply', () => assert.equal(multiply(6,7),42));\n");
for (const args of [['init'], ['config', 'user.name', 'CodeForge Recovery'], ['config', 'user.email', 'recovery@codeforge.invalid'], ['config', 'commit.gpgsign', 'false'], ['add', '.'], ['commit', '-m', 'Public recovery baseline']]) await exec('git', args, { cwd: repo, windowsHide: true });
const dbPath = path.join(root, 'session.db');
const evidence = { startedAt: new Date().toISOString(), evidenceClass: 'ACTUAL_PROCESS_KILL_LIVE_FREE_PROVIDER_PARENT_END_TO_END', root, workspacePath: repo, dbPath, steps: [], status: 'RUNNING', liveRecovery: 'RUNNING' };
const output = process.argv[2] ?? 'docs/evidence/r67-everyday-completion-reliability/R67-PARENT-RECOVERY-LIVE.json';
try {
  for (const mode of ['kill-reviewer', 'recover']) {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['benchmarks/r67/live-parent-worker.mjs', mode, dbPath, repo, path.join(root, 'worktrees')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += String(chunk); }); child.stderr.on('data', chunk => { stderr += String(chunk); });
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Recovery fixture timeout')); }, 900000);
      child.on('error', reject); child.on('exit', (exitCode, signal) => { clearTimeout(timer); resolve({ mode, exitCode, signal, stdout, stderr }); });
    });
    evidence.steps.push(result);
    if (mode === 'kill-reviewer') {
      assert.match(result.stdout, /CRASH_REVIEWER/);
      const initial = createSessionPersistence({ dbPath }); await initial.init();
      evidence.recordedWritesBeforeRestart = (await initial.getWorkItemsByKind('agent_tool_execution')).filter(item => item.executionClass === 'write' && item.state === 'observation_recorded');
      await initial.close();
      assert(evidence.recordedWritesBeforeRestart.length > 0);
    } else assert.equal(result.exitCode, 0, result.stdout + result.stderr);
  }
  const db = createSessionPersistence({ dbPath }); await db.init();
  evidence.workers = await db.getWorkItemsByKind('subagent_run');
  evidence.recoveryReceipts = await db.getWorkItemsByKind('autonomous_parent_recovery');
  const writes = (await db.getWorkItemsByKind('agent_tool_execution')).filter(item => item.executionClass === 'write' && item.state === 'observation_recorded');
  evidence.observedWrites = writes.length;
  evidence.shillingEntries = (await db.getWorkItemsByKind('shilling_entry')).length;
  await db.close();
  evidence.integratedSource = await readFile(path.join(repo, 'math.mjs'), 'utf8');
  assert.equal(new Set(writes.map(row => row.argumentsHash)).size, writes.length);
  assert(evidence.recordedWritesBeforeRestart.every(before => writes.some(after => after.id === before.id && after.argumentsHash === before.argumentsHash)));
  evidence.recordedMutationReplays = writes.filter(after => evidence.recordedWritesBeforeRestart.some(before => before.id !== after.id && before.argumentsHash === after.argumentsHash)).length;
  assert.equal(evidence.recordedMutationReplays, 0);
  assert.match(evidence.integratedSource, /a \* b/);
  evidence.result = JSON.parse(await readFile(dbPath + '.recovered.json', 'utf8'));
  evidence.liveRecovery = 'PROVEN';
  evidence.status = 'PASS';
} catch (error) { evidence.status = 'FAIL'; evidence.error = String(error); process.exitCode = 1; }
evidence.finishedAt = new Date().toISOString();
await writeFile(output, JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify({ status: evidence.status, error: evidence.error, output }));
