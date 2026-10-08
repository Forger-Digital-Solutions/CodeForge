import http from 'node:http';
import { mkdir, writeFile, readFile, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { OpenRouterOAuth, verifyOpenRouterEntitlement, createOpenRouterAdapter, InMemoryProviderCatalog, ProviderCapacityGovernor } from '@codeforge/providers';
import { ForgeZero, createGenericFreeRecord, CapacityReservationLedger } from '@codeforge/forge-zero';
import { FreeCloudService, NormalizedModelRegistry } from '@codeforge/model-registry';
import { runCompactQualification, createEightBitRouteHealthAuthority, createFreeFabric } from '@codeforge/eight-bit';
import { EventStore, createSessionPersistence } from '@codeforge/sessions';
import { createAgentRuntime } from '@codeforge/server';

const directory = 'docs/evidence/r71-packaged-free-supply-expansion';
const owner = 'r71-openrouter-public-fixture';
const report = { startedAt: new Date().toISOString(), kind: 'OFFICIAL_PKCE_PERSONAL_ACCOUNT_VALIDATION', status: 'AWAITING_USER_LOGIN', frames: [] };
await mkdir(directory, { recursive: true });
await mkdir('benchmarks/r71/tmp', { recursive: true });
const persist = () => writeFile(`${directory}/openrouter-account-proof.json`, JSON.stringify(report, null, 2) + '\n');
await persist();
let persistence;
try {
  const pkce = await OpenRouterOAuth.generatePkcePair();
  const state = OpenRouterOAuth.generateState();
  const key = await new Promise((resolve, reject) => {
    let consumed = false;
    const server = http.createServer((req, res) => {
      if (consumed || req.method !== 'GET' || req.headers.host !== `127.0.0.1:${server.address().port}`) { res.writeHead(400); res.end('Invalid callback.'); return; }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/callback') { res.writeHead(404); res.end(); return; }
      try {
        const code = OpenRouterOAuth.parseCallback(url.toString(), state);
        consumed = true;
        res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
        res.end('<title>CodeForge</title><h2>Authorization received</h2><p>Return to CodeForge. Account verification is running.</p>');
        clearTimeout(timer);
        server.close();
        OpenRouterOAuth.exchangeCodeForKey({ code, codeVerifier: pkce.codeVerifier }).then(resolve, reject);
      } catch { res.writeHead(400); res.end('Authorization state rejected.'); }
    });
    const timer = setTimeout(() => { server.close(); reject(new Error('USER_AUTHORIZATION_TIMEOUT')); }, 900000);
    server.on('error', error => { clearTimeout(timer); reject(error); });
    server.listen(0, '127.0.0.1', async () => {
      const callbackUrl = `http://127.0.0.1:${server.address().port}/callback`;
      const authUrl = OpenRouterOAuth.buildAuthUrl({ callbackUrl, codeChallenge: pkce.codeChallenge, state });
      await writeFile('benchmarks/r71/tmp/openrouter-auth-url.json', JSON.stringify({ authUrl }));
      console.log('OFFICIAL_AUTHORIZATION_READY');
    });
  });
  report.entitlement = await verifyOpenRouterEntitlement({ key, ownerUserId: owner });
  await persist();
  if (report.entitlement.accountClass !== 'FREE_VERIFIED' || !report.entitlement.admissionEvidence) throw new Error(`FREE_ACCOUNT_NOT_ADMITTED:${report.entitlement.reason}`);
  if (report.entitlement.freeRequests.remaining < 10) throw new Error('INSUFFICIENT_REMAINING_FREE_REQUESTS_FOR_BOUNDED_PROOF');
  const firewall = new ForgeZero();
  firewall.setPrivacyMode('MAXIMUM_FREE');
  const catalog = new InMemoryProviderCatalog();
  const health = createEightBitRouteHealthAuthority();
  const freeCloud = new FreeCloudService({ firewall, providerCatalog: catalog, registry: new NormalizedModelRegistry(), routeHealth: health });
  freeCloud.setConnection({ providerId: 'openrouter', connected: true, credentialSource: 'OAUTH', ownerUserId: owner, authState: 'ok', delegatedEntitlement: report.entitlement });
  const adapter = createOpenRouterAdapter({ credentialStore: { get: providerId => providerId === 'openrouter' ? key : undefined }, onResponse: freeCloud.onProviderResponse });
  catalog.register(adapter);
  const models = await adapter.listModels();
  const model = models.find(item => item.modelId === 'cohere/north-mini-code:free' && item.isFree && item.capabilities.toolCalling);
  if (!model) throw new Error('EXACT_ZERO_TOOL_CAPABLE_MODEL_ABSENT');
  const record = { ...createGenericFreeRecord({ providerId: adapter.providerId, modelId: model.modelId }), privacyClass: 'permissive', accessClass: 'FREE_ROUTED', capabilities: model.capabilities, contextWindow: model.contextWindow };
  firewall.register(record);
  const traced = { providerId: adapter.providerId, isTestProvider: false, async *streamChat(request, signal) {
    const frame = { startedAt: new Date().toISOString(), events: [] }; report.frames.push(frame);
    try { for await (const event of adapter.streamChat(request, signal)) { frame.events.push(event); yield event; } }
    finally { frame.finishedAt = new Date().toISOString(); await persist(); }
  } };
  report.qualification = await runCompactQualification(record, traced, { signal: AbortSignal.timeout(150000) });
  await freeCloud.recordReceipt(report.qualification);
  freeCloud.applyReceiptToFirewall(report.qualification);
  report.capacityMeasured = await freeCloud.probeRouteCapacity(adapter.providerId, model.modelId);
  report.routes = freeCloud.productionCapacityRoutes();
  const reservations = new CapacityReservationLedger({ routes: [], pools: [] });
  const fabric = createFreeFabric({ managedRoutes: () => [], userSources: [freeCloud], health, reservations });
  report.foreignUserRoutes = freeCloud.routesForUser('unrelated-user').length;
  const workspacePath = await mkdtemp(path.resolve('benchmarks/r71/tmp/openrouter-public-'));
  await writeFile(path.join(workspacePath, 'greeting.txt'), 'Hello\n');
  persistence = createSessionPersistence({ dbPath: path.join(workspacePath, 'session.db') });
  await persistence.init();
  const sessionId = `r71-or-${Date.now()}`;
  const governor = new ProviderCapacityGovernor();
  const runtime = createAgentRuntime({ sessionId, persistence, eventStore: new EventStore(), firewall, providerCatalog: catalog, workspacePath, userId: owner, routeHealth: health, freeCloud, freeFabric: fabric, capacityGovernor: governor,
    fabricContext: () => ({ userId: owner, userIdentities: freeCloud.capacityIdentitiesFor(owner), dataContext: { dataClass: 'PUBLIC_CODE', userConsented: true } }) });
  await runtime.init();
  const turnId = await runtime.startTurn("Public synthetic fixture. Read greeting.txt, change its contents to 'Goodbye', then stop. Use workspace tools.");
  const deadline = Date.now() + 180000;
  const approved = new Set();
  let turn;
  while (Date.now() < deadline) {
    turn = runtime.getTurn(turnId);
    if (['completed', 'failed', 'waiting_for_free_capacity'].includes(turn?.status)) break;
    if (turn?.status === 'waiting_for_approval') {
      const pending = (await persistence.getWorkItems(sessionId)).find(item => item.kind === 'approval' && item.turnId === turnId && !item.decision && !approved.has(item.id));
      if (pending) { approved.add(pending.id); await runtime.resolveApproval(pending.id, 'allow_once'); }
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!['completed', 'failed', 'waiting_for_free_capacity'].includes(turn?.status)) {
    await runtime.cancelTurn(turnId, 'R71 bounded public-fixture deadline');
    turn = runtime.getTurn(turnId);
  }
  const { adapter: runtimeAdapter, ...turnReceipt } = turn ?? {};
  report.coding = { kind: 'INTERACTIVE_TOOL_TURN_NOT_REVIEWED_WORKFLOW', workspacePath, turn: turnReceipt, fileContent: (await readFile(path.join(workspacePath, 'greeting.txt'), 'utf8')).trim(), items: await persistence.getWorkItems(sessionId), events: await persistence.getEvents(sessionId), reservations: reservations.snapshot() };
  report.status = turn?.status === 'completed' && report.coding.fileContent === 'Goodbye' ? 'REAL_CODING_TURN_VERIFIED' : 'CODING_NOT_COMPLETED';
} catch (error) { report.status = 'BLOCKED'; report.error = error.message?.startsWith('FREE_ACCOUNT_NOT_ADMITTED:') ? error.message : error.code ?? error.name; }
finally { if (persistence) await persistence.close(); }
report.finishedAt = new Date().toISOString();
await persist();
console.log(JSON.stringify({ status: report.status, accountClass: report.entitlement?.accountClass, reason: report.entitlement?.reason, error: report.error }));
