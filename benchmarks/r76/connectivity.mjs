import { lookup } from 'node:dns/promises';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const directory = 'docs/evidence/r76-free-supply-recovery-and-reliability';
const policyFiles = ['kilo', 'blockrun', 'horde'].map(name => `packages/model-registry/src/${name}-policy-reverification.ts`);
const sources = await Promise.all(policyFiles.map(async file => {
  const text = await readFile(file, 'utf8');
  return { file, sha256: createHash('sha256').update(text).digest('hex'), urls: [...text.matchAll(/url: "(https:[^"]+)"/g)].map(match => match[1]) };
}));
const endpoints = [
  'https://api.kilo.ai/api/gateway/models',
  'https://blockrun.ai/api/v1/models',
  'https://aihorde.net/api/v2/status/models?type=text',
  'https://integrate.api.nvidia.com/v1/models',
  'https://openrouter.ai/api/v1/models',
  'https://console.groq.com/docs/rate-limits',
  'https://github.com', 'https://example.com', 'https://www.microsoft.com',
];
const urls = [...new Set([...sources.flatMap(source => source.urls), ...endpoints])];
const hosts = [...new Set(urls.map(url => new URL(url).hostname))];
const failureCode = error => error?.cause?.code ?? error?.code ?? error?.name ?? 'UNKNOWN';
const startedAt = new Date().toISOString();
const dns = await Promise.all(hosts.map(async host => {
  let timer;
  try {
    const addresses = await Promise.race([
      lookup(host, { all: true }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('bounded DNS timeout'), { code: 'DNS_TIMEOUT' })), 10_000); }),
    ]);
    return { host, status: 'RESOLVED', addresses };
  } catch (error) { return { host, status: 'UNAVAILABLE', failureCode: failureCode(error) }; }
  finally { clearTimeout(timer); }
}));
const http = await Promise.all(urls.map(async url => {
  if (!dns.some(row => row.host === new URL(url).hostname && row.status === 'RESOLVED')) return { url, status: 'NOT_ATTEMPTED_DNS_UNAVAILABLE' };
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(12_000), redirect: 'error' });
    const body = await response.text();
    return { url, status: 'HTTP_RESPONSE', httpStatus: response.status, bytes: Buffer.byteLength(body), bodySha256: createHash('sha256').update(body).digest('hex') };
  } catch (error) { return { url, status: 'TRANSPORT_UNAVAILABLE', failureCode: failureCode(error) }; }
}));
const receipt = { startedAt, finishedAt: new Date().toISOString(), evidenceClass: 'HOST_CONNECTIVITY_READ_ONLY_NO_INFERENCE', sources, dns, http, inferenceRequests: 0, inferenceAvailability: 'NOT_PROVEN', policyAdmission: 'UNCHANGED_FAIL_CLOSED' };
await mkdir(directory, { recursive: true });
await writeFile(`${directory}/connectivity.json`, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify(receipt));
