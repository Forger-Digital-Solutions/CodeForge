import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { execFile as callback } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { tasks } from './project-specs.mjs';

const execFile = promisify(callback);
if (tasks.length !== 20 || new Set(tasks.map(task => task.id)).size !== 20) throw new Error('Twenty distinct specifications required');
const root = await mkdtemp(path.join(tmpdir(), 'r84-spec-validation-'));
const rows = [];
for (const task of tasks) {
  const directory = path.join(root, task.id);
  await mkdir(directory);
  for (const [file, content] of Object.entries(task.files)) {
    const target = path.join(directory, file);
    await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, content);
    if (file.endsWith('.mjs')) await execFile(process.execPath, ['--check', target], { windowsHide: true });
  }
  rows.push({ id: task.id, taskClass: task.taskClass, goal: task.goal, verificationCommands: task.verificationCommands, acceptance: task.acceptance, fixtureSha256: createHash('sha256').update(JSON.stringify(task.files)).digest('hex'), syntax: 'VALID', execution: 'NOT_RUN' });
}
await writeFile('docs/evidence/r84-free-cloud-autonomy-certification/project-specifications.json', JSON.stringify({ status: 'SYNTAX_VALIDATED_NOT_MODEL_EXECUTED', count: rows.length, benchmarkLevel: 'PUBLIC_ENGINEERING_FIXTURES_NOT_FULL_PROJECTS', root, specifications: rows }, null, 2));
console.log(JSON.stringify({ count: rows.length, status: 'SYNTAX_VALIDATED_NOT_MODEL_EXECUTED' }));
