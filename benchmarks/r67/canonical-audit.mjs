import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
const directory = 'docs/evidence/r67-everyday-completion-reliability';
const read = async name => JSON.parse(await readFile(`${directory}/${name}.json`, 'utf8'));
const frozen = await read('R67-SOURCE-FREEZE');
const sourceDelta = await read('R67-TEST-ONLY-SOURCE-DELTA');
assert.equal(sourceDelta.status, 'PASS');
assert.equal(sourceDelta.runtimeImplementationChanged, false);
assert.equal(sourceDelta.afterSourceStateId, frozen.sourceStateId);
const canonical = await read('R67-CANONICAL-CERTIFICATION-CAMPAIGN');
const concurrent = await read('R67-MULTI-USER-CERTIFICATION');
const emptyIgnore = path.resolve('benchmarks/r67/tmp/audit-empty-ignore');
await writeFile(emptyIgnore, '');
const campaigns = [];
for (const [name, campaign] of [['canonical', canonical], ['concurrency', concurrent]]) {
  assert.equal(campaign.status, 'PASS');
  assert.equal(campaign.measuredProfileExperiment, undefined, 'CANONICAL_CAMPAIGN_MUST_USE_PRODUCTION_DEFAULTS');
  assert(Date.parse(campaign.startedAt) >= Date.parse(sourceDelta.beforeFreezeAt));
  assert.equal(campaign.tasks.length, name === 'canonical' ? 6 : 3);
  const tasks = [];
  for (const task of campaign.tasks) {
    assert.equal(task.status, 'completed');
    assert.equal(task.result.completion.outcome, 'completed');
    assert.equal(task.result.review.passed, true);
    assert(task.result.verification.every(row => row.exitCode === 0 && row.failed === 0 && row.passed > 0));
    assert.equal(task.result.integration.status, 'integrated');
    assert.equal(task.testsAfter.exitCode, 0);
    assert(task.result.changedFiles.length > 0 && task.diff.length > 0);
    assert(task.workers.some(worker => worker.agentId === 'reviewer' && worker.status === 'completed'), 'COMPLETED_INDEPENDENT_REVIEWER_REQUIRED');
    const dbPath = path.join(path.dirname(task.workspacePath), `${path.basename(task.workspacePath)}.db`);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const items = db.prepare('SELECT data FROM work_items').all().map(row => JSON.parse(row.data));
    db.close();
    const tools = items.filter(row => row.kind === 'agent_tool_execution');
    const journals = items.filter(row => row.kind === 'agent_run_journal');
    const explorers = task.workers.filter(worker => worker.agentId === 'explorer');
    assert(explorers.length > 0);
    const explorerDetails = explorers.map(worker => {
      const journal = journals.find(row => row.runId === worker.id);
      const structured = journal?.telemetry?.structuredOutput;
      const last = journal?.messages?.filter(message => message.role === 'assistant' && !message.toolCalls?.length).at(-1)?.content ?? '';
      let finalPayloadIsCompleteJson = false;
      try { JSON.parse(last); finalPayloadIsCompleteJson = true; } catch { /* Truncated/absent JSON remains rejected. */ }
      return { status: worker.status, finalPayloadIsCompleteJson, capRepairs: structured?.truncationRepairs ?? 0,
        schemaRejections: structured?.rejections ?? [], stopReason: journal?.telemetry?.stopReason, error: worker.error };
    });
    const explorerOutputCapBlocks = explorerDetails.filter(worker => worker.status !== 'completed'
      && worker.capRepairs > 0 && !worker.finalPayloadIsCompleteJson).length;
    assert.equal(explorerOutputCapBlocks, 0, 'EXPLORER_OUTPUT_BUDGET_GATE');
    const workerSessions = [...new Set(task.workers.map(row => row.sessionId))];
    assert.equal(workerSessions.length, 1);
    assert(task.turns.every(row => row.sessionId === workerSessions[0]));
    const otherPaths = campaign.tasks.filter(row => row !== task).map(row => row.workspacePath);
    assert(task.workers.every(worker => otherPaths.every(other => !JSON.stringify(worker).includes(other))));
    const git = (cwd, args) => execFileSync('git', ['-c', `core.excludesFile=${emptyIgnore}`, ...args], { cwd, encoding: 'utf8' }).trim();
    const integratedHead = git(task.workspacePath, ['rev-parse', 'HEAD']);
    const verifiedPath = task.result.verification[0].cwd;
    const integratedTree = git(task.workspacePath, ['rev-parse', 'HEAD^{tree}']);
    const verifiedTree = git(verifiedPath, ['rev-parse', 'HEAD^{tree}']);
    assert.equal(integratedHead, task.result.finalRevision);
    assert.equal(integratedTree, verifiedTree);
    assert.equal(git(task.workspacePath, ['status', '--porcelain']), '');
    assert.equal(git(verifiedPath, ['status', '--porcelain']), '');
    const noSupply = task.decisions.filter(row => row.receipt?.action === 'NO_ELIGIBLE_ROUTE');
    tasks.push({ id: task.id, taskClass: task.taskClass, ownerUserId: task.ownerUserId ?? 'r67-public-user',
      startedAt: task.startedAt, finishedAt: task.finishedAt, wallTimeMs: task.wallTimeMs,
      baseTestsExitCode: task.testsBefore.exitCode, status: task.status,
      providers: [...new Set(task.turns.map(row => row.servedProviderId))],
      models: [...new Set(task.turns.map(row => row.servedModelId))],
      physicalModels: [...new Set(task.turns.map(row => row.physicalModelId).filter(Boolean))],
      domains: [...new Set(task.turns.map(row => row.quotaDomainId).filter(Boolean))],
      admission: task.decisions.map(row => ({ role: row.receipt?.role, action: row.receipt?.action,
        selected: row.receipt?.selected, evidence: row.receipt?.evidence, reasonCodes: row.receipt?.reasonCodes })),
      noSupplyDecisions: noSupply.length, recordedTools: tools.length,
      explorerOutcome: { children: explorers.length, completed: explorers.filter(worker => worker.status === 'completed').length,
        outputCapBlocks: explorerOutputCapBlocks, otherRejected: explorers.filter(worker => worker.status !== 'completed').length,
        details: explorerDetails },
      recordedSourceOrTemporaryWrites: tools.filter(row => row.executionClass === 'write' && row.state === 'observation_recorded').length,
      workers: task.workers.map(worker => ({ role: worker.agentId, status: worker.status, model: worker.model,
        budget: worker.budget, telemetry: worker.telemetry,
        repairTelemetry: journals.find(row => row.runId === worker.id)?.telemetry?.structuredOutput })),
      reviewRounds: task.result.counters.reviewRounds, reviewerPassed: task.result.review.passed,
      verification: task.result.verification.map(({ command, exitCode, passed, failed, skipped }) => ({ command, exitCode, passed, failed, skipped })),
      completion: task.result.completion, integration: task.result.integration,
      integratedRevision: integratedHead, integratedTree, verifiedTree, verifiedTreeMatchesIntegratedTree: true,
      finalWorkingTreesClean: true, activeReservationsAfter: task.reservations.activeReservations,
      crossTaskSessionOrWorkspaceLeakage: false });
  }
  if (name === 'canonical') assert(tasks.every(task => task.activeReservationsAfter === 0));
  const overlap = Math.min(...tasks.map(task => Date.parse(task.finishedAt))) - Math.max(...tasks.map(task => Date.parse(task.startedAt)));
  campaigns.push({ name, status: 'PASS', attempted: tasks.length, completed: tasks.length, failedOrBlocked: 0,
    longestCompletionStreak: tasks.length, falseCompletions: 0,
    noSupplyDecisions: tasks.reduce((total, task) => total + task.noSupplyDecisions, 0),
    simultaneousUsers: name === 'concurrency' ? new Set(tasks.map(task => task.ownerUserId)).size : 1,
    allTaskOverlapMs: name === 'concurrency' ? overlap : null, tasks });
  if (name === 'concurrency') { assert(overlap > 0); assert.equal(campaign.reservationsAfter.activeReservations, 0); }
}
const historical = await read('R67-MULTI-USER-LIVE');
const timedOut = historical.tasks.find(task => task.status === 'cancelled');
assert.equal(timedOut.testsBefore.exitCode, 1);
const result = { at: new Date().toISOString(), status: 'PASS', sourceStateId: frozen.sourceStateId,
  runtimeSourceAggregateSha256: frozen.sourceAggregateSha256, runtimeSourceFreezeAt: frozen.at,
  campaignSourceBinding: 'Both campaigns ran after the last runtime implementation edit. A subsequent watchdog test-only synchronization expands the material set; R67-TEST-ONLY-SOURCE-DELTA proves every runtime implementation byte identical. The final canonical suite reruns after that test-only freeze.',
  costState: 'UNKNOWN', independentPhysicalQuotaDomainsProven: false,
  supplyLimitation: 'One eligible Kilo anonymous PUBLIC_IP route; user identities are logically isolated but independent physical quota domains are not verified.',
  historicalTimeout: { source: 'R67-MULTI-USER-LIVE.json', status: timedOut.status, wallTimeMs: timedOut.wallTimeMs,
    baseTestsExitCode: timedOut.testsBefore.exitCode, reviewRounds: timedOut.result.counters.reviewRounds,
    reason: 'Invalid refactor test baseline; blocked Horde Reviewer followed by Kilo blocking verdict and Coder revision cancelled at 600 seconds. The trace proves progressing provider requests, not a scheduler deadlock. It cannot measure fair completion of a valid refactor.',
    workers: timedOut.workers.map(worker => ({ role: worker.agentId, status: worker.status, model: worker.model, requests: worker.telemetry.modelRequests })),
    activeReservationsAfter: historical.reservationsAfter.activeReservations }, campaigns };
await writeFile(`${directory}/R67-CANONICAL-AUDIT.json`, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ status: result.status, campaigns: campaigns.map(({ name, completed, simultaneousUsers, allTaskOverlapMs, noSupplyDecisions }) => ({ name, completed, simultaneousUsers, allTaskOverlapMs, noSupplyDecisions })) }));
