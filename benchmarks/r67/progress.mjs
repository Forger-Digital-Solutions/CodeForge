import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
for (const name of process.argv.slice(2)) {
  const document = JSON.parse(await readFile(`docs/evidence/r67-everyday-completion-reliability/${name}.json`, 'utf8'));
  console.log(JSON.stringify({ name, status: document.status, tasks: document.tasks?.map(row => ({ id: row.id, status: row.status, elapsed: row.wallTimeMs, reason: row.result?.summary })) }));
  for (const task of document.tasks?.filter(row => row.status === 'RUNNING') ?? []) {
    const db = new DatabaseSync(path.join(path.dirname(task.workspacePath), `${path.basename(task.workspacePath)}.db`), { readOnly: true });
    const items = db.prepare('select data from work_items').all().map(row => JSON.parse(row.data));
    console.log(JSON.stringify(items.filter(item => ['subagent_run','agent_run_journal','autonomous_run'].includes(item.kind)).map(item => ({ kind: item.kind, id: item.id, role: item.role, status: item.status, state: item.state, turnCount: item.usage?.requestCount, stopReason: item.stopReason, error: item.error }))));
    db.close();
  }
}
