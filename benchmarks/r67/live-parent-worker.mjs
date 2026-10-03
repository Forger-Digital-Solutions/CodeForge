import { writeFile } from 'node:fs/promises';
import { createSessionPersistence, EventStore } from '@codeforge/sessions';
import { createAgentRuntime, createWorkspaceService, createAutonomousRunOrchestrator } from '@codeforge/server';
import { liveSupply } from './live-supply.mjs';
const [mode, dbPath, workspacePath, worktreeParentDir] = process.argv.slice(2);
const owner = 'r67-live-parent-public';
const supply = await liveSupply(owner, async (providerId, request) => {
  const wrote = request.messages.some(message => message.role === 'assistant' && message.toolCalls?.some(call => ['write_file', 'edit_file', 'replace_exact', 'apply_patch'].includes(call.function.name) && request.messages.some(reply => reply.role === 'tool' && reply.toolCallId === call.id)));
  if ((mode === 'kill-reviewer' && request.messages.some(message => message.role === 'system' && message.content.includes('CodeForge Reviewer'))) || (mode === 'kill-coder' && wrote)) {
    await writeFile(dbPath + '.crash.json', JSON.stringify({ at: new Date().toISOString(), providerId, boundary: mode === 'kill-coder' ? 'CODER_AFTER_OBSERVED_WRITE' : 'REVIEWER_MODEL_PREFLIGHT_AFTER_LIVE_CODER', maxTokens: request.maxTokens }));
    process.stdout.write('CRASH_REVIEWER\n'); process.kill(process.pid, 'SIGKILL');
  }
});
const persistence = createSessionPersistence({ dbPath }); await persistence.init();
const sessionId = 'r67-live-parent';
await persistence.upsertSession({ id: sessionId, title: 'Live parent recovery', status: 'running', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
const runtime = createAgentRuntime({ sessionId, eventStore: new EventStore(), persistence, firewall: supply.firewall, providerCatalog: supply.catalog, workspacePath, userId: owner, routeHealth: supply.health, freeCloud: supply.freeCloud, freeFabric: supply.fabric, fabricContext: () => ({ userId: owner, userIdentities: supply.freeCloud.capacityIdentitiesFor(owner), dataContext: { dataClass: 'PUBLIC_CODE', userConsented: true } }) });
await runtime.init();
const orchestrator = createAutonomousRunOrchestrator({ persistence, agentRuntime: runtime, subagentsR1Enabled: true, workspaceService: createWorkspaceService({ persistence, worktreeParentDir }) });
const runId = 'run-00000000-0000-4000-8000-000000000068';
if (mode === 'recover') {
  const recovery = await orchestrator.recoverRuns();
  const run = orchestrator.getRun(runId);
  await writeFile(dbPath + '.recovered.json', JSON.stringify({ recovery, status: run?.status, result: run?.result, error: run?.error, supply: supply.receipts, routeHealth: supply.health.snapshot(), reservations: supply.reservations.snapshot() }, null, 2));
  console.log(JSON.stringify({ recovery, status: run?.status, reason: run?.error }));
  await persistence.close(); process.exitCode = run?.status === 'completed' && run.result?.completion?.outcome === 'completed' ? 0 : 3;
} else {
  const result = await orchestrator.startRun({ runId, sessionId, workspacePath, topology: 'normal', goal: 'Fix multiply in math.mjs. Preserve its public API and all tests. This is a public synthetic fixture with no credentials or user private code.', verificationCommands: ['node --test'], signal: AbortSignal.timeout(600000) });
  console.log(JSON.stringify(result)); await persistence.close(); process.exitCode = 4;
}
