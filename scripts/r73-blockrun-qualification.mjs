import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createBlockRunFreeAdapter, quotaHeadersOf } from '../packages/providers/dist/index.js';
import { reverifyBlockRunPolicy } from '../packages/model-registry/dist/index.js';
import { createRoleQualificationReceipt, runRoleAwareQualification, runRoleQualification } from '../packages/eight-bit/dist/index.js';

const evidenceDirectory = resolve('docs/evidence/r73-free-supply-and-completion');
const modelId = process.argv[2] ?? 'nvidia/llama-3.2-11b-vision';
const roleQualification = process.argv.includes('--roles');
const reviewerOnly = process.argv.includes('--reviewer-only');
const toolOnly = process.argv.includes('--tool-only');
const automaticToolChoice = process.argv.includes('--tool-auto');
const executeTool = process.argv.includes('--execute-tool');
const continueReceipt = process.argv.find((arg) => arg.startsWith('--continue-tool='))?.slice('--continue-tool='.length);
const requestBudget = 30;
const evidenceId = Date.now();
const observationFile = `blockrun-live-observations-${evidenceId}.json`;
let requests = 0;
const observations = [];
const adapter = createBlockRunFreeAdapter({ timeoutMs: 45_000, fetchFn: async (target, init) => {
  if (init?.method === 'POST') {
    if (requests >= requestBudget) throw new Error('R73_BLOCKRUN_CALL_BUDGET_EXHAUSTED');
    requests++;
  }
  const start = Date.now();
  const response = await fetch(target, init);
  const observation = { url: String(target), method: init?.method ?? 'GET', ...(init?.method === 'POST' ? { publicSyntheticRequest: JSON.parse(init.body) } : {}), status: response.status, latencyMs: Date.now() - start, headers: quotaHeadersOf(response), body: await response.clone().text() };
  observations.push(observation);
  await writeFile(resolve(evidenceDirectory, observationFile), JSON.stringify({ modelId, requests, requestBudget, publicSyntheticCodeOnly: true, noPaymentCredentials: true, observations }, null, 2));
  return response;
} });
const startedAt = new Date().toISOString();
const result = { startedAt, providerId: adapter.providerId, modelId, observationFile, requests: 0, requestBudget, publicSyntheticCodeOnly: true, noPaymentCredentials: true };
result.roleSuiteBuildSha256 = createHash('sha256').update(await readFile(resolve('packages/eight-bit/dist/qualification/role-suite.js'))).digest('hex');
try {
  result.policy = await reverifyBlockRunPolicy(startedAt);
  if (result.policy.status !== 'VERIFIED') throw new Error(`Policy ${result.policy.status}: ${result.policy.source}`);
  result.catalog = await adapter.listModels();
  const model = result.catalog.find((candidate) => candidate.modelId === modelId);
  if (!model) throw new Error('Requested model is not currently available with explicit Free billing');
  if (continueReceipt) {
    if (!/^[a-z0-9.-]+\.json$/.test(continueReceipt)) throw new Error('Invalid local evidence receipt name');
    const previous = JSON.parse(await readFile(resolve(evidenceDirectory, continueReceipt), 'utf8'));
    const tool = previous.toolPreflight?.choices?.[0]?.message?.toolCalls?.[0];
    if (previous.modelId !== modelId || previous.toolPreflight?.model !== modelId || !previous.toolExecution?.succeeded || tool?.function.name !== 'read_file') throw new Error('Prior verified native tool execution is required');
    result.continuationOf = continueReceipt;
    result.toolContinuation = await adapter.chat({ model: modelId, system: 'Use the supplied read_file result. The file has already been read. Reply with the actual for-loop condition only, without inventing another file.', messages: [{ role: 'user', content: 'Read src/retry.mjs and report its for-loop condition.' }, previous.toolPreflight.choices[0].message, { role: 'tool', name: 'read_file', toolCallId: tool.id, content: previous.toolExecution.content }], tools: [{ type: 'function', function: { name: 'read_file', description: 'Read a public synthetic fixture file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }], toolChoice: 'none', maxTokens: 256, temperature: 0 });
    result.toolResultUnderstood = /attempt\s*<\s*maxAttempts/.test(result.toolContinuation.choices[0]?.message.content ?? '');
  } else if (!roleQualification && !reviewerOnly) {
    if (!toolOnly) result.preflight = await adapter.chat({ model: modelId, system: 'This is a public synthetic API compatibility evaluation.', messages: [{ role: 'user', content: 'Reply exactly: R73_FREE_OK' }], maxTokens: 64, temperature: 0 });
    result.toolPreflight = await adapter.chat({ model: modelId, system: 'This is a public synthetic tool-calling API compatibility evaluation. You must use the supplied read_file function to inspect src/retry.mjs.', messages: [{ role: 'user', content: 'Inspect src/retry.mjs using read_file. Return the tool call, not an answer.' }], tools: [{ type: 'function', function: { name: 'read_file', description: 'Read a public synthetic fixture file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }], toolChoice: automaticToolChoice ? 'auto' : 'required', maxTokens: 256, temperature: 0 });
    if (executeTool) {
      const tool = result.toolPreflight.choices[0]?.message.toolCalls?.[0];
      const arguments_ = tool && JSON.parse(tool.function.arguments);
      if (tool?.function.name !== 'read_file' || arguments_?.path !== 'src/retry.mjs') throw new Error('Native model tool call did not match the authorized fixture read');
      const fixture = resolve(evidenceDirectory, 'blockrun-tool-fixture');
      await mkdir(resolve(fixture, 'src'), { recursive: true });
      await writeFile(resolve(fixture, 'src/retry.mjs'), 'export async function retry(operation, maxAttempts) {\n  for (let attempt = 0; attempt < maxAttempts; attempt++) {\n    try { return await operation(); } catch (error) { if (attempt + 1 >= maxAttempts) throw error; }\n  }\n}\n');
      const observed = await readFile(resolve(fixture, arguments_.path), 'utf8');
      result.toolExecution = { toolCallId: tool.id, name: tool.function.name, path: arguments_.path, succeeded: true, content: observed, sideEffects: 0 };
      result.toolContinuation = await adapter.chat({ model: modelId, messages: [{ role: 'user', content: 'Read src/retry.mjs using read_file, then state the loop boundary.' }, result.toolPreflight.choices[0].message, { role: 'tool', toolCallId: tool.id, content: observed }], maxTokens: 128, temperature: 0 });
    }
  } else {
    const now = new Date().toISOString();
    const freeModel = { providerId: adapter.providerId, modelId, displayName: model.displayName, tier: 'free', freeStatus: 'verified_free', freeStatusVerifiedAt: now, capabilities: model.capabilities, contextWindow: model.contextWindow, isRemote: true, isCloudHosted: true, accessClass: 'FREE_ROUTED', privacyClass: 'permissive', costProfile: { inputCostPerMillion: 0, outputCostPerMillion: 0, isFree: true, freeTierVerifiedAt: now, paidFallbackPossible: false, paidFallbackDisabled: true, source: 'blockrun:live-free-catalog' }, verificationSource: 'BlockRun explicit zero-price free billing', health: { status: 'available', lastCheckedAt: now } };
    result.receipt = reviewerOnly ? createRoleQualificationReceipt(freeModel, await runRoleQualification(freeModel, adapter, { caseTimeoutMs: 45_000, roles: ['REVIEWER'] }))
      : await runRoleAwareQualification(freeModel, adapter, { caseTimeoutMs: 45_000 });
  }
} catch (error) {
  result.error = { message: String(error), code: error.code, retryable: error.retryable, status: error.status, rateLimitScope: error.rateLimitScope };
}
result.requests = requests;
result.completedAt = new Date().toISOString();
const file = `blockrun-${reviewerOnly ? 'reviewer' : roleQualification ? 'roles' : 'preflight'}-${Date.now()}.json`;
await writeFile(resolve(evidenceDirectory, file), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ file, requests, policy: result.policy?.status, error: result.error, servedModel: result.preflight?.model, toolCalls: result.toolPreflight?.choices?.[0]?.message?.toolCalls, receipt: result.receipt?.qualificationState, roles: result.receipt ? Object.fromEntries(Object.entries(result.receipt.roleResults).map(([role, outcome]) => [role, outcome.status])) : undefined }, null, 2));
