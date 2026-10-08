import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const directory = 'docs/evidence/r72-free-supply-and-autonomy';
await mkdir(directory, { recursive: true });
const report = { startedAt: new Date().toISOString(), kind: 'CATALOG_AND_POLICY_READS_NOT_INFERENCE', providers: {}, documents: [] };
const reads = [
  ['kilo', 'https://api.kilo.ai/api/gateway/models'],
  ['opencode-console', 'https://opencode.ai/inference/v1/models'],
  ['ovhcloud', 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/models'],
  ['openrouter-account', 'https://openrouter.ai/api/v1/key', 'OPENROUTER_API_KEY'],
];
for (const [id, url, variable] of reads) {
  const key = variable ? process.env[variable]?.trim() : undefined;
  if (variable && !key) { report.providers[id] = { status: 'CREDENTIAL_ABSENT' }; continue; }
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'CodeForge/0.4.0 R72 policy research', ...(key ? { Authorization: `Bearer ${key}` } : {}) }, redirect: 'error', signal: AbortSignal.timeout(20_000) });
    const body = await res.json();
    const data = body.data;
    report.providers[id] = { status: res.status, inferenceCalls: 0,
      ...(Array.isArray(data) ? { models: data } : id === 'openrouter-account' && data ? { account: { isFreeTier: data.is_free_tier, organizationPresent: data.organization_id != null, freeRequests: data.free_model_daily_requests, ownerHash: typeof data.creator_user_id === 'string' ? createHash('sha256').update(data.creator_user_id).digest('hex') : null } } : { responseKeys: Object.keys(body) }),
    };
  } catch (e) { report.providers[id] = { status: 'TRANSPORT_FAILURE', name: e.name, causeCode: e.cause?.code }; }
}
for (const [name, url] of [
  ['opencode-inference', 'https://opencode.ai/v2/docs/console/api/inference'],
  ['opencode-terms', 'https://opencode.ai/legal/terms-of-service'],
  ['ovh-getting-started', 'https://docs.ovhcloud.com/en/guides/public-cloud/ai-machine-learning/ai-endpoints-getting-started'],
  ['ovh-free-api', 'https://www.ovhcloud.com/en-ca/public-cloud/free-ai-api/'],
  ['puter-quotas', 'https://docs.puter.com/rate-limits-and-quotas/'],
  ['puter-signin', 'https://docs.puter.com/Auth/signIn/'],
]) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    const body = await res.text();
    await writeFile(`${directory}/${name}.html`, body);
    report.documents.push({ name, url, status: res.status, sha256: createHash('sha256').update(body).digest('hex'), bytes: Buffer.byteLength(body), at: new Date().toISOString() });
  } catch (e) { report.documents.push({ name, url, status: 'TRANSPORT_FAILURE', errorName: e.name, causeCode: e.cause?.code }); }
}
report.finishedAt = new Date().toISOString();
await writeFile(`${directory}/supply-preflight.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ providers: Object.fromEntries(Object.entries(report.providers).map(([id, value]) => [id, { status: value.status, models: value.models?.length, account: value.account }])), documents: report.documents.map(d => ({ name: d.name, status: d.status })) }));
