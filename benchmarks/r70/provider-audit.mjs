import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const destination = process.argv[2] ?? 'G:/CodeForge/docs/evidence/r70-free-supply-independence/provider-audit/live-metadata.json';
const report = { startedAt: new Date().toISOString(), kind: 'SUPPLY_PREFLIGHT_NOT_WORKFLOW_PROOF', providers: {} };
async function read(url, key) {
  try {
    const response = await fetch(url, { headers: key ? { Authorization: `Bearer ${key}` } : {}, redirect: 'error', signal: AbortSignal.timeout(20000) });
    return { status: response.status, headers: Object.fromEntries([...response.headers].filter(([name]) => /^(retry-after|x-ratelimit-)/i.test(name))), body: await response.json().catch(() => undefined) };
  } catch (error) { return { status: 'TRANSPORT_FAILURE', errorClass: error.name, causeCode: error.cause?.code }; }
}
const specifications = [
  ['openrouter', 'OPENROUTER_API_KEY', 'https://openrouter.ai/api/v1/models'],
  ['groq', 'GROQ_API_KEY', 'https://api.groq.com/openai/v1/models'],
  ['cerebras', 'CEREBRAS_API_KEY', 'https://api.cerebras.ai/v1/models'],
  ['mistral', 'MISTRAL_API_KEY', 'https://api.mistral.ai/v1/models'],
  ['zai', 'ZAI_API_KEY', 'https://api.z.ai/api/paas/v4/models'],
  ['sambanova', 'SAMBANOVA_API_KEY', 'https://api.sambanova.ai/v1/models'],
  ['huggingface', 'HF_TOKEN', 'https://router.huggingface.co/v1/models'],
  ['opencode', 'OPENCODE_API_KEY', 'https://opencode.ai/zen/v1/models'],
];
for (const [provider, variable, url] of specifications) {
  const key = process.env[variable]?.trim();
  const result = key || ['openrouter', 'opencode'].includes(provider) ? await read(url, key) : { status: 'CREDENTIAL_ABSENT' };
  report.providers[provider] = { credentialPresent: !!key, catalogStatus: result.status, headers: result.headers, errorClass: result.errorClass,
    models: result.body?.data?.map(model => ({ id: model.id, contextWindow: model.context_length ?? model.max_model_len, pricing: model.pricing, parameters: model.supported_parameters })), inferenceCalls: 0 };
  if (provider === 'openrouter' && key) {
    const account = await read('https://openrouter.ai/api/v1/key', key);
    const data = account.body?.data;
    report.providers[provider].account = { status: account.status, isFreeTier: data?.is_free_tier ?? null, ownerPresent: typeof data?.creator_user_id === 'string', organizationPresent: data?.organization_id != null,
      freeRequests: data?.free_model_daily_requests ?? null, usage: data?.usage ?? null, usageDaily: data?.usage_daily ?? null, limit: data?.limit ?? null };
  }
}
const cfKey = process.env.CLOUDFLARE_API_TOKEN?.trim() || process.env.CLOUDFLARE_API_KEY?.trim();
const cfAccount = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
report.providers.cloudflare = { credentialPresent: !!cfKey, accountPresent: !!cfAccount, inferenceCalls: 0, reads: [] };
if (cfKey && /^[a-f0-9]{32}$/i.test(cfAccount ?? '')) {
  for (const suffix of ['/subscriptions', '/entitlements', '/workers/account-settings']) {
    const result = await read(`https://api.cloudflare.com/client/v4/accounts/${cfAccount}${suffix}`, cfKey);
    report.providers.cloudflare.reads.push({ endpoint: `/accounts/<redacted>${suffix}`, status: result.status, success: result.body?.success === true,
      errors: result.body?.errors?.map(error => error.code), planNames: Array.isArray(result.body?.result) ? result.body.result.map(item => item.rate_plan?.public_name).filter(Boolean) : [] });
  }
}
report.providers.gemini = { credentialPresent: !!process.env.GEMINI_API_KEY, inferenceCalls: 0, status: 'BILLING_TIER_UNVERIFIED_NO_INFERENCE' };
const kilo = await read('https://api.kilo.ai/api/gateway/models');
const free = kilo.body?.data?.filter(model => model.pricing?.prompt === '0' && model.pricing?.completion === '0');
report.providers.kilo = { catalogStatus: kilo.status, freeModels: free?.map(model => ({ id: model.id, contextWindow: model.context_length, pricing: model.pricing, parameters: model.supported_parameters })), inferenceCalls: 0, classification: 'PACKAGED_FREE_DIRECT', documentedQuota: 'SOURCE_IP_200_PER_HOUR' };
const model = free?.find(model => model.id === 'kilo-auto/free');
if (model) {
  try {
    const response = await fetch('https://api.kilo.ai/api/gateway/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: model.id, messages: [{ role: 'user', content: 'Reply with OK.' }], max_tokens: 16, stream: false }), redirect: 'error', signal: AbortSignal.timeout(30000) });
    const body = await response.json().catch(() => undefined);
    report.providers.kilo.inferenceCalls = 1;
    report.providers.kilo.inference = { at: new Date().toISOString(), model: model.id, status: response.status, headers: Object.fromEntries([...response.headers].filter(([name]) => /^(retry-after|x-ratelimit-)/i.test(name))),
      errorCode: body?.error?.code, errorType: body?.error?.type, errorMessage: typeof body?.error?.message === 'string' ? body.error.message.replace(/Bearer\s+\S+/gi, 'Bearer <redacted>').slice(0, 300) : undefined,
      success: !!body?.choices?.[0]?.message, usage: body?.usage, servedModel: body?.model };
  } catch (error) { report.providers.kilo.inference = { status: 'TRANSPORT_FAILURE', errorClass: error.name, causeCode: error.cause?.code }; }
}
const horde = await read('https://aihorde.net/api/v2/status/models?type=text');
report.providers.horde = { catalogStatus: horde.status, classification: 'COMMUNITY_ANONYMOUS_FREE', quota: 'GLOBAL_COMMUNITY_WORKERS', models: Array.isArray(horde.body) ? horde.body.map(model => ({ name: model.name, count: model.count, queued: model.queued })) : [], inferenceCalls: 0 };
report.finishedAt = new Date().toISOString();
await mkdir(path.dirname(destination), { recursive: true });
await writeFile(destination, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ destination, providers: Object.fromEntries(Object.entries(report.providers).map(([provider, result]) => [provider, { status: result.catalogStatus ?? result.status, inference: result.inference, account: result.account, credentialPresent: result.credentialPresent }])) }));
