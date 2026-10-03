import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile as callback } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { ForgeZero, CapacityReservationLedger } from '@codeforge/forge-zero';
import { createKiloFreeDirectAdapter, createAiHordeCommunityAdapter, InMemoryProviderCatalog } from '@codeforge/providers';
import { FreeCloudService, NormalizedModelRegistry, reverifyHordePolicy, reverifyKiloPolicy } from '@codeforge/model-registry';
import { createEightBitRouteHealthAuthority, createFreeFabric } from '@codeforge/eight-bit';
import { createSessionPersistence, EventStore } from '@codeforge/sessions';
import { createAgentRuntime, createWorkspaceService, createWorkspaceEventAdapter, createAutonomousRunOrchestrator } from '@codeforge/server';
import { taskAt } from './tasks.mjs';

const execFile = promisify(callback);
const directory = 'docs/evidence/r66-everyday-free-readiness';
const campaign = { startedAt: new Date().toISOString(), evidenceClass: 'LIVE_ANONYMOUS_FREE_PUBLIC_FIXTURES', status: 'RUNNING', tasks: [], supply: [], costState: 'UNKNOWN' };
const persist = () => writeFile(`${directory}/R66-TASK-FINAL-SOURCE.json`, `${JSON.stringify(campaign, null, 2)}\n`);
const root = path.resolve('benchmarks/r66/tmp');
const count = Number(process.argv[2] ?? 6);
const owner = 'r66-public-user';
const firewall = new ForgeZero();
firewall.setPrivacyMode('MAXIMUM_FREE');
const catalog = new InMemoryProviderCatalog();
const health = createEightBitRouteHealthAuthority();
const freeCloud = new FreeCloudService({ firewall, providerCatalog: catalog, registry: new NormalizedModelRegistry(), routeHealth: health });
await mkdir(root, { recursive: true });
try {
  for (const [adapter, policyFn, qualificationPath] of [
    [createKiloFreeDirectAdapter({ onResponse: freeCloud.onProviderResponse }), reverifyKiloPolicy, `${directory}/R66-KILO-ROLE-QUALITY-final.json`],
    [createAiHordeCommunityAdapter({ onResponse: freeCloud.onProviderResponse }), reverifyHordePolicy, 'docs/evidence/free-capacity-fabric/R65-HORDE-QUALIFICATION-google_gemma-4-31b.json'],
  ]) {
    const policy = await policyFn(new Date().toISOString());
    if (policy.status !== 'VERIFIED') { campaign.supply.push({ providerId: adapter.providerId, status: 'POLICY_DENIED' }); continue; }
    const document = JSON.parse(await readFile(qualificationPath, 'utf8'));
    const qualification = document.qualification ?? document;
    if (Date.now() - Date.parse(qualification.completedAt) > 86_400_000 || qualification.metadata?.transient) throw new Error('CURRENT_CONCLUSIVE_QUALIFICATION_REQUIRED');
    const models = await adapter.listModels();
    const model = models.find((item) => item.modelId === qualification.modelId && item.isFree && item.freeStatus === 'verified_free');
    if (!model) { campaign.supply.push({ providerId: adapter.providerId, status: 'MODEL_ABSENT', modelId: qualification.modelId }); continue; }
    catalog.register(adapter);
    const now = new Date().toISOString();
    firewall.register({ providerId: adapter.providerId, modelId: model.modelId, displayName: model.displayName, tier: 'free', accessClass: 'FREE_ROUTED', privacyClass: 'permissive', freeStatus: 'verified_free', freeStatusVerifiedAt: now, capabilities: model.capabilities, contextWindow: model.contextWindow, isRemote: true, isCloudHosted: true, verificationSource: 'live anonymous catalog and freshly reverified pinned policy', costProfile: { isFree: true, inputCostPerMillion: 0, outputCostPerMillion: 0, freeTierVerifiedAt: now, paidFallbackPossible: false, paidFallbackDisabled: true }, health: { status: 'available', lastCheckedAt: now } });
    freeCloud.setConnection({ providerId: adapter.providerId, connected: true, credentialSource: 'ANONYMOUS_DIRECT', authState: 'ok', ownerUserId: owner, ...(adapter.providerId === 'ai-horde' ? { supplyClass: 'COMMUNITY_ANONYMOUS_FREE' } : {}) });
    if (adapter.providerId === 'ai-horde') freeCloud.setHordePolicyReceipt(policy.receipt); else freeCloud.setKiloPolicyReceipt(policy.receipt);
    await freeCloud.recordReceipt(qualification);
    freeCloud.applyReceiptToFirewall(qualification);
    const capacityMeasured = await freeCloud.probeRouteCapacity(adapter.providerId, model.modelId);
    campaign.supply.push({ providerId: adapter.providerId, modelId: model.modelId, qualificationAt: qualification.completedAt, qualificationSource: qualificationPath, roles: Object.fromEntries(Object.entries(qualification.roleResults).map(([role, value]) => [role, value.status])), capacityMeasured });
  }
  await persist();
  const reservations = new CapacityReservationLedger({ routes: [], pools: [] });
  const fabric = createFreeFabric({ managedRoutes: () => freeCloud.productionCapacityRoutes().filter((route) => route.capacityPoolScope !== 'PER_USER_POOL'), userSources: [freeCloud], health, reservations });
  for (let index = 0; index < count; index++) {
    const task = taskAt(index);
    const workspacePath = await mkdtemp(path.join(root, 'public-task-'));
    const taskEvidence = { id: task.id, taskClass: task.taskClass, startedAt: new Date().toISOString(), workspacePath, status: 'RUNNING' };
    campaign.tasks.push(taskEvidence);
    await persist();
    let persistence;
    try {
      for (const [file, content] of Object.entries(task.files)) { await mkdir(path.dirname(path.join(workspacePath, file)), { recursive: true }); await writeFile(path.join(workspacePath, file), content); }
      await writeFile(path.join(workspacePath, 'package.json'), `${JSON.stringify({ name: 'r66-public-fixture', type: 'module', private: true, scripts: { test: 'node --test' }, ...task.package }, null, 2)}\n`);
      for (const args of [['init'], ['config', 'user.name', 'CodeForge Public Fixture'], ['config', 'user.email', 'fixture@codeforge.invalid'], ['config', 'commit.gpgsign', 'false'], ['add', '.'], ['commit', '-m', `Public ${task.taskClass} baseline`]]) await execFile('git', args, { cwd: workspacePath, windowsHide: true });
      const testsBefore = await execFile(process.execPath, ['--test'], { cwd: workspacePath, windowsHide: true }).then(({ stdout }) => ({ exitCode: 0, output: stdout })).catch((error) => ({ exitCode: error.code, output: `${error.stdout ?? ''}${error.stderr ?? ''}` }));
      taskEvidence.testsBefore = testsBefore;
      persistence = createSessionPersistence({ dbPath: path.join(workspacePath, '..', `${path.basename(workspacePath)}.db`) });
      await persistence.init();
      const sessionId = `r66-${task.id}-${Date.now()}`;
      await persistence.upsertSession({ id: sessionId, title: task.taskClass, status: 'idle', createdAt: taskEvidence.startedAt, updatedAt: taskEvidence.startedAt });
      const events = new EventStore();
      const runtime = createAgentRuntime({ sessionId, eventStore: events, persistence, firewall, providerCatalog: catalog, workspacePath, userId: owner, routeHealth: health, freeCloud, freeFabric: fabric, fabricContext: () => ({ userId: owner, userIdentities: freeCloud.capacityIdentitiesFor(owner), dataContext: { dataClass: 'PUBLIC_CODE', userConsented: true } }) });
      await runtime.init();
      const orchestrator = createAutonomousRunOrchestrator({ workspaceService: createWorkspaceService({ persistence, worktreeParentDir: path.join(root, 'worktrees') }), persistence, agentRuntime: runtime, subagentsR1Enabled: true });
      const result = await orchestrator.startRun({ sessionId, workspacePath, topology: 'normal', goal: `${task.goal} This is a public synthetic fixture with no user source, credentials, or confidential data.`, verificationCommands: ['node --test'], adapter: createWorkspaceEventAdapter({ sessionId, eventStore: events, persistence }), signal: AbortSignal.timeout(600_000) });
      taskEvidence.result = result;
      taskEvidence.status = result.status;
      await persist();
      const testsAfter = await execFile(process.execPath, ['--test'], { cwd: workspacePath, windowsHide: true }).then(({ stdout }) => ({ exitCode: 0, output: stdout })).catch((error) => ({ exitCode: error.code, output: `${error.stdout ?? ''}${error.stderr ?? ''}` }));
      const workers = await persistence.getWorkItemsByKind('subagent_run');
      const decisions = await persistence.getWorkItemsByKind('eight_bit_decision_receipt');
      const turns = await persistence.getWorkItemsByKind('agent_model_turn');
      const diff = (await execFile('git', ['diff', result.baseRevision, 'HEAD'], { cwd: workspacePath, windowsHide: true })).stdout;
      Object.assign(taskEvidence, { status: result.status, result, testsAfter, workers, decisions, turns, verificationRecords: await persistence.getWorkItemsByKind('verification'), experience: await persistence.getWorkItemsByKind('generalized_experience_signal'), diff, diffSha256: createHash('sha256').update(diff).digest('hex'), routeHealth: health.snapshot(), rssBytes: process.memoryUsage().rss, reservations: reservations.snapshot() });
      if (result.status === 'completed' && (result.completion?.outcome !== 'completed' || !result.review?.passed || !result.verification?.every((item) => item.passed) || result.integration?.status !== 'integrated' || testsAfter.exitCode !== 0)) throw new Error('FALSE_COMPLETION_OBSERVED');
    } catch (error) { taskEvidence.status = 'FAILED'; taskEvidence.error = String(error); }
    finally { if (persistence) await persistence.close(); taskEvidence.finishedAt = new Date().toISOString(); taskEvidence.wallTimeMs = Date.parse(taskEvidence.finishedAt) - Date.parse(taskEvidence.startedAt); await persist(); }
    console.log(JSON.stringify({ id: task.id, status: taskEvidence.status, timeMs: taskEvidence.wallTimeMs, error: taskEvidence.error }));
    if (taskEvidence.error === 'Error: FALSE_COMPLETION_OBSERVED') break;
  }
  campaign.status = campaign.tasks.every((task) => task.status === 'completed') ? 'PASS' : 'PARTIAL';
} catch (error) { campaign.status = 'BLOCKED'; campaign.error = String(error); }
campaign.finishedAt = new Date().toISOString();
await persist();
console.log(JSON.stringify({ status: campaign.status, attempted: campaign.tasks.length, completed: campaign.tasks.filter((task) => task.status === 'completed').length, error: campaign.error }));
