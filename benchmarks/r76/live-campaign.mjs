import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile as callback } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { ForgeZero, CapacityReservationLedger } from '@codeforge/forge-zero';
import { createKiloFreeDirectAdapter, createBlockRunFreeAdapter, InMemoryProviderCatalog, ProviderCapacityGovernor, DEFAULT_FALLBACK_LIMITS } from '@codeforge/providers';
import { FreeCloudService, NormalizedModelRegistry, reverifyKiloPolicy, reverifyBlockRunPolicy } from '@codeforge/model-registry';
import { createEightBitRouteHealthAuthority, createFreeFabric, roleQualificationStatusFor } from '@codeforge/eight-bit';
import { createSessionPersistence, EventStore } from '@codeforge/sessions';
import { createAgentRuntime, createWorkspaceService, createWorkspaceEventAdapter, createAutonomousRunOrchestrator } from '@codeforge/server';
import { taskAt } from '../r71/tasks.mjs';
import { traceProvider } from '../r73/trace-provider.mjs';
import { snapshotSource } from '../r74/source-snapshot.mjs';

const execFile = promisify(callback);
const directory = 'docs/evidence/r76-free-supply-recovery-and-reliability';
const campaignName = process.env.R76_CAMPAIGN_NAME ?? `R76-TASK-CAMPAIGN-${Date.now()}`;
const sourceDiff = (await execFile('git', ['-c', 'core.fsmonitor=false', 'diff'])).stdout;
const campaign = { startedAt: new Date().toISOString(), evidenceClass: 'LIVE_ANONYMOUS_FREE_PUBLIC_FIXTURES', sourceRevision: (await execFile('git', ['rev-parse', 'HEAD'])).stdout.trim(), sourceDiffSha256: createHash('sha256').update(sourceDiff).digest('hex'), sourceDirty: sourceDiff.length > 0, status: 'RUNNING', tasks: [], supply: [], inferenceFrames: [], costState: 'UNKNOWN' };
const source = await snapshotSource();
campaign.sourceFilesSha256 = source.sha256;
campaign.sourceManifest = `${campaignName}-source.json`;
await writeFile(`${directory}/${campaign.sourceManifest}`, `${JSON.stringify(source, null, 2)}\n`);
const persist = () => writeFile(`${directory}/${campaignName}.json`, `${JSON.stringify(campaign, null, 2)}\n`);
const root = await mkdtemp(path.join(tmpdir(), 'codeforge-r76-campaign-'));
const count = Math.min(20, Number(process.argv[2] ?? 1));
const offset = Number(process.env.R76_TASK_OFFSET ?? 0);
const owner = 'r76-public-user';
const firewall = new ForgeZero();
firewall.setPrivacyMode('MAXIMUM_FREE');
const catalog = new InMemoryProviderCatalog();
const health = createEightBitRouteHealthAuthority();
if (process.env.R76_PRIOR_CAMPAIGN) {
  const prior = JSON.parse(await readFile(process.env.R76_PRIOR_CAMPAIGN, 'utf8'));
  for (const snapshot of prior.tasks.at(-1)?.routeHealth ?? []) health.hydrate(snapshot);
  campaign.priorHealthEvidence = process.env.R76_PRIOR_CAMPAIGN;
}
const freeCloud = new FreeCloudService({ firewall, providerCatalog: catalog, registry: new NormalizedModelRegistry(), routeHealth: health, useBundledRoleEvidence: true });
const capacityGovernor = new ProviderCapacityGovernor();
const policyChecks = new Map();
await mkdir(root, { recursive: true });
try {
  await freeCloud.loadQualification();
  const explicitReceipts = process.argv.slice(3);
  const qualifications = explicitReceipts.length > 0
    ? await Promise.all(explicitReceipts.map(async source => ({ source, document: JSON.parse(await readFile(source, 'utf8')) })))
    : [['kilo-free-direct', 'cohere/north-mini-code:free'], ['kilo-free-direct', 'nvidia/nemotron-3-ultra-550b-a55b:free'], ['kilo-free-direct', 'nvidia/nemotron-3-super-120b-a12b:free'], ['blockrun-free-direct', 'nvidia/llama-3.2-11b-vision']].map(([providerId, modelId]) => ({ source: `bundled:${providerId}/${modelId}`, document: freeCloud.getReceipt(providerId, modelId) }));
  if (process.env.R76_ALTERNATE_RECEIPT) qualifications.push({ source: process.env.R76_ALTERNATE_RECEIPT, document: JSON.parse(await readFile(process.env.R76_ALTERNATE_RECEIPT, 'utf8')) });
  campaign.qualificationMode = explicitReceipts.length > 0 ? 'EXPLICIT_LIVE_RECEIPTS' : 'INSTALLED_BUNDLED_LIVE_ROLE_EVIDENCE';
  for (const { source: qualificationPath, document } of qualifications) {
    if (!document) throw new Error('CURRENT_BUNDLED_ROLE_EVIDENCE_UNAVAILABLE');
    const qualification = document.qualification ?? document.receipt ?? document;
    const blockrun = qualification.providerId === 'blockrun-free-direct';
    if (!blockrun && qualification.providerId !== 'kilo-free-direct') throw new Error('UNSUPPORTED_LIVE_PROVIDER');
    const rawAdapter = (blockrun ? createBlockRunFreeAdapter : createKiloFreeDirectAdapter)({ onResponse: observation => {
      capacityGovernor.observeResponse(observation);
      freeCloud.onProviderResponse(observation);
    } });
    const adapter = capacityGovernor.wrapAdapter(traceProvider(rawAdapter, campaign, persist));
    const policyFn = blockrun ? reverifyBlockRunPolicy : reverifyKiloPolicy;
    let policy = policyChecks.get(adapter.providerId);
    if (!policy) {
      policy = await policyFn(new Date().toISOString());
      policyChecks.set(adapter.providerId, policy);
      campaign.policyReverification ??= [];
      campaign.policyReverification.push({ providerId: adapter.providerId, ...policy, receipt: undefined });
    }
    if (policy.status !== 'VERIFIED') {
      campaign.supply.push({ providerId: adapter.providerId, status: 'POLICY_DENIED', policyStatus: policy.status, policySource: policy.source, observedHash: policy.observedHash });
      continue;
    }
    const roleStatuses = Object.fromEntries(Object.keys(qualification.roleResults).map(role => [role, roleQualificationStatusFor(qualification, role)]));
    if (qualification.metadata?.transient || !Object.values(roleStatuses).some(status => status === 'QUALIFIED')) throw new Error('CURRENT_CONCLUSIVE_QUALIFICATION_REQUIRED');
    const models = await adapter.listModels();
    const model = models.find((item) => item.modelId === qualification.modelId && item.isFree && item.freeStatus === 'verified_free');
    if (!model) { campaign.supply.push({ providerId: adapter.providerId, status: 'MODEL_ABSENT', modelId: qualification.modelId }); continue; }
    catalog.register(adapter);
    const now = new Date().toISOString();
    firewall.register({ providerId: adapter.providerId, modelId: model.modelId, displayName: model.displayName, tier: 'free', accessClass: 'FREE_ROUTED', privacyClass: 'permissive', freeStatus: 'verified_free', freeStatusVerifiedAt: now, capabilities: model.capabilities, contextWindow: model.contextWindow, isRemote: true, isCloudHosted: true, verificationSource: 'live anonymous catalog and freshly reverified pinned policy', costProfile: { isFree: true, inputCostPerMillion: 0, outputCostPerMillion: 0, freeTierVerifiedAt: now, paidFallbackPossible: false, paidFallbackDisabled: true }, health: { status: 'available', lastCheckedAt: now } });
    freeCloud.setConnection({ providerId: adapter.providerId, connected: true, credentialSource: 'ANONYMOUS_DIRECT', authState: 'ok', ownerUserId: owner, ...(adapter.providerId === 'ai-horde' ? { supplyClass: 'COMMUNITY_ANONYMOUS_FREE' } : {}) });
    freeCloud.setDirectPolicyReceipt(adapter.providerId, policy.receipt);
    await freeCloud.recordReceipt(qualification);
    freeCloud.applyReceiptToFirewall(qualification);
    campaign.supply.push({ providerId: adapter.providerId, modelId: model.modelId, qualificationAt: qualification.completedAt, qualificationSource: qualificationPath, qualificationFreshness: 'PRODUCTION_ROLE_QUALITY_AUTHORITY', roles: roleStatuses });
  }
  for (const role of ['EXPLORER', 'PLANNER', 'CODER', 'REVIEWER']) {
    if (!campaign.supply.some(route => route.roles?.[role] === 'QUALIFIED')) throw new Error(`CURRENT_QUALIFIED_${role}_ROSTER_UNAVAILABLE`);
  }
  campaign.routeAdmissionSnapshot = freeCloud.snapshot().models.flatMap(model => model.routes
    .filter(route => campaign.supply.some(source => source.providerId === route.providerId && source.modelId === route.providerModelId))
    .map(route => ({
      providerId: route.providerId,
      modelId: route.providerModelId,
      health: route.health,
      toolSupport: route.toolSupport,
      qualificationState: route.qualificationState,
      roleSuitability: route.roleSuitability,
      forgeAutoEligible: route.forgeAutoEligible,
      admission: route.admission,
      runtimeRequalificationRoles: freeCloud.runtimeRequalificationRoles(route.providerId, route.providerModelId),
      reviewerStatus: roleQualificationStatusFor(freeCloud.getQualificationReceipt(route.providerId, route.providerModelId), 'REVIEWER'),
    })));
  if (process.env.R76_DIAG_ONLY === '1') {
    const diagnosticReservations = new CapacityReservationLedger({ routes: [], pools: [] });
    const diagnosticFabric = createFreeFabric({ managedRoutes: () => freeCloud.productionCapacityRoutes().filter((route) => route.capacityPoolScope !== 'PER_USER_POOL'), userSources: [freeCloud], health, reservations: diagnosticReservations });
    const diagnosticWorkspace = await mkdtemp(path.join(root, 'reviewer-admission-'));
    const diagnosticSession = `r76-reviewer-admission-${Date.now()}`;
    const diagnosticPersistence = createSessionPersistence({ dbPath: path.join(root, 'reviewer-admission.db') });
    await diagnosticPersistence.init();
    await diagnosticPersistence.upsertSession({ id: diagnosticSession, title: 'Reviewer admission diagnostic', status: 'idle', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    const diagnosticRuntime = createAgentRuntime({ sessionId: diagnosticSession, eventStore: new EventStore(), persistence: diagnosticPersistence, firewall, providerCatalog: catalog, workspacePath: diagnosticWorkspace, userId: owner, routeHealth: health, freeCloud, freeFabric: diagnosticFabric, fabricContext: () => ({ userId: owner, userIdentities: freeCloud.capacityIdentitiesFor(owner), dataContext: { dataClass: 'PUBLIC_CODE', userConsented: true } }) });
    await diagnosticRuntime.init();
    const reviewerFilter = diagnosticRuntime.roleRouteFilter('REVIEWER');
    const reviewerRoute = campaign.supply.find(route => route.roles?.REVIEWER === 'QUALIFIED');
    const reviewerRouteAllowed = reviewerRoute ? reviewerFilter?.(reviewerRoute.providerId, reviewerRoute.modelId) : false;
    const diagnosticTurnId = 'reviewer-admission-only';
    diagnosticRuntime.turnCapacityHints.set(diagnosticTurnId, { role: 'REVIEWER' });
    const fabricDecision = diagnosticRuntime.admitForTurn(diagnosticTurnId);
    diagnosticRuntime.eightBit.releaseFabricAdmission(`forgeauto:${diagnosticTurnId}`);
    campaign.runtimeReviewerAdmission = {
      modelSelection: diagnosticRuntime.getModelSelection(),
      reviewerRoute: reviewerRoute ? { providerId: reviewerRoute.providerId, modelId: reviewerRoute.modelId } : undefined,
      reviewerRouteAllowed,
      fabricOutcome: fabricDecision?.outcome,
      selectedRoute: fabricDecision?.selected ? { providerId: fabricDecision.selected.providerId, modelId: fabricDecision.selected.modelId } : undefined,
      reasonCodes: fabricDecision?.explanation.reasonCodes,
    };
    await diagnosticPersistence.close();
    campaign.status = 'DIAGNOSTIC_ONLY';
    campaign.finishedAt = new Date().toISOString();
    await persist();
    console.log(JSON.stringify({ status: campaign.status, routeAdmissionSnapshot: campaign.routeAdmissionSnapshot, runtimeReviewerAdmission: campaign.runtimeReviewerAdmission }));
    process.exit(0);
  }
  campaign.capacityMeasurement = 'LIVE_PRODUCTION_OBSERVATIONS_ONLY_NO_REPEATED_HEADERLESS_PINGS';
  campaign.capacityLimits = DEFAULT_FALLBACK_LIMITS;
  campaign.costState = 'CATALOG_VERIFIED_EXACT_ZERO_NO_CREDENTIALS_NO_PAID_FALLBACK';
  const pinnedCoder = process.env.R76_CODER_MODEL;
  const pinnedProvider = process.env.R76_CODER_PROVIDER;
  const rosterCatalog = campaign.supply.filter(row => row.modelId && row.roles).map(row => {
    const qualifiedRoles = Object.entries(row.roles).filter(([role, status]) => status === 'QUALIFIED' && ['EXPLORER', 'PLANNER', 'CODER', 'REVIEWER'].includes(role)).map(([role]) => role);
    return { modelId: `${row.providerId}/${row.modelId}`, providerId: row.providerId, providerModelId: row.modelId, familyId: `${row.providerId}/${row.modelId}`, version: 'exact', sourceClass: 'MANAGED_FREE', lifecycle: 'ACTIVE', available: true, approved: true, qualifiedRoles, dataPolicy: { privateCode: false, userConsentRequired: true } };
  });
  const roster = pinnedCoder ? {
    ownerUserId: owner, entitlement: 'FREE', lead: { mode: 'NONE' }, updatedAt: new Date().toISOString(),
    slots: rosterCatalog.map(row => ({ kind: 'PINNED_VERSION', modelId: row.modelId, enabled: true, allowedRoles: row.qualifiedRoles.filter(role => role !== 'CODER' || row.providerId === pinnedProvider && row.providerModelId === pinnedCoder) })).filter(slot => slot.allowedRoles.length > 0),
  } : undefined;
  if (pinnedCoder && !rosterCatalog.some(row => row.providerId === pinnedProvider && row.providerModelId === pinnedCoder && row.qualifiedRoles.includes('CODER'))) throw new Error('PINNED_CODER_NOT_CURRENTLY_QUALIFIED');
  campaign.coderRoster = roster;
  campaign.declaredSequence = Array.from({ length: count }, (_, index) => taskAt(index + offset)).map(task => ({ id: task.id, taskClass: task.taskClass, goal: task.goal }));
  await persist();
  const reservations = new CapacityReservationLedger({ routes: [], pools: [] });
  const fabric = createFreeFabric({ managedRoutes: () => freeCloud.productionCapacityRoutes().filter((route) => route.capacityPoolScope !== 'PER_USER_POOL'), userSources: [freeCloud], health, reservations });
  for (let index = 0; index < count; index++) {
    const task = taskAt(index + offset);
    const workspacePath = await mkdtemp(path.join(root, 'public-task-'));
    const taskEvidence = { id: task.id, taskClass: task.taskClass, startedAt: new Date().toISOString(), workspacePath, inferenceFramesStart: campaign.inferenceFrames.length, status: 'RUNNING' };
    campaign.tasks.push(taskEvidence);
    await persist();
    let persistence;
    try {
      for (const [file, content] of Object.entries(task.files)) { await mkdir(path.dirname(path.join(workspacePath, file)), { recursive: true }); await writeFile(path.join(workspacePath, file), content); }
      await writeFile(path.join(workspacePath, 'package.json'), `${JSON.stringify({ name: 'r74-public-fixture', type: 'module', private: true, scripts: { test: 'node --test' }, ...task.package }, null, 2)}\n`);
      for (const args of [['init'], ['config', 'user.name', 'CodeForge Public Fixture'], ['config', 'user.email', 'fixture@codeforge.invalid'], ['config', 'commit.gpgsign', 'false'], ['add', '.'], ['commit', '-m', `Public ${task.taskClass} baseline`]]) await execFile('git', args, { cwd: workspacePath, windowsHide: true });
      const testsBefore = await execFile(process.execPath, ['--test'], { cwd: workspacePath, windowsHide: true }).then(({ stdout }) => ({ exitCode: 0, output: stdout })).catch((error) => ({ exitCode: error.code, output: `${error.stdout ?? ''}${error.stderr ?? ''}` }));
      taskEvidence.testsBefore = testsBefore;
      persistence = createSessionPersistence({ dbPath: path.join(workspacePath, '..', `${path.basename(workspacePath)}.db`) });
      await persistence.init();
      const sessionId = `r74-${task.id}-${Date.now()}`;
      await persistence.upsertSession({ id: sessionId, title: task.taskClass, status: 'idle', createdAt: taskEvidence.startedAt, updatedAt: taskEvidence.startedAt });
      const events = new EventStore();
      const runtime = createAgentRuntime({ sessionId, eventStore: events, persistence, firewall, providerCatalog: catalog, workspacePath, userId: owner, routeHealth: health, freeCloud, freeFabric: fabric, fabricContext: () => ({ userId: owner, userIdentities: freeCloud.capacityIdentitiesFor(owner), dataContext: { dataClass: 'PUBLIC_CODE', userConsented: true } }) });
      await runtime.init();
      if (!campaign.admissionTracePatched) {
        const prototype = Object.getPrototypeOf(runtime);
        const admitForTurn = prototype.admitForTurn;
        prototype.admitForTurn = function (turnId) {
          const hint = this.turnCapacityHints.get(turnId);
          const role = hint?.role ?? 'CODER';
          const selection = this.modelSelection;
          const roleFilter = this.roleRouteFilter(role);
          const routeChecks = campaign.supply.map(route => ({
            providerId: route.providerId,
            modelId: route.modelId,
            roleAllowed: roleFilter?.(route.providerId, route.modelId) ?? true,
            selectionAllowed: !selection || selection.providerId === 'paid-auto'
              || (selection.lock === 'route'
                ? selection.providerId === route.providerId && selection.modelId === route.modelId
                : (selection.providerId === route.providerId && selection.modelId === route.modelId)
                  || (!!selection.canonicalModelId && freeCloud.canonicalIdOf(route.providerId, route.modelId) === selection.canonicalModelId)),
          }));
          const decision = admitForTurn.call(this, turnId);
          campaign.admissionTraces ??= [];
          campaign.admissionTraces.push({ role, selection, routeChecks, outcome: decision?.outcome, selected: decision?.selected ? { providerId: decision.selected.providerId, modelId: decision.selected.modelId } : undefined, reasonCodes: decision?.explanation.reasonCodes });
          return decision;
        };
        campaign.admissionTracePatched = true;
      }
      const orchestrator = createAutonomousRunOrchestrator({ workspaceService: createWorkspaceService({ persistence, worktreeParentDir: path.join(root, 'worktrees') }), persistence, agentRuntime: runtime, subagentsR1Enabled: true });
      const result = await orchestrator.startRun({ sessionId, workspacePath, topology: 'fixed_r1', goal: `${task.goal} This is a public synthetic fixture with no user source, credentials, or confidential data.`, verificationCommands: ['node --test'], ...(roster ? { rosterContext: { roster, catalog: rosterCatalog, dataContext: { privateCode: false, userConsented: true } } } : {}), adapter: createWorkspaceEventAdapter({ sessionId, eventStore: events, persistence }), signal: AbortSignal.timeout(600_000) });
      taskEvidence.result = result;
      taskEvidence.status = result.status;
      await persist();
      const testsAfter = await execFile(process.execPath, ['--test'], { cwd: workspacePath, windowsHide: true }).then(({ stdout }) => ({ exitCode: 0, output: stdout })).catch((error) => ({ exitCode: error.code, output: `${error.stdout ?? ''}${error.stderr ?? ''}` }));
      const workers = await persistence.getWorkItemsByKind('subagent_run');
      taskEvidence.journals = await persistence.getWorkItemsByKind('agent_run_journal');
      const decisions = await persistence.getWorkItemsByKind('eight_bit_decision_receipt');
      const turns = await persistence.getWorkItemsByKind('agent_model_turn');
      const diff = (await execFile('git', ['diff', result.baseRevision, 'HEAD'], { cwd: workspacePath, windowsHide: true })).stdout;
      const inferenceFrames = campaign.inferenceFrames.slice(taskEvidence.inferenceFramesStart);
      Object.assign(taskEvidence, { status: result.status, result, testsAfter, workers, decisions, turns, inferenceRequestSummary: summarizeInferenceRequests(inferenceFrames, turns), verificationRecords: await persistence.getWorkItemsByKind('verification'), parentRecords: await persistence.getWorkItemsByKind('autonomous_run'), parentStates: await persistence.getWorkItemsByKind('autonomous_parent_state'), experience: await persistence.getWorkItemsByKind('generalized_experience_signal'), diff, diffSha256: createHash('sha256').update(diff).digest('hex'), routeHealth: health.snapshot(), capacityGovernor: capacityReportSnapshot(turns), rssBytes: process.memoryUsage().rss, reservations: reservations.snapshot() });
      if (result.status === 'completed' && (result.completion?.outcome !== 'completed' || !result.review?.passed || !result.verification?.every((item) => item.passed) || result.integration?.status !== 'integrated' || testsAfter.exitCode !== 0)) throw new Error('FALSE_COMPLETION_OBSERVED');
      if (result.status === 'completed' && !taskEvidence.parentStates.some(state => state.runId === result.runId && state.phase === 'completed')) throw new Error('DURABLE_PARENT_COMPLETION_MISSING');
    } catch (error) { taskEvidence.status = 'FAILED'; taskEvidence.error = String(error); }
    finally { if (persistence) await persistence.close(); taskEvidence.finishedAt = new Date().toISOString(); taskEvidence.wallTimeMs = Date.parse(taskEvidence.finishedAt) - Date.parse(taskEvidence.startedAt); await persist(); }
    console.log(JSON.stringify({ id: task.id, status: taskEvidence.status, timeMs: taskEvidence.wallTimeMs, error: taskEvidence.error }));
    if (taskEvidence.error === 'Error: FALSE_COMPLETION_OBSERVED') break;
    if (campaign.tasks.length >= 2 && campaign.tasks.slice(-2).every(item => item.status !== 'completed')) { campaign.stopReason = 'TWO_CONSECUTIVE_NONCOMPLETIONS_STOP_SCARCE_QUOTA'; break; }
  }
  campaign.status = campaign.tasks.every((task) => task.status === 'completed') ? 'PASS' : 'PARTIAL';
} catch (error) { campaign.status = 'BLOCKED'; campaign.error = String(error); }
campaign.finishedAt = new Date().toISOString();
campaign.inferenceRequestSummary = summarizeInferenceRequests(campaign.inferenceFrames, campaign.tasks.flatMap(task => task.turns ?? []));
campaign.capacityGovernorFinal = capacityReportSnapshot(campaign.tasks.flatMap(task => task.turns ?? []));
await persist();
console.log(JSON.stringify({ status: campaign.status, attempted: campaign.tasks.length, completed: campaign.tasks.filter((task) => task.status === 'completed').length, error: campaign.error }));

function summarizeInferenceRequests(frames, turns) {
  const byProviderModel = new Map();
  for (const frame of frames) {
    const key = `${frame.providerId}/${frame.request?.model ?? 'unknown'}`;
    const row = byProviderModel.get(key) ?? { providerId: frame.providerId, modelId: frame.request?.model ?? 'unknown', requests: 0, failed: 0, errors: {} };
    row.requests++;
    if (frame.error) {
      row.failed++;
      const code = frame.error.code ?? 'UNKNOWN';
      row.errors[code] = (row.errors[code] ?? 0) + 1;
    }
    byProviderModel.set(key, row);
  }
  const byAgent = new Map();
  for (const turn of turns) {
    const agentId = turn.agentId ?? 'unknown';
    const row = byAgent.get(agentId) ?? { agentId, modelTurns: 0, providerRequestsStarted: 0 };
    row.modelTurns++;
    if (turn.state === 'provider_request_started') row.providerRequestsStarted++;
    byAgent.set(agentId, row);
  }
  return {
    physicalProviderRequests: frames.length,
    failedRequests: frames.filter(frame => frame.error).length,
    byProviderModel: [...byProviderModel.values()],
    byAgentModelTurns: [...byAgent.values()],
  };
}

function capacityReportSnapshot(turns = []) {
  const domains = new Map();
  for (const turn of turns) {
    const providerId = turn.servedProviderId;
    const quotaDomainId = turn.quotaDomainId;
    if (!providerId || !quotaDomainId) continue;
    const key = `${providerId}::${quotaDomainId}`;
    const governor = capacityGovernor.quotaDomainGovernor(providerId, quotaDomainId);
    if (governor) domains.set(key, { providerId, quotaDomainId, report: governor.getCapacityReport(providerId) });
  }
  return {
    kilo: capacityGovernor.getCapacityReport('kilo-free-direct'),
    blockrun: capacityGovernor.getCapacityReport('blockrun-free-direct'),
    quotaDomains: [...domains.values()],
  };
}
