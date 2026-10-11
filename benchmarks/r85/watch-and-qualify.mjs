import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createBlockRunFreeAdapter } from '@codeforge/providers';
import { reverifyBlockRunPolicy } from '@codeforge/model-registry';
import { runCompactQualification } from '@codeforge/eight-bit';
import { createGenericFreeRecord } from '@codeforge/forge-zero';

const directory = 'docs/evidence/r85-free-onboarding-autonomy-and-forgeaaa-review';
const prefer = ['poolside/laguna-xs-2.1', 'nvidia/muse-glimmer-30b', 'cohere/north-mini-code'];
const deadline = Date.now() + Number(process.env.R85_WATCH_MS ?? 45 * 60_000);
const attemptBudget = Number(process.env.R85_WATCH_ATTEMPTS ?? 8);
await mkdir(directory, { recursive: true });
const log = { startedAt: new Date().toISOString(), evidenceClass: 'LIVE_CATALOG_WATCH_AND_COMPACT_QUALIFICATION', attempts: [] };
const file = `${directory}/watch-qualify-blockrun-${Date.now()}.json`;
const persist = () => writeFile(file, `${JSON.stringify(log, null, 2)}\n`);
const adapter = createBlockRunFreeAdapter({ timeoutMs: 45_000 });
let policy;
while (Date.now() < deadline && log.attempts.length < attemptBudget) {
  let models = [];
  try { models = await adapter.listModels(); } catch (error) { log.attempts.push({ at: new Date().toISOString(), phase: 'catalog', error: String(error) }); await persist(); await new Promise(r => setTimeout(r, 60_000)); continue; }
  const available = models.filter(m => m.capabilities?.coding).map(m => m.modelId);
  const candidate = prefer.find(id => available.includes(id)) ?? available[0];
  if (!candidate) { log.attempts.push({ at: new Date().toISOString(), phase: 'catalog', availableCoding: [], note: 'no coding model currently free+available' }); await persist(); await new Promise(r => setTimeout(r, 90_000)); continue; }
  const attempt = { at: new Date().toISOString(), phase: 'qualify', modelId: candidate, frames: [] };
  log.attempts.push(attempt);
  await persist();
  try {
    policy ??= await reverifyBlockRunPolicy(new Date().toISOString());
    if (policy.status !== 'VERIFIED') throw new Error('POLICY_NOT_VERIFIED');
    const model = models.find(m => m.modelId === candidate);
    const record = { ...createGenericFreeRecord({ providerId: adapter.providerId, modelId: candidate, displayName: model.displayName }), accessClass: 'FREE_ROUTED', capabilities: model.capabilities, contextWindow: model.contextWindow };
    const traced = { providerId: adapter.providerId, isTestProvider: false, async *streamChat(request, signal) {
      const frame = { at: new Date().toISOString(), request: { model: request.model, maxTokens: request.maxTokens }, events: [] };
      attempt.frames.push(frame);
      try { for await (const event of adapter.streamChat(request, signal)) { frame.events.push(event.type); yield event; } }
      catch (error) { frame.error = { code: error.code, status: error.status, message: error.message }; throw error; }
    } };
    attempt.qualification = await runCompactQualification(record, traced, { signal: AbortSignal.timeout(300_000) });
    attempt.status = attempt.qualification.qualificationState;
    attempt.transient = attempt.qualification.metadata?.transient === true;
    await persist();
    if (attempt.status === 'QUALIFIED' && !attempt.transient) {
      log.result = { status: 'CONCLUSIVE_CODER_QUALIFICATION', modelId: candidate, qualification: attempt.qualification };
      break;
    }
  } catch (error) { attempt.status = 'ERROR'; attempt.error = String(error); await persist(); }
  await new Promise(r => setTimeout(r, 60_000));
}
log.finishedAt = new Date().toISOString();
log.status = log.result ? 'CONCLUSIVE_CODER_QUALIFICATION' : 'NO_CONCLUSIVE_WINDOW';
await persist();
console.log(JSON.stringify({ file, status: log.status, modelId: log.result?.modelId, attempts: log.attempts.length }));
