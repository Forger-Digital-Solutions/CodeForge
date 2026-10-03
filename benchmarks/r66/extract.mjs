import { readFile, writeFile } from 'node:fs/promises';
import { execFile as callback } from 'node:child_process';
import { promisify } from 'node:util';
import { createSessionPersistence } from '@codeforge/sessions';

const execFile = promisify(callback);
const directory = 'docs/evidence/r66-everyday-free-readiness';
const output = { generatedAt: new Date().toISOString(), campaigns: [], limitations: ['Initial sequential campaign loaded the runtime before the R66 anonymous quality-handoff fix. Collector failures are repaired from authoritative SQLite records.'] };
for (const file of ['R66-TASK-CAMPAIGN.json', 'R66-MULTI-USER-LIVE.json', 'R66-TASK-FINAL-SOURCE.json']) {
  const campaign = await readFile(`${directory}/${file}`, 'utf8').then(JSON.parse).catch(() => null);
  if (!campaign) continue;
  const tasks = [];
  for (const task of campaign.tasks) {
    if (task.status === 'RUNNING') continue;
    const persistence = createSessionPersistence({ dbPath: `${task.workspacePath}.db` });
    await persistence.init();
    try {
      const runs = await persistence.getWorkItemsByKind('autonomous_run');
      const raw = runs[0];
      const result = raw?.resultJson ? JSON.parse(raw.resultJson) : task.result;
      const workers = await persistence.getWorkItemsByKind('subagent_run');
      const turns = await persistence.getWorkItemsByKind('agent_model_turn');
      const decisions = await persistence.getWorkItemsByKind('eight_bit_decision_receipt');
      const testsAfter = await execFile(process.execPath, ['--test'], { cwd: task.workspacePath, windowsHide: true }).then(({ stdout }) => ({ exitCode: 0, output: stdout })).catch((error) => ({ exitCode: error.code, output: `${error.stdout ?? ''}${error.stderr ?? ''}` }));
      tasks.push({ id: task.id, ownerUserId: task.ownerUserId ?? 'r66-public-user', taskClass: task.taskClass, startedAt: task.startedAt, finishedAt: task.finishedAt, wallTimeMs: task.wallTimeMs,
        status: result?.status ?? raw?.status ?? task.status, collectorError: task.error ?? null, result, testsBefore: task.testsBefore, testsAfter,
        roles: workers.map((worker) => ({ id: worker.id, role: worker.agentId, status: worker.status, model: worker.model, telemetry: worker.telemetry, structuredOutput: worker.structuredOutput, resultSummary: worker.resultSummary })),
        modelTurns: turns, decisions, experiences: await persistence.getWorkItemsByKind('generalized_experience_signal'),
        falseCompletion: result?.status === 'completed' && (result.completion?.outcome !== 'completed' || !result.review?.passed || result.integration?.status !== 'integrated' || !result.verification?.length || !result.verification.every((item) => item.passed) || testsAfter.exitCode !== 0),
      });
    } finally { await persistence.close(); }
  }
  output.campaigns.push({ file, status: campaign.status, startedAt: campaign.startedAt, finishedAt: campaign.finishedAt, attempted: campaign.tasks.length, stillRunning: campaign.tasks.filter((task) => task.status === 'RUNNING').length, tasks });
}
output.completed = output.campaigns.flatMap((campaign) => campaign.tasks).filter((task) => task.status === 'completed').length;
output.falseCompletions = output.campaigns.flatMap((campaign) => campaign.tasks).filter((task) => task.falseCompletion).length;
await writeFile(`${directory}/R66-TASK-OUTCOMES.json`, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify({ completed: output.completed, falseCompletions: output.falseCompletions, campaigns: output.campaigns.map(({ attempted, stillRunning }) => ({ attempted, stillRunning })) }));
