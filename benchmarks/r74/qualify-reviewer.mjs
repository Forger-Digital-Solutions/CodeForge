import { mkdir, writeFile } from 'node:fs/promises';
import { createBlockRunFreeAdapter, createKiloFreeDirectAdapter } from '@codeforge/providers';
import { reverifyBlockRunPolicy, reverifyKiloPolicy } from '@codeforge/model-registry';
import { createRoleQualificationReceipt, runRoleQualification, ROLE_QUALIFICATION_SUITE_VERSION, REVIEWER_PROTOCOL } from '@codeforge/eight-bit';
import { createGenericFreeRecord } from '@codeforge/forge-zero';
import { classifyReviewerOutcome } from './reviewer-outcome.mjs';

const modelId = process.argv[2] ?? 'dots-studio/dots-3-note-preview:free';
const maxRequests = Number(process.argv[3] ?? '12');
const provider = process.argv[4] ?? 'kilo-free-direct';
const role = process.argv[5] ?? 'REVIEWER';
if (!['REVIEWER', 'PLANNER'].includes(role)) throw new Error('Only Reviewer or Planner role probes are supported');
if (!Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > 24) throw new Error('Reviewer request ceiling must be between 1 and 24');
if (provider !== 'kilo-free-direct' && provider !== 'blockrun-free-direct') throw new Error('Reviewer provider must be kilo-free-direct or blockrun-free-direct');
const directory = 'docs/evidence/r74-autonomous-completion-and-free-reliability';
await mkdir(directory, { recursive: true });
const report = { startedAt: new Date().toISOString(), providerId: provider, modelId, evidenceClass: 'LIVE_ROLE_ONLY_PUBLIC_CASES', intendedRole: role, suiteVersion: ROLE_QUALIFICATION_SUITE_VERSION, reviewerProtocol: REVIEWER_PROTOCOL.version, frames: [], maxRequests };
const file = `${directory}/${role.toLowerCase()}-${modelId.replace(/[^\w.-]/g, '_')}-${Date.now()}.json`;
const persist = () => writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
const blockrun = provider === 'blockrun-free-direct';
const adapter = blockrun ? createBlockRunFreeAdapter() : createKiloFreeDirectAdapter();
try {
  report.policy = await (blockrun ? reverifyBlockRunPolicy : reverifyKiloPolicy)(report.startedAt);
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
  report.result = await runRoleQualification(record, traced, { roles: [role], signal: AbortSignal.timeout(360_000) });
  report.qualification = createRoleQualificationReceipt(record, report.result);
  report.qualification.metadata = { ...report.qualification.metadata, reviewerProtocolOnly: role === 'REVIEWER', publicCasesOnly: true };
  report.status = classifyReviewerOutcome(report.result, report.frames);
} catch (error) { report.status = 'BLOCKED'; report.error = error.message; }
report.finishedAt = new Date().toISOString();
await persist();
console.log(JSON.stringify({ file, status: report.status, requests: report.frames.length, role, roleStatus: report.qualification?.roleResults[role]?.status, error: report.error }));
