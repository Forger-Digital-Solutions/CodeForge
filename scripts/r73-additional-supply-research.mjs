import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const target = resolve('docs/evidence/r73-free-supply-and-completion');
await mkdir(target, { recursive: true });
const sources = [
  ['blockrun-production-authorization', 'https://blockrun.ai/signal/free-llm-api-no-key-models-you-can-curl'],
  ['yolo-auto', 'https://yolo-auto.com/'],
  ['yolo-auto-docs', 'https://yolo-auto.com/docs'],
  ['yolo-auto-terms', 'https://yolo-auto.com/terms'],
  ['yolo-auto-privacy', 'https://yolo-auto.com/privacy'],
  ['hetzner-inference', 'https://docs.hetzner.com/general/company-and-policy/experiments/inference/'],
  ['hetzner-experiments', 'https://docs.hetzner.com/general/company-and-policy/experiments/experiments-platform/'],
];
const observations = await Promise.all(sources.map(async ([name, url]) => {
  const checkedAt = new Date().toISOString();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000), redirect: 'follow' });
    const body = await response.text();
    const file = `${name}.html`;
    await writeFile(resolve(target, file), body);
    return { name, url, finalUrl: response.url, checkedAt, status: response.status, file, bytes: Buffer.byteLength(body) };
  } catch (error) { return { name, url, checkedAt, error: String(error) }; }
}));
await writeFile(resolve(target, 'additional-supply-research.json'), JSON.stringify({ inferenceRequests: 0, observations }, null, 2));
console.log(JSON.stringify(observations.map(({ name, status, error }) => ({ name, status, error })), null, 2));
