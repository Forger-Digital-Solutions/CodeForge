import { mkdir, writeFile } from 'node:fs/promises';
import { createBlockRunFreeAdapter, createKiloFreeDirectAdapter, createAiHordeCommunityAdapter } from '@codeforge/providers';
import { reverifyBlockRunPolicy, reverifyKiloPolicy, reverifyHordePolicy } from '@codeforge/model-registry';
import { runRoleAwareQualification, runCompactQualification, ROLE_QUALIFICATION_SUITE_VERSION } from '@codeforge/eight-bit';
import { createGenericFreeRecord } from '@codeforge/forge-zero';

const provider = process.argv[2] ?? 'blockrun-free-direct';
const modelId = process.argv[3] ?? 'poolside/laguna-xs-2.1';
const maxRequests = Number(process.env.R85_QUALIFY_MAX_REQUESTS ?? '40');
if (!Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > 80) throw new Error('Request ceiling must be between 1 and 80');
const factories = {
  'kilo-free-direct': [createKiloFreeDirectAdapter, reverifyKiloPolicy],
  'blockrun-free-direct': [createBlockRunFreeAdapter, reverifyBlockRunPolicy],
  'ai-horde': [createAiHordeCommunityAdapter, reverifyHordePolicy],
};
const entry = factories[provider];
if (!entry) throw new Error(`Unsupported provider ${provider}`);
const [createAdapter, reverifyPolicy] = entry;
const directory = 'docs/evidence/r85-free-onboarding-autonomy-and-forgeaaa-review';
await mkdir(directory, { recursive: true });
const report = { startedAt: new Date().toISOString(), providerId: provider, modelId, evidenceClass: 'LIVE_ROLE_QUALIFICATION_PUBLIC_CASES', suiteVersion: ROLE_QUALIFICATION_SUITE_VERSION, frames: [], maxRequests };
const file = `${directory}/qualify-${provider}-${modelId.replace(/[^\w.-]/g, '_')}-${Date.now()}.json`;
const persist = () => writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
const adapter = createAdapter();
try {
  report.policy = await reverifyPolicy(report.startedAt);
  if (report.policy.status !== 'VERIFIED') throw new Error('POLICY_NOT_VERIFIED');
  const model = (await adapter.listModels()).find(item => item.modelId === modelId && item.freeStatus === 'verified_free' && item.isFree);
  if (!model) throw new Error('CURRENT_EXACT_ZERO_MODEL_REQUIRED');
  report.catalog = model;
  const record = { ...createGenericFreeRecord({ providerId: adapter.providerId, modelId, displayName: model.displayName }), accessClass: 'FREE_ROUTED', capabilities: model.capabilities, contextWindow: model.contextWindow };
  const traced = { providerId: adapter.providerId, isTestProvider: false, async *streamChat(request, signal) {
    if (report.frames.length >= report.maxRequests) throw new Error('R85_BOUND: qualification request budget exhausted');
    const frame = { at: new Date().toISOString(), request: { model: request.model, messageCount: request.messages?.length, maxTokens: request.maxTokens, toolCount: request.tools?.length }, events: [] };
    report.frames.push(frame);
    await persist();
    try { for await (const event of adapter.streamChat(request, signal)) { frame.events.push(event.type === 'text_delta' ? { type: 'text_delta', chars: event.delta?.length ?? 0 } : event); yield event; } }
    catch (error) { frame.error = { code: error.code, status: error.status, retryAfterMs: error.retryAfterMs, rateLimitScope: error.rateLimitScope, message: error.message }; throw error; }
    finally { frame.finishedAt = new Date().toISOString(); await persist(); }
  } };
  const roles = process.env.R85_QUALIFY_ROLES?.split(',').map(role => role.trim()).filter(role => ['EXPLORER', 'PLANNER', 'REVIEWER'].includes(role));
  report.roleScope = roles;
  report.qualification = process.env.R85_QUALIFY_MODE === 'compact'
    ? await runCompactQualification(record, traced, { signal: AbortSignal.timeout(300_000) })
    : await runRoleAwareQualification(record, traced, { signal: AbortSignal.timeout(600_000), ...(roles?.length ? { roles } : {}) });
  report.status = report.qualification.qualificationState;
} catch (error) { report.status = 'BLOCKED'; report.error = error.message; }
report.finishedAt = new Date().toISOString();
await persist();
const roles = report.qualification ? Object.fromEntries(Object.entries(report.qualification.roleResults).map(([role, result]) => [role, result?.status])) : undefined;
console.log(JSON.stringify({ file, status: report.status, requests: report.frames.length, roles, error: report.error }));
