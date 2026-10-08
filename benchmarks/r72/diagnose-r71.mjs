import { DatabaseSync } from 'node:sqlite';
import { writeFile } from 'node:fs/promises';

const results = [];
for (const name of ['public-task-Nk4PiW', 'public-task-74XgBo']) {
  const db = new DatabaseSync(`G:/CodeForge/benchmarks/r71/tmp/source/benchmarks/r71/tmp/${name}.db`, { readOnly: true });
  const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table'").all();
  const workTable = tables.find(t => t.name === 'work_items');
  if (!workTable) { console.log(tables); continue; }
  const records = db.prepare('SELECT * FROM work_items').all();
  const items = records.map(row => {
    for (const value of Object.values(row)) {
      if (typeof value !== 'string' || !value.startsWith('{')) continue;
      try { const item = JSON.parse(value); if (item.kind) return item; } catch {}
    }
    return row;
  });
  const journals = items.filter(item => item.kind === 'agent_run_journal');
  const diagnostic = journals.map(journal => ({ role: journal.role, state: journal.state, telemetry: journal.telemetry,
    toolRequests: journal.messages.filter(m => m.toolCalls?.length).flatMap(m => m.toolCalls),
    responses: journal.messages.filter(m => m.role === 'tool').map(m => ({ id: m.toolCallId, content: m.content.slice(0, 700) })),
    finalMessages: journal.messages.filter(m => m.role === 'assistant' && !m.toolCalls?.length).map(m => m.content),
  }));
  results.push({ name, diagnostic });
  console.log(JSON.stringify({ name, journals: diagnostic.map(j => ({ role: j.role, state: j.state, requests: j.toolRequests, responses: j.responses, finalMessages: j.finalMessages })) }));
  db.close();
}
await writeFile('docs/evidence/r72-free-supply-and-autonomy/r71-diagnosis.json', JSON.stringify(results, null, 2));
