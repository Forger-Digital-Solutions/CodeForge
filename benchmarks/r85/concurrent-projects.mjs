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
import { taskAt } from './project-specs.mjs';
import { traceProvider } from '../r73/trace-provider.mjs';
import { snapshotSource } from '../r74/source-snapshot.mjs';

const execFile = promisify(callback);
const directory = 'docs/evidence/r85-free-onboarding-autonomy-and-forgeaaa-review';
const campaignName = process.env.R85_CAMPAIGN_NAME ?? `R85-CONCURRENT-CAMPAIGN-${Date.now()}`;
const sourceDiff = (await execFile('git', ['-c', 'core.fsmonitor=false', 'diff'])).stdout;
const campaign = { startedAt: new Date().toISOString(), evidenceClass: 'INTERNAL_PUBLIC_FIXTURE_EVALUATION_NOT_PRODUCTION_ENTITLEMENT', mode: 'TWO_PROJECT_CONCURRENT', sourceRevision: (await execFile('git', ['rev-parse', 'HEAD'])).stdout.trim(), sourceDiffSha256: createHash('sha256').update(sourceDiff).digest('hex'), sourceDirty: sourceDiff.length > 0, status: 'RUNNING', tasks: [], supply: [], inferenceFrames: [], costState: 'UNKNOWN' };
const source = await snapshotSource();
campaign.sourceFilesSha256 = source.sha256;
campaign.sourceManifest = `${campaignName}-source.json`;
await mkdir(directory, { recursive: true });
await writeFile(`${directory}/${campaign.sourceManifest}`, `${JSON.stringify(source, null, 2)}\n`);
const persist = () => writeFile(`${directory}/${campaignName}.json`, `${JSON.stringify(campaign, null, 2)}\n`);
const root = await mkdtemp(path.join(tmpdir(), 'codeforge-r85-concurrent-'));
const owner = 'r85-public-user';
const firewall = new ForgeZero();
firewall.setPrivacyMode('MAXIMUM_FREE');
const catalog = new InMemoryProviderCatalog();
const health = createEightBitRouteHealthAuthority();
const freeCloud = new FreeCloudService({ firewall, providerCatalog: catalog, registry: new NormalizedModelRegistry(), routeHealth: health, useBundledRoleEvidence: true });
const capacityGovernor = new ProviderCapacityGovernor();
const policyChecks = new Map();
await mkdir(root, { recursive: true });
try {
  await freeCloud.loadQualification();
  const explicitReceipts = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const qualifications = [['kilo-free-direct', 'cohere/north-mini-code:free'], ['kilo-free-direct', 'nvidia/nemotron-3-ultra-550b-a55b:free'], ['kilo-free-direct', 'nvidia/nemotron-3-super-120b-a12b:free'], ['blockrun-free-direct', 'nvidia/llama-3.2-11b-vision']].map(([providerId, modelId]) => ({ source: `bundled:${providerId}/${modelId}`, document: freeCloud.getReceipt(providerId, modelId) }));
  for (const source of explicitReceipts) qualifications.push({ source, document: JSON.parse(await readFile(source, 'utf8')) });
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
    if (qualification.metadata?.transient || !Object.values(roleStatuses).some(status => status === 'QUALIFIED')) {
      campaign.supply.push({ providerId: adapter.providerId, modelId: qualification.modelId, status: 'QUALIFICATION_INCONCLUSIVE', roles: roleStatuses });
      continue;
    }
    const models = await adapter.listModels();
    const model = models.find((item) => item.modelId === qualification.modelId && item.isFree && item.freeStatus === 'verified_free');
    if (!model) { campaign.supply.push({ providerId: adapter.providerId, status: 'MODEL_ABSENT', modelId: qualification.modelId }); continue; }
    catalog.register(adapter);
    const now = new Date().toISOString();
    firewall.register({ providerId: adapter.providerId, modelId: model.modelId, displayName: model.displayName, tier: 'free', accessClass: 'FREE_ROUTED', privacyClass: 'permissive', freeStatus: 'verified_free', freeStatusVerifiedAt: now, capabilities: model.capabilities, contextWindow: model.contextWindow, isRemote: true, isCloudHosted: true, verificationSource: 'live anonymous catalog and freshly reverified pinned policy', costProfile: { isFree: true, inputCostPerMillion: 0, outputCostPerMillion: 0, freeTierVerifiedAt: now, paidFallbackPossible: false, paidFallbackDisabled: true }, health: { status: 'available', lastCheckedAt: now } });
    freeCloud.setConnection({ providerId: adapter.providerId, connected: true, credentialSource: 'ANONYMOUS_DIRECT', authState: 'ok', ownerUserId: owner });
    freeCloud.setDirectPolicyReceipt(adapter.providerId, policy.receipt);
    await freeCloud.recordReceipt(qualification);
    freeCloud.applyReceiptToFirewall(qualification);
    campaign.supply.push({ providerId: adapter.providerId, modelId: model.modelId, qualificationAt: qualification.completedAt, qualificationSource: qualificationPath, qualificationFreshness: 'PRODUCTION_ROLE_QUALITY_AUTHORITY', roles: roleStatuses });
  }
  for (const role of ['EXPLORER', 'PLANNER', 'CODER', 'REVIEWER']) {
    if (!campaign.supply.some(route => route.roles?.[role] === 'QUALIFIED')) throw new Error(`CURRENT_QUALIFIED_${role}_ROSTER_UNAVAILABLE`);
  }
  campaign.capacityMeasurement = 'LIVE_PRODUCTION_OBSERVATIONS_ONLY_NO_REPEATED_HEADERLESS_PINGS';
  campaign.capacityLimits = DEFAULT_FALLBACK_LIMITS;
  campaign.costState = 'CATALOG_VERIFIED_EXACT_ZERO_NO_CREDENTIALS_NO_PAID_FALLBACK';
  const rosterCatalog = campaign.supply.filter(row => row.modelId && row.roles).map(row => {
    const qualifiedRoles = Object.entries(row.roles).filter(([role, status]) => status === 'QUALIFIED' && ['EXPLORER', 'PLANNER', 'CODER', 'REVIEWER'].includes(role)).map(([role]) => role);
    return { modelId: `${row.providerId}/${row.modelId}`, providerId: row.providerId, providerModelId: row.modelId, familyId: `${row.providerId}/${row.modelId}`, version: 'exact', sourceClass: 'MANAGED_FREE', lifecycle: 'ACTIVE', available: true, approved: true, qualifiedRoles, dataPolicy: { privateCode: false, userConsentRequired: true } };
  });
  // Per-project coder pinning: project A uses the Kilo coder, project B uses the BlockRun coder
  // when one is currently admitted; otherwise both fall back to the same qualified coder roster
  // and the scheduler's FIFO fairness is what is being measured.
  const coders = campaign.supply.filter(row => row.roles?.CODER === 'QUALIFIED');
  const coderA = coders.find(row => row.providerId === 'kilo-free-direct') ?? coders[0];
  const coderB = coders.find(row => row.providerId === 'blockrun-free-direct' && row !== coderA) ?? coderA;
  campaign.domainSeparation = coderA.providerId !== coderB.providerId ? 'TWO_INDEPENDENT_QUOTA_DOMAINS' : 'SINGLE_DOMAIN_FAIR_INTERLEAVING';
  const buildRoster = (coder) => ({
    ownerUserId: owner, entitlement: 'FREE', lead: { mode: 'NONE' }, updatedAt: new Date().toISOString(),
    slots: rosterCatalog.map(row => ({ kind: 'PINNED_VERSION', modelId: row.modelId, enabled: true, allowedRoles: row.qualifiedRoles.filter(role => role !== 'CODER' || (row.providerId === coder.providerId && row.providerModelId === coder.modelId)) })).filter(slot => slot.allowedRoles.length > 0),
  });
  const rosterA = buildRoster(coderA);
  const rosterB = buildRoster(coderB);
  campaign.coderAssignment = { projectA: `${coderA.providerId}/${coderA.modelId}`, projectB: `${coderB.providerId}/${coderB.modelId}` };
  const reservations = new CapacityReservationLedger({ routes: [], pools: [] });
  const fabric = createFreeFabric({ managedRoutes: () => freeCloud.productionCapacityRoutes().filter((route) => route.capacityPoolScope !== 'PER_USER_POOL'), userSources: [freeCloud], health, reservations });
  await persist();
  const runTask = async (taskIndex, roster, projectLabel) => {
    const task = taskAt(taskIndex);
    const workspacePath = await mkdtemp(path.join(root, `public-${projectLabel}-`));
    const taskEvidence = { id: task.id, project: projectLabel, taskClass: task.taskClass, startedAt: new Date().toISOString(), workspacePath, inferenceFramesStart: campaign.inferenceFrames.length, status: 'RUNNING' };
    campaign.tasks.push(taskEvidence);
    await persist();
    let persistence;
    try {
      for (const [file, content] of Object.entries(task.files)) { await mkdir(path.dirname(path.join(workspacePath, file)), { recursive: true }); await writeFile(path.join(workspacePath, file), content); }
      await writeFile(path.join(workspacePath, 'package.json'), `${JSON.stringify({ name: `r85-public-${projectLabel}`, type: 'module', private: true, scripts: { test: 'node --test' }, ...task.package }, null, 2)}\n`);
      for (const args of [['init'], ['config', 'user.name', 'CodeForge Public Fixture'], ['config', 'user.email', 'fixture@codeforge.invalid'], ['config', 'commit.gpgsign', 'false'], ['add', '.'], ['commit', '-m', `Public ${task.taskClass} baseline`]]) await execFile('git', args, { cwd: workspacePath, windowsHide: true });
      const testsBefore = await execFile(process.execPath, ['--test'], { cwd: workspacePath, windowsHide: true }).then(({ stdout }) => ({ exitCode: 0, output: stdout })).catch((error) => ({ exitCode: error.code, output: `${error.stdout ?? ''}${error.stderr ?? ''}` }));
      taskEvidence.testsBefore = testsBefore;
      persistence = createSessionPersistence({ dbPath: path.join(workspacePath, '..', `${path.basename(workspacePath)}.db`) });
      await persistence.init();
      const sessionId = `r85-${projectLabel}-${task.id}-${Date.now()}`;
      await persistence.upsertSession({ id: sessionId, title: task.taskClass, status: 'idle', createdAt: taskEvidence.startedAt, updatedAt: taskEvidence.startedAt });
      const events = new EventStore();
      const runtime = createAgentRuntime({ sessionId, eventStore: events, persistence, firewall, providerCatalog: catalog, workspacePath, userId: owner, routeHealth: health, freeCloud, freeFabric: fabric, fabricContext: () => ({ userId: owner, userIdentities: freeCloud.capacityIdentitiesFor(owner), dataContext: { dataClass: 'PUBLIC_CODE', userConsented: true } }) });
      await runtime.init();
      const orchestrator = createAutonomousRunOrchestrator({ workspaceService: createWorkspaceService({ persistence, worktreeParentDir: path.join(root, 'worktrees') }), persistence, agentRuntime: runtime, subagentsR1Enabled: true });
      const result = await orchestrator.startRun({ sessionId, workspacePath, topology: 'fixed_r1', goal: `${task.goal} This is a public synthetic fixture with no user source, credentials, or confidential data.`, verificationCommands: ['node --test'], rosterContext: { roster, catalog: rosterCatalog, dataContext: { privateCode: false, userConsented: true } }, adapter: createWorkspaceEventAdapter({ sessionId, eventStore: events, persistence }), signal: AbortSignal.timeout(420_000) });
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
      Object.assign(taskEvidence, { status: result.status, result, testsAfter, workers, decisions, turns, inferenceRequestSummary: summarizeInferenceRequests(inferenceFrames, turns), verificationRecords: await persistence.getWorkItemsByKind('verification'), parentRecords: await persistence.getWorkItemsByKind('autonomous_run'), parentStates: await persistence.getWorkItemsByKind('autonomous_parent_state'), diff, diffSha256: createHash('sha256').update(diff).digest('hex'), routeHealth: health.snapshot() });
      if (result.status === 'completed' && (result.completion?.outcome !== 'completed' || !result.review?.passed || !result.verification?.every((item) => item.passed) || result.integration?.status !== 'integrated' || testsAfter.exitCode !== 0)) throw new Error('FALSE_COMPLETION_OBSERVED');
      if (result.status === 'completed' && !taskEvidence.parentStates.some(state => state.runId === result.runId && state.phase === 'completed')) throw new Error('DURABLE_PARENT_COMPLETION_MISSING');
    } catch (error) { taskEvidence.status = 'FAILED'; taskEvidence.error = String(error); }
    finally { if (persistence) await persistence.close(); taskEvidence.finishedAt = new Date().toISOString(); taskEvidence.wallTimeMs = Date.parse(taskEvidence.finishedAt) - Date.parse(taskEvidence.startedAt); await persist(); }
    console.log(JSON.stringify({ id: task.id, project: projectLabel, status: taskEvidence.status, timeMs: taskEvidence.wallTimeMs, error: taskEvidence.error }));
  };
  const taskIndexA = Number(process.env.R85_TASK_A ?? 0);
  const taskIndexB = Number(process.env.R85_TASK_B ?? 1);
  campaign.declaredSequence = [taskAt(taskIndexA), taskAt(taskIndexB)].map(task => ({ id: task.id, taskClass: task.taskClass, goal: task.goal }));
  const t0 = Date.now();
  await Promise.all([runTask(taskIndexA, rosterA, 'project-a'), runTask(taskIndexB, rosterB, 'project-b')]);
  campaign.concurrentWallTimeMs = Date.now() - t0;
  const completed = campaign.tasks.filter(task => task.status === 'completed').length;
  campaign.status = completed === 2 ? 'PASS' : completed === 1 ? 'PARTIAL' : 'FAILED';
} catch (error) { campaign.status = 'BLOCKED'; campaign.error = String(error); }
campaign.finishedAt = new Date().toISOString();
campaign.inferenceRequestSummary = summarizeInferenceRequests(campaign.inferenceFrames, campaign.tasks.flatMap(task => task.turns ?? []));
campaign.reservations = reservations.snapshot();
campaign.capacityGovernorFinal = { kilo: capacityGovernor.getCapacityReport('kilo-free-direct'), blockrun: capacityGovernor.getCapacityReport('blockrun-free-direct') };
await persist();
console.log(JSON.stringify({ status: campaign.status, separation: campaign.domainSeparation, attempted: campaign.tasks.length, completed: campaign.tasks.filter((task) => task.status === 'completed').length, concurrentWallTimeMs: campaign.concurrentWallTimeMs, error: campaign.error }));

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
  return {
    physicalProviderRequests: frames.length,
    failedRequests: frames.filter(frame => frame.error).length,
    byProviderModel: [...byProviderModel.values()],
  };
}
