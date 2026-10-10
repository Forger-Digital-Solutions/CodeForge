import assert from 'node:assert/strict';
import { spawn, execFile as callback } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createSessionPersistence } from '@codeforge/sessions';
import { taskAt } from '../r71/tasks.mjs';
import { snapshotSource } from './source-snapshot.mjs';
const execFile = promisify(callback);
const directory = 'docs/evidence/r74-autonomous-completion-and-free-reliability';
const output = `${directory}/R74-PARENT-RECOVERY-LIVE.json`;
const root = await mkdtemp(path.resolve('benchmarks/r74/tmp/parent-recovery-'));
const workspacePath = path.join(root, 'repo');
const task = taskAt(0);
for (const [file, content] of Object.entries(task.files)) { await mkdir(path.dirname(path.join(workspacePath, file)), { recursive: true }); await writeFile(path.join(workspacePath, file), content); }
await writeFile(path.join(workspacePath, 'package.json'), JSON.stringify({ name: 'r74-recovery-public-fixture', private: true, type: 'module', scripts: { test: 'node --test' }, ...task.package }));
for (const args of [['init'], ['config', 'user.name', 'CodeForge Recovery'], ['config', 'user.email', 'recovery@codeforge.invalid'], ['config', 'commit.gpgsign', 'false'], ['add', '.'], ['commit', '-m', 'Public R74 recovery baseline']]) await execFile('git', args, { cwd: workspacePath, windowsHide: true });
const source = await snapshotSource();
await writeFile(`${directory}/R74-PARENT-RECOVERY-LIVE-source.json`, `${JSON.stringify(source, null, 2)}\n`);
const dbPath = path.join(root, 'session.db');
const evidence = { startedAt: new Date().toISOString(), evidenceClass: 'REAL_PROCESS_INTERRUPTION_WITH_LIVE_ANONYMOUS_FREE_ROLES', sourceRevision: (await execFile('git', ['rev-parse', 'HEAD'])).stdout.trim(), sourceFilesSha256: source.sha256, root, workspacePath, dbPath, taskClass: 'bug fix with process recovery', steps: [], status: 'RUNNING' };
const persist = () => writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`);
await persist();
try {
  for (const mode of ['kill-reviewer', 'recover']) {
    const step = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['benchmarks/r74/live-parent-worker.mjs', mode, dbPath, workspacePath, path.join(root, 'worktrees')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += String(chunk); }); child.stderr.on('data', chunk => { stderr += String(chunk); });
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Authorized recovery worker deadline exceeded')); }, 660000);
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('exit', (exitCode, signal) => { clearTimeout(timer); resolve({ mode, exitCode, signal, stdout, stderr }); });
    });
    evidence.steps.push(step);
    evidence[mode] = JSON.parse(await readFile(`${dbPath}.${mode}.json`, 'utf8'));
    await persist();
    if (mode === 'kill-reviewer') {
      assert.match(step.stdout, /CRASH_REVIEWER/);
      const initial = createSessionPersistence({ dbPath }); await initial.init();
      evidence.writesBeforeRestart = (await initial.getWorkItemsByKind('agent_tool_execution')).filter(item => item.executionClass === 'write' && item.state === 'observation_recorded');
      evidence.workersBeforeRestart = await initial.getWorkItemsByKind('subagent_run');
      evidence.parentStatesBeforeRestart = await initial.getWorkItemsByKind('autonomous_parent_state');
      await initial.close();
      assert(evidence.writesBeforeRestart.length > 0);
      await persist();
    } else assert.equal(step.exitCode, 0, step.stdout + step.stderr);
  }
  const db = createSessionPersistence({ dbPath }); await db.init();
  evidence.workers = await db.getWorkItemsByKind('subagent_run');
  evidence.recoveryReceipts = await db.getWorkItemsByKind('autonomous_parent_recovery');
  evidence.parentStates = await db.getWorkItemsByKind('autonomous_parent_state');
  evidence.verification = await db.getWorkItemsByKind('verification');
  evidence.turns = await db.getWorkItemsByKind('agent_model_turn');
  const writes = (await db.getWorkItemsByKind('agent_tool_execution')).filter(item => item.executionClass === 'write' && item.state === 'observation_recorded');
  evidence.writesAfterRestart = writes;
  await db.close();
  evidence.recordedMutationReplays = writes.filter(after => evidence.writesBeforeRestart.some(before => before.id !== after.id && before.argumentsHash === after.argumentsHash)).length;
  assert.equal(evidence.recordedMutationReplays, 0);
  assert(evidence.writesBeforeRestart.every(before => writes.some(after => after.id === before.id && after.argumentsHash === before.argumentsHash)));
  const result = evidence.recover.result;
  assert.equal(result.status, 'completed'); assert.equal(result.completion.outcome, 'completed'); assert.equal(result.review.passed, true); assert.equal(result.integration.status, 'integrated');
  assert(result.verification.length > 0 && result.verification.every(record => record.passed));
  assert(evidence.parentStates.some(state => state.runId === result.runId && state.phase === 'completed'));
  evidence.testsAfter = await execFile(process.execPath, ['--test'], { cwd: workspacePath, windowsHide: true }).then(({ stdout }) => ({ exitCode: 0, output: stdout }));
  evidence.status = 'PASS';
} catch (error) { evidence.status = 'FAIL'; evidence.error = String(error); process.exitCode = 1; }
evidence.finishedAt = new Date().toISOString(); await persist();
console.log(JSON.stringify({ status: evidence.status, error: evidence.error, output }));
