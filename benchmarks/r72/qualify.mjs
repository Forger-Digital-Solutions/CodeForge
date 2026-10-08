import { writeFile } from 'node:fs/promises';
import { createKiloFreeDirectAdapter } from '@codeforge/providers';
import { reverifyKiloPolicy } from '@codeforge/model-registry';
import { runRoleAwareQualification } from '@codeforge/eight-bit';
import { createGenericFreeRecord } from '@codeforge/forge-zero';

const modelId = process.argv[2] ?? 'poolside/laguna-s-2.1:free';
const file = `docs/evidence/r72-free-supply-and-autonomy/qualification-${modelId.replace(/[^\w.-]/g, '_')}-${Date.now()}.json`;
const report = { startedAt: new Date().toISOString(), modelId, providerId: 'kilo-free-direct', evidenceClass: 'LIVE_ROLE_QUALIFICATION_NOT_CODING_COMPLETION', frames: [] };
const persist = () => writeFile(file, JSON.stringify(report, null, 2));
const adapter = createKiloFreeDirectAdapter();
try {
  report.policy = await reverifyKiloPolicy(report.startedAt);
  if (report.policy.status !== 'VERIFIED') throw new Error('POLICY_NOT_VERIFIED');
  const model = (await adapter.listModels()).find(m => m.modelId === modelId && m.freeStatus === 'verified_free');
  if (!model) throw new Error('CURRENT_ZERO_PRICE_MODEL_ABSENT');
  report.catalog = model;
  const record = { ...createGenericFreeRecord({ providerId: adapter.providerId, modelId, displayName: model.displayName }), accessClass: 'FREE_ROUTED', capabilities: model.capabilities, contextWindow: model.contextWindow };
  const traced = { providerId: adapter.providerId, isTestProvider: false, async *streamChat(request, signal) {
    const frame = { at: new Date().toISOString(), events: [], maxTokens: request.maxTokens };
    report.frames.push(frame);
    try { for await (const event of adapter.streamChat(request, signal)) { frame.events.push(event); yield event; } }
    catch (e) { frame.error = { code: e.code, status: e.status, retryAfterMs: e.retryAfterMs, rateLimitScope: e.rateLimitScope, message: e.message }; throw e; }
    finally { frame.finishedAt = new Date().toISOString(); await persist(); }
  } };
  const roles = process.argv[3] ? [process.argv[3]] : undefined;
  if (roles && !['EXPLORER', 'PLANNER', 'REVIEWER'].includes(roles[0])) throw new Error('INVALID_REQUESTED_ROLE');
  report.requestedRoles = roles ?? 'ALL';
  report.qualification = await runRoleAwareQualification(record, traced, { roles, signal: AbortSignal.timeout(300_000) });
  report.status = report.qualification.metadata?.transient ? 'INCONCLUSIVE_PROVIDER_FAILURE' : 'MEASURED';
} catch (e) { report.status = 'BLOCKED'; report.error = e.message; }
report.finishedAt = new Date().toISOString();
await persist();
console.log(JSON.stringify({ file, status: report.status, requests: report.frames.length, roles: Object.fromEntries(Object.entries(report.qualification?.roleResults ?? {}).map(([r, v]) => [r, v.status])), error: report.error }));
