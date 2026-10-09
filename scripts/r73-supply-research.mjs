import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const target = resolve('docs/evidence/r73-free-supply-and-completion');
await mkdir(target, { recursive: true });
const sources = [
  ['opencode-console', 'https://opencode.ai/v2/docs/console/api/inference'],
  ['opencode-terms', 'https://opencode.ai/legal/terms-of-service'],
  ['ovh-getting-started', 'https://docs.ovhcloud.com/en/guides/public-cloud/ai-machine-learning/ai-endpoints-getting-started'],
  ['ovh-free-api', 'https://www.ovhcloud.com/en-ca/public-cloud/free-ai-api/'],
  ['murakumo-free', 'https://murakumo.cloud/free'],
  ['murakumo-docs', 'https://murakumo.cloud/docs'],
  ['murakumo-terms', 'https://murakumo.cloud/legal-terms'],
  ['murakumo-privacy', 'https://murakumo.cloud/legal-privacy'],
  ['murakumo-models', 'https://api.murakumo.cloud/v1/models'],
  ['murakumo-ready', 'https://api.murakumo.cloud/ready'],
  ['blockrun-free', 'https://blockrun.ai/free'],
  ['blockrun-terms', 'https://blockrun.ai/terms'],
  ['blockrun-privacy', 'https://blockrun.ai/privacy'],
  ['blockrun-rate-limits', 'https://blockrun.ai/docs/rate-limits'],
  ['blockrun-chat-reference', 'https://blockrun.ai/docs/api-reference/chat-completions'],
  ['blockrun-models', 'https://blockrun.ai/api/v1/models'],
  ['lightning-models', 'https://lightning.ai/models/'],
  ['apifreellm-access', 'https://apifreellm.com/en/api-access'],
  ['apifreellm-docs', 'https://apifreellm.com/en/docs'],
  ['mlvoca-api', 'https://mlvoca.github.io/free-llm-api/'],
  ['boundless-quickstart', 'https://inference.boundless.network/docs/quickstart'],
];
const results = await Promise.all(sources.map(async ([name, url]) => {
  const checkedAt = new Date().toISOString();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(30000), redirect: 'follow' });
    const body = await response.text();
    const contentType = response.headers.get('content-type') ?? '';
    const file = `${name}.${contentType.includes('json') ? 'json' : 'html'}`;
    await writeFile(resolve(target, file), body);
    return { name, url, finalUrl: response.url, checkedAt, status: response.status, contentType, file, bytes: Buffer.byteLength(body) };
  } catch (error) {
    return { name, url, checkedAt, error: String(error), cause: error.cause ? { code: error.cause.code, hostname: error.cause.hostname } : undefined };
  }
}));
await writeFile(resolve(target, 'supply-research.json'), JSON.stringify({ checkedAt: new Date().toISOString(), inferenceRequests: 0, sources: results }, null, 2));
const catalog = results.find((item) => item.name === 'blockrun-models');
if (catalog?.file && catalog.status === 200) {
  const { readFile } = await import('node:fs/promises');
  const models = JSON.parse(await readFile(resolve(target, catalog.file), 'utf8'));
  console.log(JSON.stringify({ blockrunFreeModels: models.data?.filter((model) => model.billing_mode === 'free'), sources: results.map(({name, status, error, cause}) => ({name, status, error, cause})) }, null, 2));
} else console.log(JSON.stringify(results, null, 2));
