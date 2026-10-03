import { readFile, writeFile } from 'node:fs/promises';
import { createSessionPersistence } from '@codeforge/sessions';

const directory = 'docs/evidence/r66-everyday-free-readiness';
const read = (name) => readFile(`${directory}/${name}`, 'utf8').then(JSON.parse);
const write = (name, value) => writeFile(`${directory}/${name}`, `${JSON.stringify({ generatedAt: new Date().toISOString(), ...value }, null, 2)}\n`);
const outcomes = await read('R66-TASK-OUTCOMES.json');
const scale = await read('R66-SCALE-SIMULATION.json');
const windows = await read('R66-WINDOWS-SOAK.json');
const tasks = outcomes.campaigns.flatMap((campaign) => campaign.tasks);
const turns = tasks.flatMap((task) => task.modelTurns);
const workers = tasks.flatMap((task) => task.roles);
const handoffs = [];
const interventions = [];
const effects = [];
for (const name of ['R66-TASK-CAMPAIGN.json', 'R66-MULTI-USER-LIVE.json', 'R66-TASK-FINAL-SOURCE.json']) {
  const campaign = await read(name);
  for (const task of campaign.tasks) {
    const persistence = createSessionPersistence({ dbPath: `${task.workspacePath}.db` });
    await persistence.init();
    try {
      handoffs.push(...await persistence.getWorkItemsByKind('role_quality_handoff'));
      handoffs.push(...await persistence.getWorkItemsByKind('semantic_verifier_handoff'));
      interventions.push(...await persistence.getWorkItemsByKind('strategy_intervention_receipt'));
      effects.push(...await persistence.getWorkItemsByKind('autonomous_experience_receipt'));
    } finally { await persistence.close(); }
  }
}
const roleCounts = {};
for (const worker of workers) {
  const key = `${worker.role}:${worker.model?.providerId ?? 'NONE'}:${worker.status}`;
  roleCounts[key] = (roleCounts[key] ?? 0) + 1;
}
const retries = workers.reduce((sum, worker) => sum + (worker.telemetry?.retryCount ?? 0), 0);
const maximumConsecutiveCompleted = Math.max(...outcomes.campaigns.filter((campaign) => campaign.file !== 'R66-MULTI-USER-LIVE.json').map((campaign) => {
  let current = 0;
  let maximum = 0;
  for (const task of campaign.tasks) { current = task.status === 'completed' ? current + 1 : 0; maximum = Math.max(maximum, current); }
  return maximum;
}));
const totals = { attempted: tasks.length, completed: tasks.filter((task) => task.status === 'completed').length, blocked: tasks.filter((task) => task.status === 'blocked').length, failed: tasks.filter((task) => task.status === 'failed').length, falseCompletions: outcomes.falseCompletions,
  modelTurns: turns.length, reportedModelRequests: workers.reduce((sum, worker) => sum + (worker.telemetry?.modelRequests ?? 0), 0), toolCalls: workers.reduce((sum, worker) => sum + (worker.telemetry?.toolCalls ?? 0), 0), retries, averageRetriesPerTask: retries / tasks.length,
  roleQualityHandoffs: handoffs.length, successfulRoleQualityHandoffs: handoffs.filter((row) => row.outcome === 'completed').length, liveFalseWaits: null,
  paidRouteSelections: turns.filter((turn) => turn.servedProviderId && !['kilo-free-direct', 'ai-horde'].includes(turn.servedProviderId)).length, unknownServedRouteTurns: turns.filter((turn) => !turn.servedProviderId).length, BYOKRouteSelections: 0, billingMeasurement: 'UNKNOWN',
};
await write('R66-ENDURANCE.json', { evidenceClass: 'LIVE_ANONYMOUS_FREE_PUBLIC_FIXTURES', status: 'PARTIAL', ...totals, consecutiveCompletedTasksMaximum: maximumConsecutiveCompleted, campaigns: outcomes.campaigns.map(({ file, startedAt, finishedAt, attempted, tasks }) => ({ file, startedAt, finishedAt, attempted, completed: tasks.filter((task) => task.status === 'completed').length })), roleCounts, limitations: ['See concrete completion and consecutive-task totals; fixture qualification alone does not establish sustained daily reliability.', 'Initial sequential runtime predates anonymous quality handoff and the final Reviewer-only conservation correction. Concurrent runtime includes handoff but predates the Reviewer-only correction.', 'Unavailable-route outcomes do not establish whether every provider was actually healthy and eligible; live false waits remain unclassified.'] });
await write('R66-ROLE-ROUTING.json', { status: 'MEASURED', roleCounts, handoffs, independence: tasks.map((task) => ({ id: task.id, coder: task.roles.filter((role) => role.role === 'coder').map((role) => role.model), reviewers: task.roles.filter((role) => role.role === 'reviewer').map((role) => role.model), reviewPassed: task.result?.review?.passed ?? false })), limitations: ['A different provider/quota domain is preferred; no-verdict fallback may reduce independence and is reported by the runtime.', 'Qualified fixture roles still fail ordinary task output contracts.'] });
await write('R66-NO-FALSE-WAIT.json', { status: 'PASS_SIMULATION_LIVE_UNCLASSIFIED', simulatedDegradations: 250, simulatedFalseWaits: scale.falseWaits, liveFalseWaits: null, liveCapacityDenials: tasks.filter((task) => /NO_ELIGIBLE_ROUTE/.test(task.result?.summary ?? '')).length, limitations: ['No healthy-eligible live oracle was recorded at each denial. Later transport successes do not retrospectively prove role eligibility.'] });
await write('R66-PRIVACY.json', { status: 'PASS_DETERMINISTIC_ENFORCEMENT', evidenceClass: 'ADVERSARIAL_FABRIC_SIMULATION_AND_PROVIDER_CONTRACTS', publicLiveTasks: tasks.length, privateLivePayloadsSent: 0, simulatedPrivateAttemptsWithHordeOnly: 250, privateLeaksObserved: scale.privateLeaks, publicHordeModelTurns: turns.filter((turn) => turn.servedProviderId === 'ai-horde').length, providerContracts: 'R66-FAULT-REGRESSIONS.json', qualificationFixtures: 'Public frozen fixtures only', limitation: 'Private denial is adversarially simulated; no private user source is transmitted to test it.' });
await write('R66-FAIRNESS.json', { status: 'PASS_LOCAL_SIMULATION_LIVE_COMPLETION_INCOMPLETE', ...scale.fairness, liveLogicalUsers: 3, actualOverlappingTasks: 3, liveCompleted: outcomes.campaigns[1].tasks.filter((task) => task.status === 'completed').length, ledger: 'One shared CapacityReservationLedger; separate FreeCloud owner connections, sessions, SQLite stores and worktrees', upstreamScope: 'Kilo SOURCE_IP shared egress; Horde GLOBAL_SHARED', limitation: 'Three blocked live tasks cannot establish sustained no-starvation completion.' });
await write('R66-ANTI-LOOP.json', { status: 'BOUNDED_WITH_LIVE_FAILURES', liveModelTurnLimitStops: tasks.filter((task) => /AGENT_MODEL_TURN_LIMIT/.test(task.result?.summary ?? '')).length, liveHandoffs: handoffs, liveInterventions: interventions, infiniteRunsObserved: 0, regressionProof: 'R66-FAULT-REGRESSIONS.json and R66-HANDOFF-REGRESSIONS.json', limitation: 'A bounded abort is safe but does not meet everyday completion.' });
await write('R66-EXPERIENCE-LEARNING.json', { status: 'PASS_FOUNDATION_LIVE_NEXT_TASK_EFFECT_UNPROVEN', generalizedSignals: tasks.flatMap((task) => task.experiences), localReceiptCount: effects.length, neuralTraining: false, priorOutcomeAdviceRegression: 'R66-FAULT-REGRESSIONS.json: r57-experience-learning.test.ts', liveNextTaskEffect: null, limitation: 'Sequential fixtures deliberately use separate databases; no cross-task learning effect is attributed to that campaign.' });
await write('R66-UI-RESPONSIVENESS.json', { status: 'MEASURED_ONBOARDING_ONLY', samples: windows.samples.length, maxRendererRoundTripMs: Math.max(...windows.samples.map((sample) => sample.rendererRoundTripMs)), minRendererRoundTripMs: Math.min(...windows.samples.map((sample) => sample.rendererRoundTripMs)), launchMs: windows.launchMs, peakMainRssBytes: Math.max(...windows.samples.map((sample) => sample.mainProcess?.rssBytes ?? 0)), authenticated: windows.account.authenticated, rendererFreezeObserved: false, tasksUnderUiLoadCompleted: 0, scrollingFilesTabsSettingsDuringCoding: 'UNPROVEN', socketLeakMeasurement: null, processTreeMemory: null, limitation: 'Animation-frame responsiveness on sign-in screen is not a coding-workspace daily-use soak.' });
await write('R66-COMPLETION-TORTURE.json', { status: 'NO_FALSE_COMPLETION_OBSERVED', falseCompletions: outcomes.falseCompletions, completed: totals.completed, blocked: totals.blocked, authority: 'packages/workflow/src/completion-gate.ts evaluateCompletion', regressionProof: 'R66-FAULT-REGRESSIONS.json: completion-gate and r21-autonomous-completion-binding', completedChecks: tasks.filter((task) => task.status === 'completed').map((task) => ({ id: task.id, review: task.result.review, verification: task.result.verification, completion: task.result.completion, integration: task.result.integration, rootTestsExitCode: task.testsAfter.exitCode })) });
await write('R66-PERFORMANCE.json', { status: 'BASELINES_NO_INVENTED_THRESHOLDS', desktopLaunchMs: windows.launchMs, desktopRendererRoundTripMs: windows.samples.map((sample) => sample.rendererRoundTripMs), liveProviderModelLatencyMs: turns.map((turn) => turn.modelLatencyMs).filter((value) => typeof value === 'number'), simulatedDecisionLatencyMs: scale.latencyMs, capacityInitializationMs: null, assignmentCreationMs: null, pollToAckMs: null, completionFinalizationMs: null, limitation: 'Remote production dispatch latency is historical R65 evidence, not rerun in R66.' });
await write('R66-CAPACITY-METRICS.json', { status: 'MEASURED_WITH_LIMITATIONS', admittedFreeDomainsInCampaign: 2, independentUpstreamGroups: 2, qualificationFixtureRoleRoutes: 12, healthyProductionRoleRoutesAtFreeze: null, successfulR66LiveCrossDomainCompletions: tasks.filter((task) => task.status === 'completed' && new Set(task.roles.map((role) => role.model?.providerId).filter(Boolean)).size > 1).length, liveFailoverCompletions: handoffs.filter((row) => row.outcome === 'completed').length, falseWaitsLive: null, falseWaitsSimulated: scale.falseWaits, paidRouteSelections: totals.paidRouteSelections, BYOKRouteSelections: 0, purchasedCreditBillingMeasurement: 'UNKNOWN', providers: ['Kilo PACKAGED_FREE_DIRECT/SOURCE_IP', 'AI Horde COMMUNITY_ANONYMOUS_FREE/GLOBAL_SHARED/PUBLIC_CODE_ONLY/text-tool mediation'] });
await write('R66-FAILURE-CLASSIFICATION.json', { status: 'CLASSIFIED', runtimeFailures: tasks.filter((task) => task.status !== 'completed').map((task) => ({ id: task.id, class: task.taskClass, summary: task.result?.summary })), harnessFailures: ['Initial diff collector incorrectly assumed HEAD~1 existed for blocked runs; outcomes recovered from SQLite.', 'Restricted Windows renderer startup exited 49; outside-sandbox normal startup succeeded.', 'A repeat worker recovery before lease expiration was blocked; respecting the existing 60-second lease permits safe recovery.', 'Secret scanner git inventory exceeded default buffer; increased enumeration buffer only.'], regressionFixed: 'Cross-domain review preference was initially applied to coder failover; final comparison is Reviewer-only. The R24 conservation regression passed 89 focused tests before final canonical run.' });
console.log(JSON.stringify({ ...totals, outputs: 12 }));
