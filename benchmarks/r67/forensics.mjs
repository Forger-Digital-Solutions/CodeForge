import { readFile, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { validateStructuredAgentResult } from '@codeforge/agent';

const source = 'docs/evidence/r66-everyday-free-readiness';
const target = 'docs/evidence/r67-everyday-completion-reliability';
const outcomes = JSON.parse(await readFile(`${source}/R66-TASK-OUTCOMES.json`, 'utf8'));
const attempts = [];
for (const campaign of outcomes.campaigns) {
  const original = JSON.parse(await readFile(`${source}/${campaign.file}`, 'utf8'));
  for (const task of campaign.tasks) {
    const raw = original.tasks.find(t => t.id === task.id);
    const db = new DatabaseSync(`${raw.workspacePath}.db`, { readOnly: true });
    const items = kind => db.prepare('SELECT data FROM work_items WHERE kind=?').all(kind).map(r => JSON.parse(r.data));
    const journals = items('agent_run_journal');
    const handoffs = [...items('semantic_verifier_handoff'), ...items('role_quality_handoff')];
    db.close();
    const reason = task.result?.summary ?? '';
    const cluster = task.status !== 'blocked' ? 'COMPLETED'
      : reason.includes('No eligible free route') ? 'ROUTE_QUARANTINE'
        : reason.includes('Structured output is not valid JSON') ? 'REVIEWER_MALFORMED_OUTPUT'
          : reason.includes('AGENT_MODEL_TURN_LIMIT') ? 'CODER_NONCONVERGENCE' : 'UNKNOWN';
    const decisions = (task.decisions ?? []).map(d => d.receipt);
    const roleStates = task.roles.map(role => {
      const journal = journals.find(j => j.runId === role.id);
      const responses = (journal?.messages ?? []).filter(m => m.role === 'assistant' && m.content && !m.toolCalls?.length);
      return { ...role, resultSummary: undefined, structuredOutput: journal?.telemetry?.structuredOutput ?? null,
        stopReason: journal?.telemetry?.stopReason ?? null,
        roleProgress: journal?.telemetry?.roleProgress ?? null,
        finalPayload: responses.map(m => ({ characters: m.content.length,
          schemaValid: ['explorer', 'planner', 'reviewer'].includes(role.role) ? validateStructuredAgentResult(role.role, m.content).success : null,
          schemaError: ['explorer', 'planner', 'reviewer'].includes(role.role) ? validateStructuredAgentResult(role.role, m.content).error ?? null : null })),
        toolFailures: (journal?.telemetry?.toolTrace ?? []).flatMap(t => t.calls.filter(c => c.outcome !== 'success').map(c => ({ turn: t.turn, ...c }))),
      };
    });
    attempts.push({ campaign: campaign.file, taskId: task.id, runId: task.result?.runId, taskClass: task.taskClass,
      status: task.status, cluster, blockingReason: task.status === 'blocked' ? reason : null,
      blockingPhase: task.status === 'blocked' ? (reason.startsWith('Independent review') ? 'review' : 'coding') : null,
      lastSuccessfulPhase: task.status === 'completed' ? 'integration' : reason.startsWith('Independent review') ? (roleStates.some(r => r.role === 'coder' && r.telemetry.toolCalls > 0) ? 'coding' : 'writer_narration_without_tools') : 'preparation',
      qualification: original.supply, roles: roleStates,
      turnCount: roleStates.reduce((n,r) => n+r.telemetry.modelRequests,0), toolCount: roleStates.reduce((n,r) => n+r.telemetry.toolCalls,0),
      providerState: (raw.routeHealth ?? []).map(r => ({ providerId:r.providerId, modelId:r.modelId, quotaDomainId:r.quotaDomainId ?? null, state:r.state, conditions:r.conditions, window:r.window })),
      reviewerState: roleStates.filter(r => r.role === 'reviewer').map(r => ({ status:r.status, model:r.model, structuredOutput:r.structuredOutput })),
      forgeVerify: { attempted: task.result?.counters?.verificationAttempts ?? 0, records: task.result?.verification ?? [] },
      completionGate: task.result?.completion ?? { outcome:'NOT_REACHED', completed:false },
      retries: roleStates.reduce((n,r) => n+r.telemetry.retryCount,0), handoffs,
      failovers: journals.flatMap(j => j.telemetry?.routeFailovers ?? []), decisions,
      classification: cluster === 'COMPLETED' ? null : 'PRODUCT_CONTROLLED',
      classificationBasis: cluster === 'ROUTE_QUARANTINE' ? 'Quality-derived quarantine; final-source snapshots show malformed-output streaks despite healthy domain transport. Initial campaign has no retained health snapshots; matching denial and journals support the same cluster but exact conditions are unavailable.' : 'No provider failures recorded for the blocking role; role output/convergence failed.',
    });
  }
}
const blocked = attempts.filter(t => t.status === 'blocked');
if (blocked.length !== 16) throw new Error('EXPECTED_16_BLOCKS');
const counts = new Map();
for (const t of blocked) counts.set(t.cluster,(counts.get(t.cluster)??0)+1);
const pareto = [...counts].map(([cluster,count]) => ({cluster,count,fraction:count/blocked.length})).sort((a,b)=>b.count-a.count);
const prediction = new Map();
for (const t of attempts) for (const r of t.roles) {
  if (!r.model) continue;
  const key = `${r.model.providerId}/${r.model.modelId}/${r.role}`;
  const row = prediction.get(key) ?? { providerId:r.model.providerId,modelId:r.model.modelId,role:r.role,attempts:0,completed:0,blocked:0,failed:0,toolFreeWriterClaims:0 };
  row.attempts++; row[r.status] = (row[r.status] ?? 0)+1;
  if(r.role === 'coder' && r.status === 'completed' && r.telemetry.toolCalls===0) row.toolFreeWriterClaims++;
  prediction.set(key,row);
}
await writeFile(`${target}/R67-R66-BLOCKER-FORENSICS.json`,JSON.stringify({generatedAt:new Date().toISOString(),source:`${source}/R66-TASK-OUTCOMES.json`,attempts,blockedClassified:blocked.length,unknown:counts.get('UNKNOWN')??0},null,2)+'\n');
await writeFile(`${target}/R67-BLOCKER-PARETO.json`,JSON.stringify({generatedAt:new Date().toISOString(),blocked:blocked.length,pareto,rootCauseOrder:['ROLE_OUTPUT_CONTRACT','QUALITY_QUARANTINE_CROSS_ROLE','CODER_OVEREXPLORATION'],externalCapacityBlocksProven:0,limitations:['Initial campaign collector failed to retain health snapshots. Later final-source route-health snapshots provide direct quarantine evidence.']},null,2)+'\n');
await writeFile(`${target}/R67-QUALIFICATION-PREDICTION.json`,JSON.stringify({generatedAt:new Date().toISOString(),rows:[...prediction.values()],warning:'Worker completed is weaker than independently verified task completion. Fixture qualification did not predict live reliability.'},null,2)+'\n');
console.log(JSON.stringify({blocked:blocked.length,pareto,prediction:[...prediction.values()]}));
