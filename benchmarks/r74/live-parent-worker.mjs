import { writeFile } from 'node:fs/promises';
import { createSessionPersistence, EventStore } from '@codeforge/sessions';
import { createAgentRuntime, createWorkspaceService, createAutonomousRunOrchestrator, createWorkspaceEventAdapter } from '@codeforge/server';
import { liveSupply } from './live-supply.mjs';
import { taskAt } from '../r71/tasks.mjs';
const [mode, dbPath, workspacePath, worktreeParentDir] = process.argv.slice(2);
const owner = 'r74-recovery-public';
const output = `${dbPath}.${mode}.json`;
const report = { mode, startedAt: new Date().toISOString(), supply: [], inferenceFrames: [], status: 'RUNNING' };
const persist = () => writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
const supply = await liveSupply(owner, report, persist, async (providerId, request) => {
  const isReviewer = `${request.system ?? ''}\n${request.messages.filter(message => message.role === 'system').map(message => message.content).join('\n')}`.includes('CodeForge Reviewer');
  if (mode === 'kill-reviewer' && isReviewer) {
    report.status = 'INTENTIONALLY_INTERRUPTED_AFTER_LIVE_CODER_BEFORE_REVIEW_INFERENCE';
    report.crashBoundary = { providerId, model: request.model, at: new Date().toISOString() };
    await persist();
    process.stdout.write('CRASH_REVIEWER\n');
    process.kill(process.pid, 'SIGKILL');
  }
});
const persistence = createSessionPersistence({ dbPath }); await persistence.init();
const sessionId = 'r74-live-parent-recovery';
if (mode !== 'recover') await persistence.upsertSession({ id: sessionId, title: 'R74 public live recovery', status: 'running', createdAt: report.startedAt, updatedAt: report.startedAt });
const events = new EventStore();
const runtime = createAgentRuntime({ sessionId, eventStore: events, persistence, firewall: supply.firewall, providerCatalog: supply.catalog, workspacePath, userId: owner, routeHealth: supply.health, freeCloud: supply.freeCloud, freeFabric: supply.fabric, fabricContext: () => ({ userId: owner, userIdentities: supply.freeCloud.capacityIdentitiesFor(owner), dataContext: { dataClass: 'PUBLIC_CODE', userConsented: true } }) });
await runtime.init();
const orchestrator = createAutonomousRunOrchestrator({ persistence, agentRuntime: runtime, subagentsR1Enabled: true, workspaceService: createWorkspaceService({ persistence, worktreeParentDir }) });
const runId = 'run-00000000-0000-4000-8000-000000000074';
try {
  if (mode === 'recover') {
    report.recovery = await orchestrator.recoverRuns();
    const run = orchestrator.getRun(runId);
    report.status = run?.status ?? 'MISSING_PARENT';
    report.result = run?.result;
    report.error = run?.error;
  } else {
    report.result = await orchestrator.startRun({ runId, sessionId, workspacePath, topology: 'fixed_r1', goal: `${taskAt(0).goal} This is public synthetic code with no credentials or private user code.`, verificationCommands: ['node --test'], signal: AbortSignal.timeout(600000), adapter: createWorkspaceEventAdapter({ sessionId, eventStore: events, persistence }) });
    report.status = report.result.status;
  }
  report.workers = await persistence.getWorkItemsByKind('subagent_run');
  report.parentStates = await persistence.getWorkItemsByKind('autonomous_parent_state');
  report.routeHealth = supply.health.snapshot();
  report.reservations = supply.reservations.snapshot();
} catch (error) { report.status = 'ERROR'; report.error = String(error); }
finally { report.finishedAt = new Date().toISOString(); await persist(); await persistence.close(); }
console.log(JSON.stringify({ mode, status: report.status, error: report.error }));
process.exitCode = mode === 'recover' && report.status === 'completed' && report.result?.completion?.outcome === 'completed' ? 0 : 3;
