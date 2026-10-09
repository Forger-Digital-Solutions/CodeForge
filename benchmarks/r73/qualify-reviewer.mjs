import { mkdir, writeFile } from 'node:fs/promises';
import { createKiloFreeDirectAdapter } from '@codeforge/providers';
import { reverifyKiloPolicy } from '@codeforge/model-registry';
import { createRoleQualificationReceipt, runRoleQualification, ROLE_QUALIFICATION_SUITE_VERSION, REVIEWER_PROTOCOL } from '@codeforge/eight-bit';
import { createGenericFreeRecord } from '@codeforge/forge-zero';

const modelId = process.argv[2] ?? 'dots-studio/dots-3-note-preview:free';
const maxRequests = Number(process.argv[3] ?? '12');
if (!Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > 24) throw new Error('Reviewer request ceiling must be between 1 and 24');
const directory = 'docs/evidence/r73-free-supply-and-completion';
await mkdir(directory, { recursive: true });
const report = { startedAt: new Date().toISOString(), providerId: 'kilo-free-direct', modelId, evidenceClass: 'LIVE_REVIEWER_ONLY_PUBLIC_CASES', suiteVersion: ROLE_QUALIFICATION_SUITE_VERSION, reviewerProtocol: REVIEWER_PROTOCOL.version, frames: [], maxRequests };
const file = `${directory}/reviewer-${modelId.replace(/[^\w.-]/g, '_')}-${Date.now()}.json`;
const persist = () => writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
const adapter = createKiloFreeDirectAdapter();
try {
  report.policy = await reverifyKiloPolicy(report.startedAt);
  if (report.policy.status !== 'VERIFIED') throw new Error('POLICY_NOT_VERIFIED');
  const model = (await adapter.listModels()).find(item => item.modelId === modelId && item.freeStatus === 'verified_free' && item.isFree);
  if (!model) throw new Error('CURRENT_EXACT_ZERO_MODEL_REQUIRED');
  report.catalog = model;
  const record = { ...createGenericFreeRecord({ providerId: adapter.providerId, modelId, displayName: model.displayName }), accessClass: 'FREE_ROUTED', capabilities: model.capabilities, contextWindow: model.contextWindow };
  const traced = { providerId: adapter.providerId, isTestProvider: false, async *streamChat(request, signal) {
    if (report.frames.length >= report.maxRequests) throw new Error('R41_BOUND: Reviewer request budget exhausted');
    const frame = { at: new Date().toISOString(), request, events: [] };
    report.frames.push(frame);
    await persist();
    try { for await (const event of adapter.streamChat(request, signal)) { frame.events.push(event); yield event; } }
    catch (error) { frame.error = { code: error.code, status: error.status, retryAfterMs: error.retryAfterMs, rateLimitScope: error.rateLimitScope, message: error.message }; throw error; }
    finally { frame.finishedAt = new Date().toISOString(); await persist(); }
  } };
  report.result = await runRoleQualification(record, traced, { roles: ['REVIEWER'], signal: AbortSignal.timeout(360_000) });
  report.qualification = createRoleQualificationReceipt(record, report.result);
  report.qualification.metadata = { ...report.qualification.metadata, reviewerProtocolOnly: true, publicCasesOnly: true };
  report.status = report.result.transientCases ? 'INCONCLUSIVE_PROVIDER_FAILURE' : 'MEASURED';
} catch (error) { report.status = 'BLOCKED'; report.error = error.message; }
report.finishedAt = new Date().toISOString();
await persist();
console.log(JSON.stringify({ file, status: report.status, requests: report.frames.length, reviewer: report.qualification?.roleResults.REVIEWER.status, error: report.error }));
