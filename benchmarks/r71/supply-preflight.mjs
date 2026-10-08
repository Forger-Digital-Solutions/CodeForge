import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const output = path.resolve('docs/evidence/r71-packaged-free-supply-expansion/supply-preflight.json');
const report = { startedAt: new Date().toISOString(), kind: 'READ_ONLY_SUPPLY_PREFLIGHT_NOT_INFERENCE', providers: {} };
async function read(url, key) {
  try {
    const response = await fetch(url, { headers: key ? { Authorization: `Bearer ${key}` } : {}, redirect: 'error', signal: AbortSignal.timeout(15000) });
    return { status: response.status, body: await response.json().catch(() => undefined) };
  } catch (error) { return { status: 'TRANSPORT_FAILURE', errorClass: error.name, causeCode: error.cause?.code }; }
}
for (const [provider, variable, url] of [
  ['openrouter', 'OPENROUTER_API_KEY', 'https://openrouter.ai/api/v1/key'],
  ['groq', 'GROQ_API_KEY', 'https://api.groq.com/openai/v1/models'],
  ['mistral', 'MISTRAL_API_KEY', 'https://api.mistral.ai/v1/models'],
  ['opencode', 'OPENCODE_API_KEY', 'https://opencode.ai/zen/v1/models'],
  ['kilo', '', 'https://api.kilo.ai/api/gateway/models'],
]) {
  const key = variable ? process.env[variable]?.trim() : undefined;
  if (variable && !key && provider !== 'opencode') { report.providers[provider] = { status: 'CREDENTIAL_ABSENT' }; continue; }
  const result = await read(url, key);
  const data = result.body?.data;
  report.providers[provider] = { credentialPresent: !!key, status: result.status, errorClass: result.errorClass, causeCode: result.causeCode, inferenceCalls: 0 };
  if (provider === 'openrouter' && data && !Array.isArray(data)) {
    report.providers[provider].account = { isFreeTier: data.is_free_tier ?? null, ownerPresent: typeof data.creator_user_id === 'string', organizationPresent: data.organization_id != null,
      freeRequests: data.free_model_daily_requests ?? null, expiresAt: data.expires_at ?? null,
      ownerHash: typeof data.creator_user_id === 'string' ? createHash('sha256').update(data.creator_user_id).digest('hex') : undefined };
  } else if (Array.isArray(data)) {
    report.providers[provider].models = data.filter(model => provider !== 'kilo' || (model.pricing?.prompt === '0' && model.pricing?.completion === '0'))
      .map(model => ({ id: model.id, contextWindow: model.context_length, pricing: model.pricing, parameters: model.supported_parameters, supportsTools: model.supports_tools }));
  }
}
report.finishedAt = new Date().toISOString();
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ output, providers: Object.fromEntries(Object.entries(report.providers).map(([provider, result]) => [provider, { status: result.status, account: result.account, models: result.models?.length }])) }));
