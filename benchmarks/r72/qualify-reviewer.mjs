import { readFile, writeFile } from 'node:fs/promises';
import { createKiloFreeDirectAdapter } from '@codeforge/providers';
import { reverifyKiloPolicy } from '@codeforge/model-registry';
import { runRoleQualification } from '@codeforge/eight-bit';
import { createGenericFreeRecord } from '@codeforge/forge-zero';

const previousFile = process.argv[2];
const previous = JSON.parse(await readFile(previousFile, 'utf8'));
const prior = previous.qualification;
if (!prior || Date.now() - Date.parse(previous.finishedAt) > 86_400_000) throw new Error('CURRENT_MEASURED_PREVIOUS_RECEIPT_REQUIRED');
const modelId = previous.modelId;
const report = { startedAt: new Date().toISOString(), modelId, previousFile, evidenceClass: 'LIVE_SELECTIVE_REVIEWER_QUALIFICATION', frames: [] };
const file = `docs/evidence/r72-free-supply-and-autonomy/reviewer-${modelId.replace(/[^\w.-]/g, '_')}-${Date.now()}.json`;
const persist = () => writeFile(file, JSON.stringify(report, null, 2));
const adapter = createKiloFreeDirectAdapter();
try {
  report.policy = await reverifyKiloPolicy(report.startedAt);
  if (report.policy.status !== 'VERIFIED') throw new Error('POLICY_NOT_VERIFIED');
  const model = (await adapter.listModels()).find(m => m.modelId === modelId && m.isFree);
  if (!model || JSON.stringify(model.capabilities) !== JSON.stringify(previous.catalog.capabilities)) throw new Error('MODEL_CAPABILITIES_CHANGED');
  const record = { ...createGenericFreeRecord({ providerId: adapter.providerId, modelId }), capabilities: model.capabilities, contextWindow: model.contextWindow };
  const traced = { providerId: adapter.providerId, isTestProvider: false, async *streamChat(request, signal) {
    const frame = { at: new Date().toISOString(), events: [] };
    report.frames.push(frame);
    try { for await (const event of adapter.streamChat(request, signal)) { frame.events.push(event); yield event; } }
    catch(e) { frame.error = { code: e.code, status: e.status, message: e.message }; throw e; }
    finally { frame.finishedAt = new Date().toISOString(); await persist(); }
  } };
  report.reviewer = await runRoleQualification(record, traced, { roles: ['REVIEWER'], signal: AbortSignal.timeout(240_000) });
  const roleResults = { ...prior.roleResults, REVIEWER: report.reviewer.roleResults.REVIEWER };
  report.qualification = { ...prior, roleResults, hardFailureRoles: Object.values(roleResults).filter(r => r.status === 'HARD_FAILURE').map(r => r.role),
    qualificationState: Object.values(roleResults).some(r => r.status === 'QUALIFIED') ? 'QUALIFIED' : prior.qualificationState,
    metadata: { ...prior.metadata, transient: report.reviewer.transientCases > 0, previousReceipt: previousFile, reviewerRequests: report.reviewer.requestCount } };
  report.status = report.reviewer.transientCases ? 'INCONCLUSIVE_PROVIDER_FAILURE' : 'MEASURED';
} catch(e) { report.status = 'BLOCKED'; report.error = e.message; }
report.finishedAt = new Date().toISOString();
await persist();
console.log(JSON.stringify({ file, status: report.status, requests: report.frames.length, reviewer: report.reviewer?.roleResults.REVIEWER.status, error: report.error }));
