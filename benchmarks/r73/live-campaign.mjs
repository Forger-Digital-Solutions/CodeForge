import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile as callback } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { ForgeZero, CapacityReservationLedger } from '@codeforge/forge-zero';
import { createKiloFreeDirectAdapter, createBlockRunFreeAdapter, InMemoryProviderCatalog } from '@codeforge/providers';
import { FreeCloudService, NormalizedModelRegistry, reverifyKiloPolicy, reverifyBlockRunPolicy } from '@codeforge/model-registry';
import { createEightBitRouteHealthAuthority, createFreeFabric, roleQualificationStatusFor } from '@codeforge/eight-bit';
import { createSessionPersistence, EventStore } from '@codeforge/sessions';
import { createAgentRuntime, createWorkspaceService, createWorkspaceEventAdapter, createAutonomousRunOrchestrator } from '@codeforge/server';
import { taskAt } from '../r71/tasks.mjs';
import { traceProvider } from './trace-provider.mjs';
import { snapshotSource } from './source-snapshot.mjs';

const execFile = promisify(callback);
const directory = 'docs/evidence/r73-free-supply-and-completion';
const campaignName = process.env.R73_CAMPAIGN_NAME ?? `R73-TASK-CAMPAIGN-${Date.now()}`;
const sourceDiff = (await execFile('git', ['-c', 'core.fsmonitor=false', 'diff'])).stdout;
const campaign = { startedAt: new Date().toISOString(), evidenceClass: 'LIVE_ANONYMOUS_FREE_PUBLIC_FIXTURES', sourceRevision: (await execFile('git', ['rev-parse', 'HEAD'])).stdout.trim(), sourceDiffSha256: createHash('sha256').update(sourceDiff).digest('hex'), sourceDirty: sourceDiff.length > 0, status: 'RUNNING', tasks: [], supply: [], inferenceFrames: [], costState: 'UNKNOWN' };
const source = await snapshotSource();
campaign.sourceFilesSha256 = source.sha256;
campaign.sourceManifest = `${campaignName}-source.json`;
await writeFile(`${directory}/${campaign.sourceManifest}`, `${JSON.stringify(source, null, 2)}\n`);
const persist = () => writeFile(`${directory}/${campaignName}.json`, `${JSON.stringify(campaign, null, 2)}\n`);
const root = path.resolve('benchmarks/r73/tmp');
const count = Math.min(20, Number(process.argv[2] ?? 1));
const offset = Number(process.env.R73_TASK_OFFSET ?? 0);
const owner = 'r73-public-user';
const firewall = new ForgeZero();
firewall.setPrivacyMode('MAXIMUM_FREE');
const catalog = new InMemoryProviderCatalog();
const health = createEightBitRouteHealthAuthority();
const freeCloud = new FreeCloudService({ firewall, providerCatalog: catalog, registry: new NormalizedModelRegistry(), routeHealth: health });
await mkdir(root, { recursive: true });
try {
  for (const qualificationPath of [process.argv[3] ?? 'docs/evidence/r71-packaged-free-supply-expansion/kilo-free-direct-cohere_north-mini-code_free-2026-10-08T12-03-32-552Z-qualification.json', process.argv[4], process.argv[5]].filter(Boolean)) {
    const document = JSON.parse(await readFile(qualificationPath, 'utf8'));
    const qualification = document.qualification ?? document;
    const blockrun = qualification.providerId === 'blockrun-free-direct';
    if (!blockrun && qualification.providerId !== 'kilo-free-direct') throw new Error('UNSUPPORTED_LIVE_PROVIDER');
    const adapter = traceProvider((blockrun ? createBlockRunFreeAdapter : createKiloFreeDirectAdapter)({ onResponse: freeCloud.onProviderResponse }), campaign, persist);
    const policyFn = blockrun ? reverifyBlockRunPolicy : reverifyKiloPolicy;
    const policy = await policyFn(new Date().toISOString());
    if (policy.status !== 'VERIFIED') { campaign.supply.push({ providerId: adapter.providerId, status: 'POLICY_DENIED' }); continue; }
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
  for (const role of ['EXPLORER', 'CODER', 'REVIEWER']) {
    if (!campaign.supply.some(route => route.roles?.[role] === 'QUALIFIED')) throw new Error(`CURRENT_QUALIFIED_${role}_ROSTER_UNAVAILABLE`);
  }
  for (const route of campaign.supply) if (route.roles) route.capacityMeasured = await freeCloud.probeRouteCapacity(route.providerId, route.modelId);
  campaign.costState = 'CATALOG_VERIFIED_EXACT_ZERO_NO_CREDENTIALS_NO_PAID_FALLBACK';
  await persist();
  const reservations = new CapacityReservationLedger({ routes: [], pools: [] });
  const fabric = createFreeFabric({ managedRoutes: () => freeCloud.productionCapacityRoutes().filter((route) => route.capacityPoolScope !== 'PER_USER_POOL'), userSources: [freeCloud], health, reservations });
  for (let index = 0; index < count; index++) {
    const task = taskAt(index + offset);
    const workspacePath = await mkdtemp(path.join(root, 'public-task-'));
    const taskEvidence = { id: task.id, taskClass: task.taskClass, startedAt: new Date().toISOString(), workspacePath, status: 'RUNNING' };
    campaign.tasks.push(taskEvidence);
    await persist();
    let persistence;
    try {
      for (const [file, content] of Object.entries(task.files)) { await mkdir(path.dirname(path.join(workspacePath, file)), { recursive: true }); await writeFile(path.join(workspacePath, file), content); }
      await writeFile(path.join(workspacePath, 'package.json'), `${JSON.stringify({ name: 'r73-public-fixture', type: 'module', private: true, scripts: { test: 'node --test' }, ...task.package }, null, 2)}\n`);
      for (const args of [['init'], ['config', 'user.name', 'CodeForge Public Fixture'], ['config', 'user.email', 'fixture@codeforge.invalid'], ['config', 'commit.gpgsign', 'false'], ['add', '.'], ['commit', '-m', `Public ${task.taskClass} baseline`]]) await execFile('git', args, { cwd: workspacePath, windowsHide: true });
      const testsBefore = await execFile(process.execPath, ['--test'], { cwd: workspacePath, windowsHide: true }).then(({ stdout }) => ({ exitCode: 0, output: stdout })).catch((error) => ({ exitCode: error.code, output: `${error.stdout ?? ''}${error.stderr ?? ''}` }));
      taskEvidence.testsBefore = testsBefore;
      persistence = createSessionPersistence({ dbPath: path.join(workspacePath, '..', `${path.basename(workspacePath)}.db`) });
      await persistence.init();
      const sessionId = `r73-${task.id}-${Date.now()}`;
      await persistence.upsertSession({ id: sessionId, title: task.taskClass, status: 'idle', createdAt: taskEvidence.startedAt, updatedAt: taskEvidence.startedAt });
      const events = new EventStore();
      const runtime = createAgentRuntime({ sessionId, eventStore: events, persistence, firewall, providerCatalog: catalog, workspacePath, userId: owner, routeHealth: health, freeCloud, freeFabric: fabric, fabricContext: () => ({ userId: owner, userIdentities: freeCloud.capacityIdentitiesFor(owner), dataContext: { dataClass: 'PUBLIC_CODE', userConsented: true } }) });
      await runtime.init();
      const orchestrator = createAutonomousRunOrchestrator({ workspaceService: createWorkspaceService({ persistence, worktreeParentDir: path.join(root, 'worktrees') }), persistence, agentRuntime: runtime, subagentsR1Enabled: true });
      const result = await orchestrator.startRun({ sessionId, workspacePath, topology: 'normal', goal: `${task.goal} This is a public synthetic fixture with no user source, credentials, or confidential data.`, verificationCommands: ['node --test'], adapter: createWorkspaceEventAdapter({ sessionId, eventStore: events, persistence }), signal: AbortSignal.timeout(360_000) });
      taskEvidence.result = result;
      taskEvidence.status = result.status;
      await persist();
      const testsAfter = await execFile(process.execPath, ['--test'], { cwd: workspacePath, windowsHide: true }).then(({ stdout }) => ({ exitCode: 0, output: stdout })).catch((error) => ({ exitCode: error.code, output: `${error.stdout ?? ''}${error.stderr ?? ''}` }));
      const workers = await persistence.getWorkItemsByKind('subagent_run');
      taskEvidence.journals = await persistence.getWorkItemsByKind('agent_run_journal');
      const decisions = await persistence.getWorkItemsByKind('eight_bit_decision_receipt');
      const turns = await persistence.getWorkItemsByKind('agent_model_turn');
      const diff = (await execFile('git', ['diff', result.baseRevision, 'HEAD'], { cwd: workspacePath, windowsHide: true })).stdout;
      Object.assign(taskEvidence, { status: result.status, result, testsAfter, workers, decisions, turns, verificationRecords: await persistence.getWorkItemsByKind('verification'), experience: await persistence.getWorkItemsByKind('generalized_experience_signal'), diff, diffSha256: createHash('sha256').update(diff).digest('hex'), routeHealth: health.snapshot(), rssBytes: process.memoryUsage().rss, reservations: reservations.snapshot() });
      if (result.status === 'completed' && (result.completion?.outcome !== 'completed' || !result.review?.passed || !result.verification?.every((item) => item.passed) || result.integration?.status !== 'integrated' || testsAfter.exitCode !== 0)) throw new Error('FALSE_COMPLETION_OBSERVED');
    } catch (error) { taskEvidence.status = 'FAILED'; taskEvidence.error = String(error); }
    finally { if (persistence) await persistence.close(); taskEvidence.finishedAt = new Date().toISOString(); taskEvidence.wallTimeMs = Date.parse(taskEvidence.finishedAt) - Date.parse(taskEvidence.startedAt); await persist(); }
    console.log(JSON.stringify({ id: task.id, status: taskEvidence.status, timeMs: taskEvidence.wallTimeMs, error: taskEvidence.error }));
    if (taskEvidence.error === 'Error: FALSE_COMPLETION_OBSERVED') break;
    if (campaign.tasks.length >= 2 && campaign.tasks.slice(-2).every(item => item.status !== 'completed')) { campaign.stopReason = 'TWO_CONSECUTIVE_NONCOMPLETIONS_STOP_SCARCE_QUOTA'; break; }
  }
  campaign.status = campaign.tasks.every((task) => task.status === 'completed') ? 'PASS' : 'PARTIAL';
} catch (error) { campaign.status = 'BLOCKED'; campaign.error = String(error); }
campaign.finishedAt = new Date().toISOString();
await persist();
console.log(JSON.stringify({ status: campaign.status, attempted: campaign.tasks.length, completed: campaign.tasks.filter((task) => task.status === 'completed').length, error: campaign.error }));
